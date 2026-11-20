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

/** Shown as the owner's row while the people list is still loading, so "Mine" stays one tap away. */
export const OWNER_FALLBACK_LABEL = "Me";

/**
 * AC-T13: what a pick in the chat checklist / Actions > Meetings owner picker sends. EXACTLY the shape those
 * surfaces sent from the typed box before (decision Q4): the owner -> { choice: "mine" } with no name, so the
 * stored row is today's Mine; anyone else -> { choice: "someone", name } capped at 80 chars as before.
 */
export function triageForPick(name: string, owner: string | null): { choice: TriageChoice; name?: string } {
  if (owner === null || normName(owner) === "") {
    return name === OWNER_FALLBACK_LABEL ? { choice: "mine" } : { choice: "someone", name: name.slice(0, 80) };
  }
  const t = ownerPickToTriage({ kind: "person", name }, owner);
  return t.choice === "someone" ? { choice: "someone", name: (t.name ?? name).slice(0, 80) } : { choice: t.choice };
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
  /** Up to CLUE_MAX lines that best help the owner tell who this is, in spoken order (speakerClues). */
  clues: SpeakerClue[];
  match: SpeakerMatch;
}

/** One identifying line: what this speaker said, and what the previous speaker said just before it. */
export interface SpeakerClue {
  at: string | null;
  text: string;
  before: { label: string; text: string } | null;
  /** Why it was picked: an introduction, someone calling on them by name, or simply a long stretch of talk. */
  why: "intro" | "called-on" | "long";
}

