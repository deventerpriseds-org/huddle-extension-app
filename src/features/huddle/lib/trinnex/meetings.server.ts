// WHAT:       Server side of the Trinnex MEETINGS module: list meetings, open one (speakers from the stored transcript,
//             title + invite suggestions, its action items), save triage (title, series, participants, speaker map,
//             owners, optional file rename, optional Trinnex ingest), and the owner's people list.
// WHY:        AC-trinnex-workspace.md section 1. EXTENDS chat.fireflies_meetings (columns added in
//             minutes-store.server.ts) and the EXISTING triage path (actOnProposal "triage"), with no new database,
//             secret or parallel triage endpoint.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-meetings.md; scripts/trinnex-meetings.test.ts (pure rules).
//
// Logs carry ids, counts and error CODES only: never a title, a name or transcript text (AC-C4).
import type { Pool } from "pg";
import { getSharedPool } from "../db/shared-pool.server";
import { ensureMinutesSchema } from "../fireflies/minutes-store.server";
import { normName, suggestNames, type NameSuggestion } from "./names";
import { factsFailReason, factsFailureNotice } from "./library-core";
import {
  canRemovePerson,
  cleanPersonName,
  cleanSeries,
  cleanSpeakerMap,
  fullTitle,
  matchNamedFiles,
  oneDriveFileName,
  ownerPickToTriage,
  participantsWithSpeakers,
  peopleList,
  segmentsFor,
  seriesOptions,
  speakerRows,
  validateTitle,
  type SpeakerRow,
  type StoredSentence,
} from "./meeting-triage-core";

type Caller = { entra_object_id?: string; entra_email?: string } | undefined;

const pool = (): Pool => getSharedPool();
const code = (e: unknown, fb: string) => {
  const m = e instanceof Error ? e.message : "";
  return /^[a-z][a-z0-9_:.-]{0,59}$/.test(m) ? m : fb;
};

async function scope(caller: Caller): Promise<{ owners: string[]; ownerName: string } | null> {
  const { callerOwners } = await import("../proposals/proposals.server");
  const owners = await callerOwners(caller);
  if (!owners?.length) return null;
  return { owners: owners.map((o) => o.toLowerCase()), ownerName: ownerDisplayName(owners[0]) };
}

/** Pure: "first.last@x" -> "First" (the owner's pinned name in the picker). */
export function ownerDisplayName(email: string): string {
  const first = String(email ?? "").split("@")[0].split(/[._-]/)[0] ?? "";
  return first ? first[0].toUpperCase() + first.slice(1).toLowerCase() : "Me";
}

// ── People list (AC-T14, AC-T15) ────────────────────────────────────────────────────────────────────

async function storedPeople(owners: string[]): Promise<string[]> {
  await ensureMinutesSchema();
  const r = await pool().query<{ name: string }>(
    `SELECT name FROM chat.trinnex_people WHERE owner_email = ANY($1::text[]) ORDER BY created_at, name`,
    [owners],
  );
  return r.rows.map((x) => x.name);
}

export async function getPeople(caller: Caller): Promise<{ ok: true; owner: string; people: string[] } | { ok: false; error: string }> {
  const s = await scope(caller);
  if (!s) return { ok: false, error: "Sign-in required." };
  return { ok: true, owner: s.ownerName, people: peopleList(s.ownerName, await storedPeople(s.owners)) };
}

export async function addPerson(caller: Caller, raw: unknown): Promise<{ ok: true; name: string; people: string[] } | { ok: false; error: string }> {
  const s = await scope(caller);
  if (!s) return { ok: false, error: "Sign-in required." };
  const name = cleanPersonName(raw);
  if (!name) return { ok: false, error: "Type a name." };
  if (normName(name) !== normName(s.ownerName)) {
    await ensureMinutesSchema();
    // Case-insensitive dedup by key: the FIRST spelling stays (AC-T14).
    await pool().query(
      `INSERT INTO chat.trinnex_people (owner_email, name_key, name) VALUES ($1, $2, $3) ON CONFLICT (owner_email, name_key) DO NOTHING`,
      [s.owners[0], normName(name), name],
    );
  }
  const people = peopleList(s.ownerName, await storedPeople(s.owners));
  return { ok: true, name: people.find((p) => normName(p) === normName(name)) ?? name, people };
}

