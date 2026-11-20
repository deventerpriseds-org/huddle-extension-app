// WHAT:          Pure (no I/O) Trinnex search logic: the search_trinnex tool schema, the data gate (which agents
//                may use it), the question-filter parsers (recency, series, speaker) and source selection.
// WHY:           Tier 1. These decide which of the owner's work passages an agent sees. AC-M7 (only iris-chase and
//                eli-vaughn), AC-M11 (speaker), AC-M12 + spelling table S-C (most recent in a series), AC-M14
//                (honest miss, Trinnex mode only). Pure so the spelling rows are table-tested with no database.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/trinnex-memory.test.ts.

/** The honest-miss line (AC-M14). Trinnex tool ONLY: personal search_memory keeps its silent miss. */
export const TRINNEX_MISS_TEXT = "I couldn't find that in your Trinnex material";
export const TRINNEX_LIBRARY_HINT = "Tell the owner they can add it in the Trinnex Library.";
/** Same relevance floor as personal auto-retrieval (memory-context.server.ts MEMORY_MIN_SCORE). */
export const TRINNEX_MIN_SCORE = 0.3;

export const SEARCH_TRINNEX_TOOL = {
  type: "function" as const,
  name: "search_trinnex",
  description:
    "Search the owner's Trinnex WORK material only (meeting transcripts and uploaded work documents). Use for " +
    "questions about Trinnex meetings, what someone said, decisions, to-dos, or work documents. Returns cited " +
    "passages: cite every claim with its title, date, and speaker + time or page. If it returns status 'miss', say " +
    "exactly that you couldn't find it in the Trinnex material and state no fact. If it returns 'unavailable', say " +
    "Trinnex memory is unavailable right now and do not answer from general knowledge or personal memory. If it " +
    "returns 'ambiguous', ask the owner which one they mean.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "What to look for, in natural language." },
      question: {
        type: "string",
        description: "The owner's question verbatim, so phrases like 'the last', 'before last', 'last week's' are applied exactly.",
      },
      speaker: { type: "string", description: "Only passages spoken by this person (e.g. 'Michael')." },
      series: { type: "string", description: "Meeting series name (e.g. 'Engineering Leaders')." },
      participants: { type: "array", items: { type: "string" }, description: "Only sources with these participants." },
      title: { type: "string", description: "A meeting or document title the owner named (quoted titles go here)." },
      most_recent: { type: "number", description: "Only the N most recent matching meetings/sources." },
      skip_recent: { type: "number", description: "Skip the N most recent first ('before last' = most_recent 1, skip_recent 1)." },
      date_from: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive." },
      date_to: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive." },
    },
    required: ["query"],
  },
  strict: false,
};

/** The data gate: an agent may search Trinnex only if agents.ts marks it `trinnexAccess: true`. */
export function agentHasTrinnexAccess(agent: { trinnexAccess?: boolean } | undefined | null): boolean {
  return agent?.trinnexAccess === true;
}

/**
 * RT-I5: did this turn run search_trinnex? `marked` is the turn flag set by the ONE executor wrapper both dispatch
 * paths call; `toolUses` is the turn's breadcrumb list, which survives a chunked/resumed turn. Either one is
 * enough. When true, the turn's agent replies are NOT copied into personal memory (they may quote work material,
 * and personal scope='global' chunks are auto-retrieved for every agent).
 */
export function turnUsedTrinnex(marked: boolean, toolUses: ReadonlyArray<{ tool?: string | null }> | null | undefined): boolean {
  return marked || (toolUses ?? []).some((t) => t?.tool === SEARCH_TRINNEX_TOOL.name);
}

/** Where a turn runs: the huddle id, its scope ("one-to-one" | "group") and whether it is a ceremony barge. */
export interface TrinnexTurnScope {
  huddleId?: string | null;
  scope?: string | null;
  ceremony?: boolean;
}