export const CLUE_MAX = 5;
const CLUE_CHARS = 320;
const BEFORE_CHARS = 180;
// "I'm Casey", "this is Alex", "my name is ...", "Casey here". Not "it's X": real transcript 2026-11-20 had "it's Acme Corp".
const INTRO = /\b(?:[Ii]'?m|[Ii] am|[Tt]his is|[Mm]y name is)\s+(?!(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)\b)[A-Z][a-z]+|(?:^|[.?!]\s+)[A-Z][a-z]+ here\b/;
// The previous speaker hands over: "Casey, go ahead", "over to you, Alex", "Taylor?", "thanks, Morgan".
const CALLED_ON = /\b(?:[Gg]o ahead|[Oo]ver to you|[Tt]ake it away|[Yy]our turn|[Yy]ou're up|[Ff]loor is yours)\b|\b(?:hand|pass|punt|turn)(?: it| things)?(?: off| over)? to [A-Z][a-z]+|\bover to [A-Z][a-z]+|,\s*[A-Z][a-z]+[?.!]?\s*$|\b(?:[Tt]hanks|[Tt]hank you|[Hh]ey|[Hh]i),?\s+(?!(?:[Ee]veryone|[Aa]ll|[Gg]uys|[Tt]eam|[Ff]olks)\b)[A-Z][a-z]+\b/;
const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/**
 * Pure (UAT 2026-11-20: "I'm unable to see enough text to determine who is speaking"). Groups the transcript into
 * turns (consecutive lines by one label) and picks, per label, up to CLUE_MAX turns that best identify the
 * speaker: introductions first, then turns where the previous speaker called on someone, then the longest
 * turns. Each clue carries the previous speaker's last line, because that is often where the name is said.
 */
export function speakerClues(sentences: readonly StoredSentence[]): Map<string, SpeakerClue[]> {
  const rows = sentences
    .map((s, i) => ({ i, label: speakerKey(s.speaker), text: typeof s.text === "string" ? collapse(s.text) : "", start: secs(s.start) }))
    .filter((r) => r.text);
  rows.sort((a, b) => (a.start != null && b.start != null && a.start !== b.start ? a.start - b.start : a.i - b.i));
  type Turn = { label: string; text: string; start: number | null; before: { label: string; text: string } | null; order: number };
  const turns: Turn[] = [];
  for (const r of rows) {
    const last = turns[turns.length - 1];
    if (last && last.label === r.label) last.text += ` ${r.text}`;
    else {
      const prev = last ? { label: last.label, text: last.text } : null;
      turns.push({ label: r.label, text: r.text, start: r.start, before: prev, order: turns.length });
    }
  }
  const by = new Map<string, Array<Turn & { why: SpeakerClue["why"]; score: number }>>();
  for (const t of turns) {
    const words = t.text.split(" ").length;
    const intro = INTRO.test(t.text.slice(0, 160));
    const called = !!t.before && CALLED_ON.test(t.before.text.slice(-BEFORE_CHARS));
    const why: SpeakerClue["why"] = intro ? "intro" : called ? "called-on" : "long";
    const score = (intro ? 1000 : 0) + (called ? 500 : 0) + Math.min(words, 60);
    const list = by.get(t.label) ?? [];
    list.push({ ...t, why, score });
    by.set(t.label, list);
  }
  const out = new Map<string, SpeakerClue[]>();
  for (const [label, list] of by) {
    const picked = [...list].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, CLUE_MAX);
    picked.sort((a, b) => a.order - b.order);
    out.set(
      label,
      picked.map((t) => ({
        at: stamp(t.start),
        text: cut(t.text, CLUE_CHARS),
        before: t.before ? { label: t.before.label, text: cut(t.before.text.length > BEFORE_CHARS ? `…${t.before.text.slice(-BEFORE_CHARS)}` : t.before.text, BEFORE_CHARS + 1) } : null,
        why: t.why,
      })),
    );
  }
  return out;
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
  const clues = speakerClues(sentences);
  return [...by.entries()].map(([label, r]) => ({
    label,
    lines: r.lines,
    talkPct: total ? Math.round((r.words / total) * 100) : 0,
    sample: r.sample,
    clues: clues.get(label) ?? [],
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
    // RT-N4: OWN keys only. `map["constructor"]` on a plain object is Object.prototype.constructor, a function.
    const mapped = Object.prototype.hasOwnProperty.call(map, label) ? map[label] : undefined;
    const speaker = typeof mapped === "string" && mapped ? mapped : label;
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
  // RT-N4: no prototype, so a label like "constructor" or "__proto__" is an ordinary key.
  const out: Record<string, string> = Object.create(null);
  if (!raw || typeof raw !== "object") return out;
  const ok = new Set(labels);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ok.has(k)) continue;
    const n = cleanPersonName(v);
    if (n) out[k] = n;
  }
  return out;
}

// ── Named transcript files (owner, 2026-11-20) ───────────────────────────────────────────────────────────
// Fireflies' own title is only a date stamp ("Nov 10, 09:37 AM"), but the transcript files in the owner's OneDrive
// folder carry the real name: "Nov 10- 09-37 AM-Weekly planning sync.md". Run 44734811029: 28 of 28 files have
// that shape. These pure helpers pair a meeting with its file by the shared stamp.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Pure: "Nov 10, 09:37 AM" -> "nov 10 09:37 am"; null when the title is not a bare Fireflies date stamp. */
export function stampKeyFromTitle(title: unknown): string | null {
  const m = typeof title === "string" ? /^\s*([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{1,2}):(\d{2}) ([AP])M\s*$/i.exec(title) : null;
  if (!m || !MONTHS.includes(m[1].toLowerCase())) return null;
  return `${m[1].toLowerCase()} ${Number(m[2])} ${m[3].padStart(2, "0")}:${m[4]} ${m[5].toLowerCase()}m`;
}

/** Pure: "Nov 10- 09-37 AM-Weekly planning sync.md" -> { key: "nov 10 09:37 am", name: "Weekly planning sync" }. */
export function parseNamedFile(fileName: unknown): { key: string; name: string } | null {
  const base = typeof fileName === "string" ? fileName.trim().replace(/\.(?:md|txt|docx|pdf|vtt|srt)$/i, "") : "";
  const m = /^([A-Za-z]{3})[a-z]* (\d{1,2})-\s*(\d{1,2})-(\d{2}) ([AP])M\s*-\s*(.+)$/i.exec(base);
  if (!m || !MONTHS.includes(m[1].toLowerCase())) return null;
  const name = collapse(m[6]).replace(/[-_\s]+$/, "").slice(0, MEETING_TITLE_MAX);
  if (!name) return null;
  return { key: `${m[1].toLowerCase()} ${Number(m[2])} ${m[3].padStart(2, "0")}:${m[4]} ${m[5].toLowerCase()}m`, name };
}

/** How far a file's created time may sit from the meeting before the stamp match is not trusted (the stamp has no year). */
export const NAMED_FILE_WINDOW_MS = 14 * 24 * 3600 * 1000;

/**
 * Pure: meetingId -> the descriptive name from its file. A meeting matches a file only by the exact stamp, and only
 * when the file was created within NAMED_FILE_WINDOW_MS of the meeting (when a time is known). When several files
 * share a stamp the closest in time wins; a file is used for one meeting at most.
 */
export function matchNamedFiles(
  meetings: ReadonlyArray<{ id: string; title: string | null; meetingAt: string | null }>,
  files: ReadonlyArray<{ name: string; createdAt?: string | null }>,
): Map<string, string> {
  const byKey = new Map<string, Array<{ name: string; at: number | null; used: boolean }>>();
  for (const f of files) {
    const p = parseNamedFile(f.name);
    if (!p) continue;
    const at = f.createdAt ? Date.parse(f.createdAt) : NaN;
    const list = byKey.get(p.key) ?? [];
    list.push({ name: p.name, at: Number.isFinite(at) ? at : null, used: false });
    byKey.set(p.key, list);
  }
  const out = new Map<string, string>();
  for (const m of meetings) {
    const key = stampKeyFromTitle(m.title);
    const list = key ? byKey.get(key) : undefined;
    if (!list) continue;
    const mAt = m.meetingAt ? Date.parse(m.meetingAt) : NaN;
    const ranked = list
      .filter((f) => !f.used)
      .map((f) => ({ f, d: Number.isFinite(mAt) && f.at != null ? Math.abs(f.at - mAt) : 0 }))
      .filter((x) => x.d <= NAMED_FILE_WINDOW_MS)
      .sort((a, b) => a.d - b.d);
    if (!ranked.length) continue;
    ranked[0].f.used = true;
    out.set(m.id, ranked[0].f.name);
  }
  return out;
}