/**
 * The Library's write path into the SAME list (one people list, AC-L5/AC-T14): every participant or speaker name
 * the owner tags on an upload is added exactly as addPerson adds it (cleaned, case-insensitive dedup, owner never
 * stored). Never fails the caller's save.
 */
export async function rememberPeople(caller: Caller, names: readonly unknown[]): Promise<void> {
  const s = await scope(caller).catch(() => null);
  if (!s) return;
  const seen = new Set<string>([normName(s.ownerName)]);
  const rows: Array<[string, string]> = [];
  for (const raw of names) {
    const name = cleanPersonName(raw);
    if (!name || seen.has(normName(name))) continue;
    seen.add(normName(name));
    rows.push([normName(name), name]);
  }
  if (!rows.length) return;
  try {
    await ensureMinutesSchema();
    for (const [key, name] of rows) {
      await pool().query(
        `INSERT INTO chat.trinnex_people (owner_email, name_key, name) VALUES ($1, $2, $3) ON CONFLICT (owner_email, name_key) DO NOTHING`,
        [s.owners[0], key, name],
      );
    }
  } catch (e) {
    console.error("[trinnex-meetings] remember people failed", code(e, "people_write_failed"));
  }
}

/** AC-T15: the owner is never removable; existing meetings and items keep the name (nothing else is touched). */
export async function removePerson(caller: Caller, raw: unknown): Promise<{ ok: true; people: string[] } | { ok: false; error: string }> {
  const s = await scope(caller);
  if (!s) return { ok: false, error: "Sign-in required." };
  const name = cleanPersonName(raw);
  if (!name) return { ok: false, error: "Type a name." };
  if (!canRemovePerson(s.ownerName, name)) return { ok: false, error: "You can't remove yourself." };
  await ensureMinutesSchema();
  await pool().query(`DELETE FROM chat.trinnex_people WHERE owner_email = ANY($1::text[]) AND name_key = $2`, [s.owners, normName(name)]);
  return { ok: true, people: peopleList(s.ownerName, await storedPeople(s.owners)) };
}

// ── Meetings ────────────────────────────────────────────────────────────────────────────────────────

export interface MeetingListItem {
  meetingId: string;
  title: string;
  firefliesTitle: string | null;
  /** The descriptive name from the owner's named transcript file, when one matches (named-files.server). */
  fileTitle: string | null;
  meetingAt: string | null;
  series: string | null;
  participants: string[];
  triaged: boolean;
  trinnexState: string | null;
  /** AC-C5: "Facts not extracted: AI quota exhausted" (or the kind) when the passages went in without facts. */
  factsNotice: string | null;
}

interface MeetingDbRow {
  meeting_id: string;
  title: string | null;
  display_title: string | null;
  series: string | null;
  participants: string[] | null;
  speaker_map: Record<string, string> | null;
  meeting_at: string | Date | null;
  triaged_at: string | Date | null;
  title_with_participants: boolean;
  onedrive_path: string | null;
  onedrive_file_name: string | null;
  trinnex_state: string | null;
  trinnex_error?: string | null;
}

const iso = (v: string | Date | null) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
/** The descriptive name from the owner's named transcript file, by meeting id (named-files.server; fail-soft). */
async function fileTitles(rows: readonly MeetingDbRow[]): Promise<Map<string, string>> {
  const { listNamedTranscriptFiles } = await import("./named-files.server");
  const files = await listNamedTranscriptFiles();
  if (!files.length) return new Map();
  return matchNamedFiles(rows.map((r) => ({ id: r.meeting_id, title: r.title, meetingAt: iso(r.meeting_at) })), files);
}

// The owner's own title wins; then the name from the transcript file; then Fireflies' (usually date-only) title.
const listItem = (r: MeetingDbRow, fileTitle?: string | null): MeetingListItem => {
  const base = r.display_title || fileTitle || r.title || "Untitled meeting";
  return {
    meetingId: r.meeting_id,
    title: fullTitle(base, r.participants ?? [], !!r.title_with_participants),
    firefliesTitle: r.title,
    fileTitle: fileTitle ?? null,
    meetingAt: iso(r.meeting_at),
    series: r.series,
    participants: r.participants ?? [],
    triaged: !!r.triaged_at,
    trinnexState: r.trinnex_state,
    factsNotice: factsFailureNotice(r.trinnex_error),
  };
};