/**
 * Verifier loop 1 (session default, the owner may overrule): search_trinnex is offered ONLY in the owner's own 1:1
 * with that agent (huddle `dm-iris-chase` / `dm-eli-vaughn`), never in a group or ceremony huddle, because an
 * answer built from work material would otherwise be read by every agent in the room.
 */
export function trinnexScopeAllows(agentId: string | null | undefined, where: TrinnexTurnScope | null | undefined): boolean {
  if (!agentId || !where || where.ceremony) return false;
  if (where.scope !== "one-to-one") return false;
  return where.huddleId === `dm-${agentId}`;
}

/** The two gates together: the agents.ts data gate AND the 1:1 scope gate. Both dispatch paths use this. */
export function trinnexOfferedHere(
  agent: { id?: string; trinnexAccess?: boolean } | undefined | null,
  where: TrinnexTurnScope | null | undefined,
): boolean {
  return agentHasTrinnexAccess(agent) && trinnexScopeAllows(agent?.id, where);
}

/** The refusal the executor returns when the tool is called outside the 1:1 (defence in depth). */
export const TRINNEX_SCOPE_REFUSAL = "search_trinnex is only available in your 1:1 with Iris or Eli";

export function trinnexToolsFor(agent: { trinnexAccess?: boolean } | undefined | null): unknown[] {
  return agentHasTrinnexAccess(agent) ? [SEARCH_TRINNEX_TOOL] : [];
}

/**
 * The Lovable (AI SDK) fallback path's copy of the SAME gate: `{ search_trinnex: <tool> }` for an agent with
 * `trinnexAccess`, `{}` for every other. `makeTool` builds the SDK tool from the one schema above, so the two
 * dispatch paths can never offer different tools. huddle.functions.ts spreads the result into lovableTools.
 */
export function trinnexLovableToolsFor<T>(
  agent: { trinnexAccess?: boolean } | undefined | null,
  makeTool: (def: typeof SEARCH_TRINNEX_TOOL) => T,
): Record<string, T> {
  return agentHasTrinnexAccess(agent) ? { [SEARCH_TRINNEX_TOOL.name]: makeTool(SEARCH_TRINNEX_TOOL) } : {};
}

// ── recency (spelling table S-C) ─────────────────────────────────────────────────────────────────────

export interface Recency {
  mostRecent?: number;
  skip?: number;
  dateFrom?: string;
  dateTo?: string;
}

/** Upper bound for "the last N meetings" (a runaway number is capped, never an unbounded read). */
export const RECENCY_MAX_N = 50;

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};
const ORDINALS: Record<string, number> = {
  second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5,
};
const numOf = (w: string): number | undefined => {
  const n = /^\d+$/.test(w) ? Number(w) : NUM_WORDS[w];
  return n && n > 0 ? Math.min(n, RECENCY_MAX_N) : undefined;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The owner's CIVIL date (Y, M 0-based, D) for `now` in `timeZone`; an unknown zone falls back to UTC. */
export function civilToday(now: Date, timeZone = "UTC"): { y: number; m: number; d: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const g = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    const y = g("year"), m = g("month"), d = g("day");
    if (y && m && d) return { y, m: m - 1, d };
  } catch {
    /* unknown zone */
  }
  return { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate() };
}
/** A meeting timestamp -> the owner's local calendar day (YYYY-MM-DD). A bare date passes through. */
export function localDay(value: string, timeZone = "UTC"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return value.slice(0, 10);
  const c = civilToday(t, timeZone);
  return isoDay(new Date(Date.UTC(c.y, c.m, c.d)));
}
const day = (y: number, m: number, d: number) => isoDay(new Date(Date.UTC(y, m, d)));

