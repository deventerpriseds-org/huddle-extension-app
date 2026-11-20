// WHAT:       Pure core of the Trinnex MEETINGS module: title / series validation, the participants suffix, the
//             OneDrive file name, the people list (Von pinned first), the owner pick -> today's triage choice, the
//             per-voice speaker rows, and the transcript -> Trinnex segments builder.
// WHY:        AC-trinnex-workspace.md section 1 (AC-T1..T19). Pure so every rule is table-tested offline.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/trinnex-meetings.test.ts; docs/qc-evidence/BUILD-trinnex-meetings.md.
//
// THIS REPO IS PUBLIC: no names or content here. Dependency-light (no pg, no fetch, no React).
import { cleanTriageName, type TriageChoice } from "../proposals/meeting-triage";
import { matchSpeaker, normName, speakerKey, type NameContext, type SpeakerMatch } from "./names";

/** AC-T3: the prototype's maxlength. */
export const MEETING_TITLE_MAX = 120;
/** AC-T4. */
export const SERIES_MAX = 80;
/** The embed input cap (lib/rag/embed.server.ts truncates at 8000): a segment stays well under it. */
export const SEGMENT_MAX_CHARS = 6000;

const collapse = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();

/** Pure (AC-T3): empty / whitespace refused; capped at 120 chars. */
export function validateTitle(raw: unknown): { ok: true; title: string } | { ok: false; error: string } {
  const s = typeof raw === "string" ? collapse(raw) : "";
  if (!s) return { ok: false, error: "A meeting needs a title." };
  return { ok: true, title: Array.from(s).slice(0, MEETING_TITLE_MAX).join("").trim() };
}

/** Pure (AC-T4): blank -> null (never ""), capped at 80 chars. */
export function cleanSeries(raw: unknown): string | null {
  const s = typeof raw === "string" ? collapse(raw) : "";
  return s ? Array.from(s).slice(0, SERIES_MAX).join("").trim() : null;
}

/** Pure (AC-T4): the series offered in the datalist: distinct (case-insensitive), first spelling kept, sorted. */
export function seriesOptions(values: ReadonlyArray<string | null | undefined>): string[] {
  const by = new Map<string, string>();
  for (const v of values) {
    const s = cleanSeries(v);
    if (s && !by.has(s.toLowerCase())) by.set(s.toLowerCase(), s);
  }
  return [...by.values()].sort((a, b) => a.localeCompare(b));
}

/** Pure (AC-T6): the displayed title. The stored title is ALWAYS the base, so two saves never double the suffix. */
export function fullTitle(base: string, participants: readonly string[], withParticipants: boolean): string {
  return withParticipants && participants.length ? `${base} - ${participants.join(", ")}` : base;
}