const COLS = `meeting_id, title, display_title, series, participants, speaker_map, meeting_at, triaged_at,
  title_with_participants, onedrive_path, onedrive_file_name, trinnex_state, trinnex_error`;

export async function listMeetings(caller: Caller): Promise<
  { ok: true; owner: string; people: string[]; series: string[]; meetings: MeetingListItem[] } | { ok: false; error: string }
> {
  const s = await scope(caller);
  if (!s) return { ok: false, error: "Sign-in required." };
  await ensureMinutesSchema();
  const r = await pool().query<MeetingDbRow>(
    `SELECT ${COLS} FROM chat.fireflies_meetings WHERE owner_email = ANY($1::text[])
      ORDER BY COALESCE(meeting_at, created_at) DESC LIMIT 100`,
    [s.owners],
  );
  return {
    ok: true,
    owner: s.ownerName,
    people: peopleList(s.ownerName, await storedPeople(s.owners)),
    series: seriesOptions(r.rows.map((x) => x.series)),
    meetings: await fileTitles(r.rows).then((t) => r.rows.map((row) => listItem(row, t.get(row.meeting_id)))),
  };
}

async function loadSentences(owners: string[], meetingId: string): Promise<{ sentences: StoredSentence[]; attendees: string[] }> {
  const r = await pool().query<{ content: { sentences?: StoredSentence[]; attendees?: Array<{ name?: string | null }>; participants?: string[] } | null }>(
    `SELECT content FROM chat.correspondence_ledger WHERE source = 'transcript' AND source_item_id = $1
        AND owner_email = ANY($2::text[]) LIMIT 1`,
    [meetingId, owners],
  ).catch(() => ({ rows: [] as Array<{ content: null }> }));
  const c = r.rows[0]?.content;
  const sentences = Array.isArray(c?.sentences) ? c.sentences : [];
  const attendees = (Array.isArray(c?.attendees) ? c.attendees.map((a) => a?.name ?? "") : []).map((n) => cleanPersonName(n)).filter((n): n is string => !!n);
  return { sentences, attendees };
}

export interface MeetingDetail {
  meeting: MeetingListItem & { baseTitle: string; withParticipants: boolean; speakerMap: Record<string, string>; onedrivePath: string | null; fileName: string | null };
  speakers: SpeakerRow[];
  titleSuggestions: NameSuggestion[];
  inviteSuggestions: string[];
  items: Array<{ id: string; title: string; state: string; assignee: string | null }>;
}

export async function getMeeting(caller: Caller, meetingId: string): Promise<({ ok: true } & MeetingDetail) | { ok: false; error: string }> {
  const s = await scope(caller);
  if (!s) return { ok: false, error: "Sign-in required." };
  await ensureMinutesSchema();
  const r = await pool().query<MeetingDbRow>(`SELECT ${COLS} FROM chat.fireflies_meetings WHERE meeting_id = $1 AND owner_email = ANY($2::text[])`, [
    meetingId,
    s.owners,
  ]);
  const row = r.rows[0];
  if (!row) return { ok: false, error: "That meeting isn't in your list." };
  const people = peopleList(s.ownerName, await storedPeople(s.owners));
  const ctx = { people, owner: s.ownerName };
  const { sentences, attendees } = await loadSentences(s.owners, meetingId);
  const participants = row.participants ?? [];
  const fileTitle = (await fileTitles([row])).get(row.meeting_id) ?? null;
  // Names come from the file's descriptive name when there is one ("Alex Sync ..."); the date-only title has none.
  const titleSuggestions = suggestNames(fileTitle ?? row.title ?? "", ctx).filter((n) => !participants.some((p) => normName(p) === normName(n.name)));
  const inviteSuggestions = attendees.filter(
    (a) => normName(a) !== normName(s.ownerName) && normName(a).split(" ")[0] !== normName(s.ownerName) &&
      !participants.some((p) => normName(p) === normName(a)) && !titleSuggestions.some((t) => normName(t.name) === normName(a)),
  );
  const { pgProposalStore } = await import("../proposals/proposals-store.server");
  const queue = await pgProposalStore.listMeetingQueue(s.owners).catch(() => []);
  const items = queue
    .filter((q) => q.meetingId === meetingId && q.state !== "dismissed")
    .map((q) => ({ id: q.id, title: q.title, state: q.state, assignee: q.state === "delegated" ? q.assignee : null }));
  return {
    ok: true,
    meeting: {
      ...listItem(row, fileTitle),
      baseTitle: row.display_title || fileTitle || row.title || "",
      withParticipants: !!row.title_with_participants,
      speakerMap: row.speaker_map ?? {},
      onedrivePath: row.onedrive_path,
      fileName: row.onedrive_path ? row.onedrive_path.split("/").pop() ?? null : null,
    },
    speakers: speakerRows(sentences, ctx),
    titleSuggestions,
    inviteSuggestions,
    items,
  };
}