/** Previous calendar week, Monday..Sunday, in the owner's time zone. */
export function previousWeek(now: Date, timeZone = "UTC"): { dateFrom: string; dateTo: string } {
  const c = civilToday(now, timeZone);
  const dow = (new Date(Date.UTC(c.y, c.m, c.d)).getUTCDay() + 6) % 7; // 0 = Monday
  return { dateFrom: day(c.y, c.m, c.d - dow - 7), dateTo: day(c.y, c.m, c.d - dow - 1) };
}
function previousMonth(now: Date, tz: string) {
  const c = civilToday(now, tz);
  return { dateFrom: day(c.y, c.m - 1, 1), dateTo: day(c.y, c.m, 0) };
}
function previousQuarter(now: Date, tz: string) {
  const c = civilToday(now, tz);
  const q0 = c.m - (c.m % 3); // first month of this quarter
  return { dateFrom: day(c.y, q0 - 3, 1), dateTo: day(c.y, q0, 0) };
}
function previousYear(now: Date, tz: string) {
  const c = civilToday(now, tz);
  return { dateFrom: day(c.y - 1, 0, 1), dateTo: day(c.y - 1, 11, 31) };
}
function relativeDay(now: Date, tz: string, offset: number) {
  const c = civilToday(now, tz);
  const d = day(c.y, c.m, c.d + offset);
  return { dateFrom: d, dateTo: d };
}
function pastSpan(now: Date, tz: string, n: number, unit: string) {
  const c = civilToday(now, tz);
  const back = unit.startsWith("day") ? day(c.y, c.m, c.d - n) : unit.startsWith("week") ? day(c.y, c.m, c.d - 7 * n) : day(c.y, c.m - n, c.d);
  return { dateFrom: back, dateTo: day(c.y, c.m, c.d) };
}

type RecencyRule = {
  /** Spelling-table row(s) this rule implements. */
  row: string;
  re: RegExp;
  /** null = the phrase carries NO recency filter (it is semantic). */
  out: (m: RegExpExecArray, now: Date, tz: string) => Recency | null;
};

/**
 * THE recency phrase table (spelling table S-C plus red-team rows RT-S1..S4). Checked in ORDER, first match wins,
 * so the specific phrases sit above the bare "last". Date ranges are calendar periods in the OWNER's time zone
 * (resolveTimeZone: profile zone -> browser zone -> UTC). "The last N" / ordinals count MEETINGS (selectSources).
 */
