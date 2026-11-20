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

export function trinnexToolsFor(agent: { trinnexAccess?: boolean } | undefined | null): unknown[] {
  return agentHasTrinnexAccess(agent) ? [SEARCH_TRINNEX_TOOL] : [];
}

// ── recency (spelling table S-C) ─────────────────────────────────────────────────────────────────────

export interface Recency {
  mostRecent?: number;
  skip?: number;
  dateFrom?: string;
  dateTo?: string;
}

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 };

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Previous calendar week, Monday..Sunday, in UTC (owner-TZ is a known limitation). */
export function previousWeek(now: Date): { dateFrom: string; dateTo: string } {
  const day = (now.getUTCDay() + 6) % 7; // 0 = Monday
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
  const lastMonday = new Date(thisMonday.getTime() - 7 * 86400_000);
  const lastSunday = new Date(thisMonday.getTime() - 86400_000);
  return { dateFrom: isoDay(lastMonday), dateTo: isoDay(lastSunday) };
}

/**
 * Read a recency instruction out of the owner's phrasing. Returns null when the question carries none.
 * Quoted text is removed first: `the "Last Mile" review` is a TITLE, not recency (S-C11).
 */
export function recencyFromQuestion(question: string | undefined | null, now = new Date()): Recency | null {
  if (!question) return null;
  const q = question.replace(/["“”][^"“”]*["“”]/g, " ").toLowerCase();
  if (/\blast\s+time\b/.test(q)) return null; // S-C6: semantic, not a series/recency filter
  if (/\bbefore\s+last\b/.test(q)) return { mostRecent: 1, skip: 1 }; // S-C5
  if (/\blast\s+week'?s?\b/.test(q)) return previousWeek(now); // S-C3
  const n = /\b(?:last|latest|most\s+recent)\s+(one|two|three|four|five|[1-5])\b/.exec(q); // S-C4
  if (n) return { mostRecent: NUM[n[1]] };
  if (/\b(?:last|latest|most\s+recent)\b/.test(q)) return { mostRecent: 1 }; // S-C1, S-C2, S-C7, S-C10
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
  if (f.dateFrom) {
    pool = pool.filter((c) => c.date && c.date.slice(0, 10) >= f.dateFrom!);
    filtered = true;
  }
  if (f.dateTo) {
    pool = pool.filter((c) => c.date && c.date.slice(0, 10) <= f.dateTo!);
    filtered = true;
  }
  if (f.mostRecent && f.mostRecent > 0) {
    const sorted = pool.filter((c) => c.date).sort((a, b) => (b.date! < a.date! ? -1 : b.date! > a.date! ? 1 : 0));
    pool = sorted.slice(f.skip ?? 0, (f.skip ?? 0) + Math.floor(f.mostRecent));
    filtered = true;
  }
  if (!filtered) return { kind: "all" };
  if (pool.length === 0) return { kind: "none", reason: "no_matching_source" };
  return { kind: "sources", sources: pool.map((c) => c.source), speaker };
}