export interface SaveInput {
  meetingId: string;
  title: unknown;
  series: unknown;
  participants: unknown[];
  withParticipants: boolean;
  renameFile: boolean;
  speakerMap: unknown;
  /** Item id -> pick. Items left out stay untriaged ("saved without one", AC-T17). */
  owners: Record<string, { kind: "person"; name: string } | { kind: "skip" }>;
  addToMemory: boolean;
}

export interface SaveResult {
  ok: true;
  title: string;
  notes: string[];
  /** "ingested" | "not_configured" | "failed" | "skipped" */
  memory: string;
  fileRenamed: boolean | null;
}

/** AC-T1..T17 save. The triage fields are written FIRST; the owner picks, the rename and the Trinnex ingest follow
 *  and each can fail without failing the save (AC-T9, brief step 7). */
export async function saveMeeting(caller: Caller, input: SaveInput): Promise<SaveResult | { ok: false; error: string }> {
  const s = await scope(caller);
  if (!s) return { ok: false, error: "Sign-in required." };
  const vt = validateTitle(input.title);
  if (!vt.ok) return { ok: false, error: vt.error };
  await ensureMinutesSchema();
  const cur = await pool().query<MeetingDbRow>(`SELECT ${COLS} FROM chat.fireflies_meetings WHERE meeting_id = $1 AND owner_email = ANY($2::text[])`, [
    input.meetingId,
    s.owners,
  ]);
  const row = cur.rows[0];
  if (!row) return { ok: false, error: "That meeting isn't in your list." };
  const { sentences } = await loadSentences(s.owners, input.meetingId);
  const labels = speakerRows(sentences, { people: [], owner: s.ownerName }).map((x) => x.label);
  const speakerMap = cleanSpeakerMap(input.speakerMap, labels);
  const typed = (Array.isArray(input.participants) ? input.participants : [])
    .map((p) => cleanPersonName(p))
    .filter((p): p is string => !!p && normName(p) !== normName(s.ownerName));
  const participants = participantsWithSpeakers([...new Map(typed.map((p) => [normName(p), p])).values()], speakerMap, s.ownerName);
  const series = cleanSeries(input.series);
  const title = vt.title;
  const notes: string[] = [];

  // 1. The triage fields. `title` (the Fireflies original) is NEVER written here (AC-T1/T2).
  await pool().query(
    `UPDATE chat.fireflies_meetings SET display_title = $2, series = $3, participants = $4, speaker_map = $5::jsonb,
        title_with_participants = $6, triaged_at = now(), trinnex_state = CASE WHEN $7 THEN 'queued' ELSE trinnex_state END,
        updated_at = now()
      WHERE meeting_id = $1 AND owner_email = ANY($8::text[])`,
    [input.meetingId, title, series, participants, JSON.stringify(speakerMap), !!input.withParticipants, !!input.addToMemory, s.owners],
  );

  // 2. Owners, through the EXISTING triage (same targets, same store, AC-T12/T13; decision Q4).
  const { actOnProposal } = await import("../proposals/proposals.server");
  let unowned = 0;
  for (const [id, pick] of Object.entries(input.owners ?? {})) {
    if (!/^prop-[0-9a-f]{1,32}$/.test(id)) continue;
    const c = ownerPickToTriage(pick, s.ownerName);
    const r = await actOnProposal(caller, id, "triage", undefined, c, { from: "actions" }).catch(() => ({ ok: false as const, error: "triage_failed" }));
    if (!r.ok) unowned++;
  }
  if (unowned) notes.push(`${unowned} item${unowned === 1 ? "" : "s"} not updated; they stay in the queue.`);

  // 3. Optional OneDrive rename (AC-T7..T9): a MOVE; on failure the old path stays and the owner is told why.
  const shown = fullTitle(title, participants, !!input.withParticipants);
  let fileRenamed: boolean | null = null;
  if (input.renameFile) {
    const name = oneDriveFileName(iso(row.meeting_at), shown);
    try {
      const { renameTranscriptFile } = await import("../fireflies/fireflies.server");
      const path = await renameTranscriptFile(input.meetingId, row.onedrive_path, name);
      await pool().query(`UPDATE chat.fireflies_meetings SET onedrive_path = $2, onedrive_file_name = $3, updated_at = now() WHERE meeting_id = $1`, [
        input.meetingId,
        path,
        path.split("/").pop(),
      ]);
      fileRenamed = true;
    } catch (e) {
      fileRenamed = false;
      const c = code(e, "onedrive_rename_failed");
      console.error("[trinnex-meetings] rename failed", c);
      notes.push(`File name not changed (${c}).`);
    }
  }

  // 4. Trinnex memory (brief step 7, section 10). Never fails the save.
  let memory = "skipped";
  let factsError: string | null = null;
  let ingestKind: string | null = null;
  if (input.addToMemory) {
    const mem = await import("./memory.server");
    if (!mem.trinnexConfigured()) {
      memory = "not_configured";
      notes.push("Trinnex memory is not set up yet.");
    } else {
      try {
        // AC-M4 / RT-I4: each passage keeps the ORIGINAL speaker label next to the mapped person.
        const segments = segmentsFor(sentences, speakerMap).map((x) => ({
          text: x.text,
          speaker: x.speaker,
          speakerLabel: x.speakerLabel,
          at: x.at,
        }));
        const r = await mem.ingestTrinnexSource({
          sourceId: input.meetingId,
          sourceKind: "meeting",
          title: shown,
          firefliesTitle: row.title ?? null, // AC-M4: the title as Fireflies sent it (S-C8 fallback)
          date: iso(row.meeting_at),
          series,
          participants,
          segments,
          ownerEmail: s.owners[0], // AC-C7: the same resolved email the library rows and search_trinnex use
        });
        memory = "ingested";
        // AC-C5: passages stored; a fact-extraction failure is recorded by KIND and shown on the meeting.
        if (r.factsFailure) {
          factsError = factsFailReason(r.factsFailure);
          const n = factsFailureNotice(factsError);
          if (n) notes.push(`${n}.`);
        }
        console.log("[trinnex-meetings] ingested", input.meetingId, r.chunks, r.facts);
      } catch (e) {
        memory = "failed";
        // AC-C5 (verifier loop 1): an embedding failure carries its KIND (TrinnexEmbedError.kind, already sent to
        // the ai-quota alert by the memory lane); record it on the meeting instead of a bare "ingest_failed".
        const k = (e as { kind?: unknown })?.kind;
        if (typeof k === "string" && /^[a-z0-9_ ]{1,64}$/i.test(k)) ingestKind = k;
        console.error("[trinnex-meetings] ingest failed", ingestKind ?? code(e, "ingest_failed"));
        notes.push(
          ingestKind === "no_api_key"
            ? "Saved, but not added to Trinnex memory: the AI key is not set."
            : /insufficient_quota/.test(ingestKind ?? "")
              ? "Saved, but not added to Trinnex memory: AI quota exhausted. Try again later."
              : "Saved, but adding it to Trinnex memory failed. Try again later.",
        );
      }
    }
    await pool()
      .query(`UPDATE chat.fireflies_meetings SET trinnex_state = $2, trinnex_error = $3, updated_at = now() WHERE meeting_id = $1`, [
        input.meetingId,
        memory,
        memory === "failed" ? (ingestKind ? `ingest_failed:${ingestKind}` : "ingest_failed") : factsError,
      ])
      .catch(() => {});
  }
  return { ok: true, title: shown, notes, memory, fileRenamed };
}