export const RECENCY_RULES: readonly RecencyRule[] = [
  { row: "S-C6", re: /\blast\s+time\b/, out: () => null },
  { row: "S-C5", re: /\b(?:the\s+one\s+)?before\s+(?:the\s+)?last\b|\bsecond\s+to\s+last\b|\bpenultimate\b/, out: () => ({ mostRecent: 1, skip: 1 }) },
  {
    row: "RT-S2",
    re: /\b(second|third|fourth|fifth|2nd|3rd|4th|5th)\s+(?:most\s+recent|latest|last|newest)\b/,
    out: (m) => ({ mostRecent: 1, skip: ORDINALS[m[1]] - 1 }),
  },
  { row: "S-C3", re: /\b(?:last|previous|prior)\s+week'?s?\b/, out: (_m, n, tz) => previousWeek(n, tz) },
  { row: "RT-S4 month", re: /\b(?:last|previous|prior)\s+month'?s?\b/, out: (_m, n, tz) => previousMonth(n, tz) },
  { row: "RT-S4 quarter", re: /\b(?:last|previous|prior)\s+quarter'?s?\b/, out: (_m, n, tz) => previousQuarter(n, tz) },
  { row: "RT-S4 year", re: /\b(?:last|previous|prior)\s+year'?s?\b/, out: (_m, n, tz) => previousYear(n, tz) },
  { row: "RT-S4 yesterday", re: /\byesterday'?s?\b/, out: (_m, n, tz) => relativeDay(n, tz, -1) },
  {
    row: "RT-S4 span",
    re: /\b(?:last|past|previous)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s+(days?|weeks?|months?)\b/,
    out: (m, n, tz) => pastSpan(n, tz, numOf(m[1]) ?? 1, m[2]),
  },
  {
    row: "S-C4 / RT-S3",
    re: /\b(?:last|latest|most\s+recent|previous|past)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b/,
    out: (m) => ({ mostRecent: numOf(m[1]) ?? 1 }),
  },
  // RT-S1: "the previous <series> meeting" applies recency. AS SHIPPED it is the most recent one (= "the last");
  // the alternative reading "the one before the latest" is ONE edit here: ({ mostRecent: 1, skip: 1 }).
  // Only when it qualifies a meeting word within a few words ("the previous Engineering Leaders meeting"), so
  // "prior to the launch" or "previous decisions" stay plain semantic questions.
  {
    row: "RT-S1",
    re: /\b(?:previous|prior)\s+(?:[\w'&-]+\s+){0,4}?(?:meetings?|syncs?|calls?|sessions?|standups?|1on1s?|1:1s?|check-?ins?|reviews?|one)\b/,
    out: () => ({ mostRecent: 1 }),
  },
  { row: "S-C1 S-C2 S-C7 S-C10", re: /\b(?:last|latest|most\s+recent|newest)\b/, out: () => ({ mostRecent: 1 }) },
];

/**
 * Read a recency instruction out of the owner's phrasing. Returns null when the question carries none.
 * Quoted text is removed first: `the "Last Mile" review` is a TITLE, not recency (S-C11).
 */
export function recencyFromQuestion(question: string | undefined | null, now = new Date(), timeZone = "UTC"): Recency | null {
  if (!question) return null;
  const q = question.replace(/["“”][^"“”]*["“”]/g, " ").replace(/’/g, "'").toLowerCase();
  for (const r of RECENCY_RULES) {
    const m = r.re.exec(q);
    if (m) return r.out(m, now, timeZone);
  }
  return null;
}

// ── series + speaker resolution ──────────────────────────────────────────────────────────────────────

export type Resolved = { kind: "match"; value: string } | { kind: "ambiguous"; options: string[] } | { kind: "none" };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const tokens = (s: string) => norm(s).split(" ").filter(Boolean);

/** Series: exact (case-insensitive), else a unique token-prefix match ("Eng Leaders" -> "Engineering Leaders"). */
export function resolveSeries(input: string, known: string[]): Resolved {
  const uniq = [...new Map(known.filter(Boolean).map((k) => [norm(k), k])).values()];
  const exact = uniq.find((k) => norm(k) === norm(input));
  if (exact) return { kind: "match", value: exact };
  const stripped = norm(input).replace(/\s+(meeting|meetings|sync|syncs)$/, "");
  const exact2 = uniq.find((k) => norm(k) === stripped);
  if (exact2) return { kind: "match", value: exact2 };
  const it = tokens(stripped);
  const hits = uniq.filter((k) => {
    const kt = tokens(k);
    return it.length > 0 && it.length <= kt.length && it.every((t, i) => kt[i].startsWith(t));
  });
  if (hits.length === 1) return { kind: "match", value: hits[0] };
  if (hits.length > 1) return { kind: "ambiguous", options: hits };
  return { kind: "none" };
}

/** Speaker: exact full name, else a unique first-name match. Two Michaels -> ambiguous (AC-M11, S-B7). */
export function resolveSpeaker(input: string, known: string[]): Resolved {
  const uniq = [...new Map(known.filter(Boolean).map((k) => [norm(k), k])).values()];
  const exact = uniq.find((k) => norm(k) === norm(input));
  if (exact) return { kind: "match", value: exact };
  const first = tokens(input)[0] ?? "";
  const hits = uniq.filter((k) => (tokens(k)[0] ?? "").replace(/[.,]$/, "") === first);
  if (hits.length === 1) return { kind: "match", value: hits[0] };
  if (hits.length > 1) return { kind: "ambiguous", options: hits };
  return { kind: "none" };
}

// ── source selection ────────────────────────────────────────────────────────────────────────────────

export interface CatalogEntry {
  source: string;
  title: string | null;
  firefliesTitle?: string | null;
  date: string | null;
  series: string | null;
  participants: string[];
  speakers: string[];
}

export interface SourceFilters {
  speaker?: string;
  series?: string;
  participants?: string[];
  title?: string;
  mostRecent?: number;
  skip?: number;
  dateFrom?: string;
  dateTo?: string;
  /** What "the last N" counts. Default "meeting" (RT-S5: S-C7 "the last meeting" never picks a newer upload). */
  recencyKind?: "meeting" | "upload" | "any";
  /** The owner's zone for date ranges: a meeting at 22:00 local on Sunday belongs to Sunday (RT-S4). */
  timeZone?: string;
}

/** A catalog source's kind, from its key (`trinnex:meeting:<id>` / `trinnex:upload:<id>`). */
export function sourceKindOf(source: string): "meeting" | "upload" | "other" {
  return source.startsWith("trinnex:meeting:") ? "meeting" : source.startsWith("trinnex:upload:") ? "upload" : "other";
}

export type Selection =
  | { kind: "all" }
  | { kind: "sources"; sources: string[]; speaker?: string }
  | { kind: "ambiguous"; field: "series" | "speaker"; options: string[] }
  | { kind: "none"; reason: string };

/**
 * Which sources a question may draw from. `all` = no source filter. Recency ALWAYS selects whole sources
 * (one meeting = max(date), never "the last 3 mixed", AC-M12).
 */
export function selectSources(catalog: CatalogEntry[], f: SourceFilters): Selection {
  let pool = catalog;
  let speaker: string | undefined;
  let filtered = false;
  if (f.series) {
    const r = resolveSeries(f.series, catalog.map((c) => c.series ?? ""));
    if (r.kind === "ambiguous") return { kind: "ambiguous", field: "series", options: r.options };
    if (r.kind === "none") return { kind: "none", reason: "no_such_series" };
    pool = pool.filter((c) => c.series && norm(c.series) === norm(r.value));
    filtered = true;
  }
  if (f.speaker) {
    const r = resolveSpeaker(f.speaker, pool.flatMap((c) => c.speakers));
    if (r.kind === "ambiguous") return { kind: "ambiguous", field: "speaker", options: r.options };
    if (r.kind === "none") return { kind: "none", reason: "no_such_speaker" };
    speaker = r.value;
    pool = pool.filter((c) => c.speakers.some((s) => norm(s) === norm(r.value)));
    filtered = true;
  }
  if (f.participants && f.participants.length > 0) {
    const want = f.participants.map(norm);
    pool = pool.filter((c) => want.every((w) => c.participants.some((p) => norm(p) === w || tokens(p)[0] === w)));
    filtered = true;
  }
  if (f.title) {
    const t = norm(f.title);
    pool = pool.filter((c) => [c.title, c.firefliesTitle].some((x) => x && norm(x).includes(t)));
    filtered = true;
  }
  const tz = f.timeZone || "UTC";
  if (f.dateFrom) {
    pool = pool.filter((c) => c.date && localDay(c.date, tz) >= f.dateFrom!);
    filtered = true;
  }
  if (f.dateTo) {
    pool = pool.filter((c) => c.date && localDay(c.date, tz) <= f.dateTo!);
    filtered = true;
  }
  if (f.mostRecent && f.mostRecent > 0) {
    // Recency counts MEETINGS unless asked otherwise (RT-S5): an upload dated later is not "the last meeting".
    const kind = f.recencyKind ?? "meeting";
    const ofKind = kind === "any" ? pool : pool.filter((c) => sourceKindOf(c.source) === kind);
    const sorted = ofKind
      .filter((c) => c.date)
      .sort((a, b) => (b.date! < a.date! ? -1 : b.date! > a.date! ? 1 : 0));
    pool = sorted.slice(f.skip ?? 0, (f.skip ?? 0) + Math.floor(f.mostRecent));
    filtered = true;
  }
  if (!filtered) return { kind: "all" };
  if (pool.length === 0) return { kind: "none", reason: "no_matching_source" };
  return { kind: "sources", sources: pool.map((c) => c.source), speaker };
}