/** Pure (AC-T7): "<YYYY-MM-DD> <full title>.md", `: ` -> ` - `, `\ / * ? " < > |` -> `-`. */
export function oneDriveFileName(meetingAt: string | null, title: string): string {
  const d = meetingAt && /^\d{4}-\d{2}-\d{2}/.test(meetingAt) ? meetingAt.slice(0, 10) : null;
  const base = (d ? `${d} ${title}` : title).replace(/\s*:\s*/g, " - ").replace(/[\\/*?"<>|]/g, "-");
  return `${collapse(base).slice(0, 200)}.md`;
}

// ── People list (AC-T12..T15) ───────────────────────────────────────────────────────────────────────

/** Pure (AC-T14): a typed name, cleaned by the SAME rule as meeting triage's typed name. */
export const cleanPersonName = cleanTriageName;

/** Pure (AC-T12/T15): the owner first and pinned, then the stored names (case-insensitive dedup, owner removed). */
export function peopleList(owner: string, stored: readonly string[]): string[] {
  const out = [owner];
  const seen = new Set([normName(owner)]);
  for (const raw of stored) {
    const n = cleanPersonName(raw);
    if (!n || seen.has(normName(n))) continue;
    seen.add(normName(n));
    out.push(n);
  }
  return out;
}

/** Pure (AC-T15): the owner can never be removed. */
export function canRemovePerson(owner: string, name: string): boolean {
  return normName(name) !== normName(owner);
}

/** Pure (AC-T12, decision Q4): an owner pick -> today's triage choice. The owner -> Mine (stores exactly what Mine
 *  stores today); a person -> For someone with that exact list spelling; "skip" -> Skip. */
export function ownerPickToTriage(
  pick: { kind: "person"; name: string } | { kind: "skip" },
  owner: string,
): { choice: TriageChoice; name?: string } {
  if (pick.kind === "skip") return { choice: "skip" };
  if (normName(pick.name) === normName(owner)) return { choice: "mine" };
  return { choice: "someone", name: pick.name };
}

// ── Speakers (AC-T10, AC-T11; S-B) ──────────────────────────────────────────────────────────────────

export interface StoredSentence {
  speaker?: unknown;
  text?: unknown;
  start?: unknown;
  end?: unknown;
}

const secs = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Pure: seconds -> "mm:ss" (or "h:mm:ss"). */
export function stamp(s: number | null): string | null {
  if (s == null) return null;
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

export interface SpeakerRow {
  label: string;
  lines: number;
  /** Share of all words, 0..100, rounded. */
  talkPct: number;
  sample: { text: string; at: string | null } | null;
  match: SpeakerMatch;
}

/** Pure (AC-T10): one row per distinct label, in first-spoken order. */
export function speakerRows(sentences: readonly StoredSentence[], ctx: NameContext): SpeakerRow[] {
  const by = new Map<string, { lines: number; words: number; sample: SpeakerRow["sample"] }>();
  let total = 0;
  for (const s of sentences) {
    const label = speakerKey(s.speaker);
    const text = typeof s.text === "string" ? collapse(s.text) : "";
    const words = text ? text.split(" ").length : 0;
    total += words;
    const r = by.get(label) ?? { lines: 0, words: 0, sample: null };
    r.lines++;
    r.words += words;
    // The sample is the first line of at least 4 words (or the first line at all).
    if (text && (!r.sample || (r.sample.text.split(" ").length < 4 && words >= 4))) r.sample = { text: text.slice(0, 200), at: stamp(secs(s.start)) };
    by.set(label, r);
  }
  return [...by.entries()].map(([label, r]) => ({
    label,
    lines: r.lines,
    talkPct: total ? Math.round((r.words / total) * 100) : 0,
    sample: r.sample,
    match: matchSpeaker(label === "Unknown speaker" ? "" : label, ctx),
  }));
}

/** Pure (AC-T10): labels mapped to the same person (the "Fireflies sometimes splits one person" warning). */
export function splitWarnings(map: Readonly<Record<string, string | null | undefined>>): string[] {
  const count = new Map<string, number>();
  for (const v of Object.values(map)) if (v) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count.entries()].filter(([, n]) => n > 1).map(([p]) => p);
}

/** Pure (AC-T10): mapping a voice adds that person to participants (never the owner, never twice). */
export function participantsWithSpeakers(participants: readonly string[], map: Readonly<Record<string, string | null | undefined>>, owner: string): string[] {
  const out = [...participants];
  const seen = new Set(out.map(normName));
  for (const v of Object.values(map)) {
    if (!v || normName(v) === normName(owner) || seen.has(normName(v))) continue;
    seen.add(normName(v));
    out.push(v);
  }
  return out;
}

/** Pure (AC-T11, measured: every real label is "Speaker N"): transcript -> Trinnex segments. Consecutive lines of
 *  one voice form one passage (under SEGMENT_MAX_CHARS). `speaker` is the MAPPED person, or the literal label when
 *  the voice is unmapped -- never a guess. `at` is the first line's start ("mm:ss"). */
export function segmentsFor(
  sentences: readonly StoredSentence[],
  map: Readonly<Record<string, string | null | undefined>>,
): Array<{ text: string; speaker: string; speakerLabel: string; at: string | null }> {
  const out: Array<{ text: string; speaker: string; speakerLabel: string; at: string | null }> = [];
  for (const s of sentences) {
    const text = typeof s.text === "string" ? collapse(s.text) : "";
    if (!text) continue;
    const label = speakerKey(s.speaker);
    const speaker = map[label] || label;
    const last = out[out.length - 1];
    if (last && last.speakerLabel === label && last.text.length + 1 + text.length <= SEGMENT_MAX_CHARS) {
      last.text += ` ${text}`;
      continue;
    }
    // A single over-long line is split into pieces, never truncated (no text is lost).
    for (let i = 0; i < text.length; i += SEGMENT_MAX_CHARS) {
      out.push({ text: text.slice(i, i + SEGMENT_MAX_CHARS), speaker, speakerLabel: label, at: stamp(secs(s.start)) });
    }
  }
  return out;
}

/** Pure: a client speaker map -> only known labels, values cleaned; an empty value means unmapped. */
export function cleanSpeakerMap(raw: unknown, labels: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  const ok = new Set(labels);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ok.has(k)) continue;
    const n = cleanPersonName(v);
    if (n) out[k] = n;
  }
  return out;
}
