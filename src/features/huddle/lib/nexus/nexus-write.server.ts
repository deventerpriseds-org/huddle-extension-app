// WHAT:       The ONE Nexus WRITE path a Huddle agent has: `write_nexus_assignments`, which adds or
//             updates the owner's DATED, GRADED coursework deliverables in Nexus (content.assignments).
//             In the shared tool pool for EVERY agent; Elle and Iris are made the PRIME responders by
//             routing DATA (agents.ts capability), not by gating this tool.
// WHY:        Huddle's Nexus bridge was read-only by construction (nexus.server.ts), so "add my MGT-782
//             assignments from the syllabus" had no route at all, and the owner added the MGT-782
//             deliverables by a one-off workflow INSERT. The owner also deleted a "Residency 4"
//             assignment row by hand because a MEETING was mis-filed as a deliverable -- so this tool
//             refuses meetings/sessions and undated items itself, rather than trusting the model.
// SUPERSEDES: nothing. The read module stays read-only; this is a separate module with its own
//             single outbound call site (`nexusWriteFetch`), reusing the read module's base-URL and
//             configured-owner helpers so neither has two definitions.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   nexus-hub docs/cross-app-agent/AC-syllabus-deliverables-write-tool.md Part B + its
//             RESOLUTIONS (OQ-9: auth is W1, the existing X-UAT-Token; OQ-10: the owner is Huddle's
//             server-held NEXUS_OWNER_ID). Contract read from nexus-hub origin/main a3683ab:
//             api/src/functions/d1.ts:400-412 (writable columns), :1199-1300 (POST/PATCH),
//             api/src/lib/auth.ts:131-137 (UAT owner = ?owner=), api/src/lib/preimage.ts:152-177
//             (X-Agent-Tool makes the insert undoable; PATCH always logs a pre-image).
//             Proved offline by scripts/nexus-write-tool.test.ts (npm run test:nexus-write).
//
// IDENTITY. The owner a write lands under is `NEXUS_OWNER_ID` from SERVER config, applied with
// `searchParams.set("owner", …)` AFTER everything else, exactly like the read path. The tool schema
// has no identity-shaped property, and the executor reads ONLY whitelisted keys from each item, so a
// model that passes `owner`/`user_id`/`email` anyway has it dropped before anything leaves Huddle.

import { nexusBase, nexusOwner, nexusGet, TIMEOUT_MS } from "./nexus.server";
import { NEXUS_WRITE_TOOL_NAME, nexusWriteOutcomeStatement, type ItemResult } from "./nexus-write-shared";

export { NEXUS_WRITE_TOOL_NAME, enforceNexusWriteHonesty, nexusWriteOutcomeStatement } from "./nexus-write-shared";
export type { ItemResult } from "./nexus-write-shared";

/** Batch cap (AC-F2-23). Over it, NOTHING is written. */
export const NEXUS_WRITE_MAX_BATCH = 25;
/** Course-local zone when the document states none (OQ-7 default; no per-course zone column exists). */
export const DEFAULT_COURSE_TZ = "America/New_York";

type Row = Record<string, unknown>;

/** The W1 credential: the org's UAT_BYPASS_TOKEN, the same secret Nexus's api-deploy.yml syncs. */
function uatToken(): string {
  return (process.env.UAT_BYPASS_TOKEN ?? "").trim();
}

/**
 * All THREE must be present (AC-F2-30). A half-configured environment shows the model no write
 * tool at all -- a tool it can see but whose every call fails is worse than none. Deliberately
 * independent of the read gate: with only the token missing, the twelve read tools stay.
 */
export function nexusWriteConfigured(): boolean {
  return !!nexusBase() && !!nexusOwner() && !!uatToken();
}

export const WRITE_NEXUS_ASSIGNMENTS_TOOL = {
  type: "function" as const,
  name: NEXUS_WRITE_TOOL_NAME,
  description:
    "ADD or UPDATE the owner's coursework ASSIGNMENTS in Nexus (his EMBA/DBA coursework system) -- the dated, graded deliverables of a course: papers, proposals, essays, case briefs, projects, exams. Use when he asks to add/log/put/update/change/fix an assignment, a deliverable, a paper or its due date, or to add a syllabus's deadlines. This is NOT a board task: do not also call create_huddle_task unless he asks for a reminder or card as well. RULES: (1) Only DATED deliverables -- pass due_date as YYYY-MM-DD (or a full ISO datetime with its offset). If the date is missing, relative ('Week 5') or has no year, do NOT guess: ask him. (2) Meetings, residencies, seminars, class sessions, office hours and participation are NOT assignments -- they belong on the class schedule; this tool refuses them. (3) Name the course by its CODE as he says it (e.g. 'MGT-782') or its exact name. (4) To UPDATE, pass assignment_id from get_nexus_assignments plus ONLY the fields that change. (5) Read each result's `persisted` and `action` and report exactly that: persisted:true = saved; action 'duplicate' = it was already there, nothing new added; 'rejected'/'failed' = NOT saved, say so plainly; persisted:'unknown' = it timed out and MAY have landed -- check with get_nexus_assignments before saying anything about it.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        description: `One entry per assignment to add or update (max ${NEXUS_WRITE_MAX_BATCH}).`,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            assignment_id: {
              type: "string",
              description: "UPDATE an existing assignment (id from get_nexus_assignments). Omit to ADD a new one.",
            },
            course: {
              type: "string",
              description: "ADD: the course code as the owner says it ('MGT-782', 'mgt 782') or the course's exact name. Required to add.",
            },
            title: { type: "string", description: "The deliverable's title, e.g. 'Research Proposal'. Required to add." },
            due_date: {
              type: "string",
              description: "YYYY-MM-DD, or a full ISO datetime WITH offset (2026-10-30T23:59:00-07:00). Never 'Week 5', never a date without a year.",
            },
            due_time: {
              type: "string",
              description: "Optional HH:MM (24h) local due time when due_date is a plain date. Omit if the document gives none (23:59:59 is assumed and flagged).",
            },
            time_zone: {
              type: "string",
              description: `Optional IANA zone the document states the time in (e.g. 'America/Los_Angeles' for PT). Default ${DEFAULT_COURSE_TZ}.`,
            },
            description: {
              type: "string",
              description: "Optional. Carry any course policy or weight text VERBATIM (e.g. 'AI Writing tools are not permitted…', '20% of the grade').",
            },
            points: {
              type: "integer",
              description: "Optional. Real POINTS only. A percentage weight is NOT points -- put it in description instead.",
            },
            priority: { type: "string", enum: ["low", "medium", "high"], description: "Optional." },
          },
        },
      },
    },
    required: ["items"] as string[],
  },
  strict: false,
};

/** The write tool, or none at all when not fully configured. Kept apart from nexusReadTools(). */
export function nexusWriteTools(): unknown[] {
  return nexusWriteConfigured() ? [WRITE_NEXUS_ASSIGNMENTS_TOOL] : [];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Normalisers -- SPELLED IDENTICALLY to Nexus's own, because they cannot be imported across repos.
// normTitle = nexus-hub api/src/shared/canvasIngest.ts:128; normCode = api/src/shared/courseLink.ts:46.
// If either changes on the Nexus side, change it here in the same breath (see the build log's gaps).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export const normTitle = (s: string | null | undefined) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const normCode = (s: string | null | undefined) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DATES. A real tz database (Intl), never a month-of-year heuristic: nexus-hub extractSchedule.ts
// `parseTimeToISO` decides DST by `month >= 2 && month <= 9`, which stores 2026-03-07 23:59 ET one
// hour early. Mutation-proved by RG-3 in the test file.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** UTC offset of `tz` at instant `utcMs`, in ms (positive east of Greenwich). */
function zoneOffsetMs(tz: string, utcMs: number): number {
  const base = Math.floor(utcMs / 1000) * 1000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(base));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - base;
}

/**
 * Wall-clock time in `tz` → the UTC instant (ms), right on both sides of a DST switch.
 *   - an OVERLAP (fall back: the wall time happens twice) -> the FIRST occurrence;
 *   - a GAP (spring forward: the wall time never happens) -> moved FORWARD by the gap, i.e. 02:30
 *     on a spring-forward night is 03:30 daylight time (Temporal's "compatible"). A deadline is
 *     never moved earlier (W13: this used to return 01:30 standard time, an hour early).
 */
export function zonedLocalToUtcMs(
  y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const t1 = guess - zoneOffsetMs(tz, guess);
  const t2 = guess - zoneOffsetMs(tz, t1);
  const cands = [...new Set([t1, t2])];
  const exact = cands.filter((t) => t + zoneOffsetMs(tz, t) === guess);
  return exact.length ? Math.min(...exact) : Math.max(...cands);
}

/** True when the wall-clock time does not exist in `tz` (a spring-forward gap). */
function isNonexistentLocal(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): boolean {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const t = zonedLocalToUtcMs(y, mo, d, h, mi, s, tz);
  return t + zoneOffsetMs(tz, t) !== guess;
}

/**
 * US time-zone ABBREVIATIONS a syllabus writes ("11:59 pm EST") -> the region they mean (W9). `EST`
 * and `MST` ARE valid IANA names -- fixed UTC-5 / UTC-7 -- which is exactly why "EST" on an October
 * deadline used to be stored an hour late: syllabi write EST for Eastern time all year. `MST`/`MT`
 * are refused instead (Arizona keeps MST all year, Denver does not; the tool cannot know which), so
 * the agent asks.
 */
const ZONE_ALIASES: Record<string, string | null> = {
  est: "America/New_York", edt: "America/New_York", et: "America/New_York", eastern: "America/New_York",
  cst: "America/Chicago", cdt: "America/Chicago", ct: "America/Chicago", central: "America/Chicago",
  pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pt: "America/Los_Angeles", pacific: "America/Los_Angeles",
  mdt: "America/Denver", mountain: "America/Denver",
  mst: null, mt: null,
};
export function resolveZone(raw: string): { ok: true; zone: string } | { ok: false; detail: string } {
  const key = raw.trim().toLowerCase().replace(/\./g, "").replace(/\s+time$/, "");
  if (Object.prototype.hasOwnProperty.call(ZONE_ALIASES, key)) {
    const z = ZONE_ALIASES[key];
    return z
      ? { ok: true, zone: z }
      : { ok: false, detail: `time zone "${raw}" is ambiguous (Arizona keeps MST all year, Denver does not) -- ask which: America/Phoenix or America/Denver` };
  }
  return isValidZone(raw.trim()) ? { ok: true, zone: raw.trim() } : { ok: false, detail: `unknown time zone "${raw}"` };
}

function validYmd(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

export type DueResolution =
  | { ok: true; iso: string; ms: number; timeAssumed: boolean; zone: string; timeShifted?: boolean }
  | { ok: false; reason: "undated" | "ambiguous-date"; detail: string };

/**
 * THE dated-only predicate (AC-F2-10/12/13). One function; both ADD and UPDATE call it.
 *   - missing / null / "" / "TBD"            → undated
 *   - "Week 5", "Oct 30", "10/30", "next Fri" → ambiguous-date (no year is ever supplied from the clock)
 *   - "YYYY-MM-DD" [+ due_time] [+ time_zone] → that wall-clock time in the course zone (default ET)
 *   - ISO datetime WITH offset / Z            → that instant, offset honoured
 */
export function resolveDueInstant(
  dueDate: unknown, dueTime?: unknown, timeZone?: unknown,
): DueResolution {
  if (dueDate === undefined || dueDate === null) return { ok: false, reason: "undated", detail: "no due date given" };
  if (typeof dueDate !== "string") return { ok: false, reason: "ambiguous-date", detail: `unreadable due date ${JSON.stringify(dueDate)}` };
  const raw = dueDate.trim();
  if (!raw || /^(tbd|tba|n\/?a|none|unknown|pending|undated|-+)$/i.test(raw)) {
    return { ok: false, reason: "undated", detail: raw ? `"${raw}" is not a date` : "empty due date" };
  }
  let zone = DEFAULT_COURSE_TZ;
  if (typeof timeZone === "string" && timeZone.trim()) {
    const z = resolveZone(timeZone);
    if (!z.ok) return { ok: false, reason: "ambiguous-date", detail: z.detail };
    zone = z.zone;
  }

  // Full ISO instant with an explicit offset: honour the offset, ignore time_zone.
  let m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.exec(raw);
  if (m) {
    if (!validYmd(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) return { ok: false, reason: "ambiguous-date", detail: `"${raw}" is not a real date` };
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return { ok: false, reason: "ambiguous-date", detail: `"${raw}" is not a real date` };
    return { ok: true, iso: isoZ(ms), ms, timeAssumed: false, zone: m[7].toUpperCase() === "Z" ? "UTC" : m[7] };
  }

  let y: number, mo: number, d: number, h: number, mi: number, s: number;
  let timeAssumed = false;
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (m) {
    [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) {
      return { ok: false, reason: "ambiguous-date", detail: `"${raw}" is not a full date with a year (YYYY-MM-DD) -- ask the owner` };
    }
    [y, mo, d] = [+m[1], +m[2], +m[3]];
    const tRaw = typeof dueTime === "string" ? dueTime.trim() : "";
    if (tRaw) {
      const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(tRaw);
      if (!tm) return { ok: false, reason: "ambiguous-date", detail: `due_time "${tRaw}" is not HH:MM` };
      [h, mi, s] = [+tm[1], +tm[2], +(tm[3] ?? 0)];
    } else {
      // OQ-4 default: end of day, course-local, matching the two live MGT-782 rows. FLAGGED.
      [h, mi, s] = [23, 59, 59];
      timeAssumed = true;
    }
  }
  if (!validYmd(y, mo, d) || h > 23 || mi > 59 || s > 59) {
    return { ok: false, reason: "ambiguous-date", detail: `"${raw}" is not a real date/time` };
  }
  const ms = zonedLocalToUtcMs(y, mo, d, h, mi, s, zone);
  const timeShifted = isNonexistentLocal(y, mo, d, h, mi, s, zone) || undefined;
  return { ok: true, iso: isoZ(ms), ms, timeAssumed, zone, timeShifted };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS NOT AN ASSIGNMENT (AC-F2-11, OQ-11, AC-F1-20..23). An assignment is a GRADED DELIVERABLE
// WITH A DATE. Never one: a meeting / session / residency / class / call / appointment / office
// hours / review session, a holiday or break, an administrative date, or a reading. The refusal
// REASON goes back to the agent so the owner can rephrase to override.
//
// W4 (docs/FIX-nexus-write-redteam.md): "a deliverable noun wins" was too blunt -- "Residency 4:
// present your research proposal" (the shape of the row the owner deleted by hand) carries the noun
// "proposal" but IS a residency. So the HEAD of the title decides: the part before the first ":" /
// spaced dash / "(" names the thing itself. A head that ENDS in a session word ("Midterm exam review
// session", "Presentation at Residency 4", "Class 5") or names a session followed by what it is ABOUT
// ("Kickoff meeting for final project") is a session, whatever deliverable nouns follow. A head that
// names a deliverable still wins ("Residency 4 reflection paper", "Seminar paper", "Paper due at
// Residency 4").
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const DELIVERABLE_NOUN =
  /\b(papers?|proposals?|essays?|reports?|assignments?|submissions?|projects?|briefs?|memos?|deliverables?|drafts?|thesis|dissertation|case (?:study|analysis|write-?up)|reflections?|exams?|quiz(?:zes)?|midterms?|homework|problem sets?|portfolios?|bibliograph(?:y|ies)|literature review|write-?ups?|posts?|responses?|presentations?|critiques?)\b/i;
const MEETING_WORD_SRC =
  "residenc(?:y|ies)|seminars?|sessions?|zoom|webex|class meetings?|meetings?|orientation|office hours?|check-?points?|check-?ins?|lectures?|webinars?|workshops?|kick-?offs?|attendance|participation|live class(?:es)?|synchronous|immersion|colloqui(?:um|a)|class(?:es)?|appointments?|advising|guest speakers?|speaker series|study groups?|(?:live|coaching|conference|zoom|teams|video|phone|group|cohort|advising|team|weekly) calls?";
const MEETING_WORD = new RegExp(`\\b(?:${MEETING_WORD_SRC})\\b`, "i");
/** The head ENDS in a session word (a trailing number/ordinal ignored): "Class 5", "Week 3 class". */
const HEAD_ENDS_IN_MEETING = new RegExp(`\\b(?:${MEETING_WORD_SRC})(?:\\s*#?\\d+[a-z]?)?\\s*$`, "i");
/** A session word followed by what it is ABOUT: "meeting for the final project", "session on the case". */
const MEETING_ABOUT = new RegExp(
  `\\b(?:${MEETING_WORD_SRC})(?:\\s*#?\\d+)?\\s+(?:for|about|on|re|regarding|covering|to discuss|with)\\b`,
  "i",
);
/** A deliverable that is DUE at a session: "Paper due at Residency 4" is the paper, not the residency. */
const DUE_PHRASE = new RegExp(`${DELIVERABLE_NOUN.source}[^:]*\\b(?:due|submit(?:ted)?|turn(?:ed)? in|upload(?:ed)?)\\b`, "i");
const ADMIN_DATE =
  /\b(drop deadline|add\s*\/\s*drop|add-drop|withdraw(?:al)?(?: deadline)?|last day to (?:withdraw|drop|add|register)|last day of class(?:es)?|first day of class(?:es)?|holidays?|no class(?:es)?|(?:spring|fall|autumn|winter|summer|thanksgiving|holiday|reading|study|mid-?semester|mid-?term|semester|term|quarter) break|reading (?:week|days?)|study (?:week|days?)|registration (?:opens|closes|deadline)|census date|commencement|graduation)\b|^\s*(?:final\s+|mid-?term\s+)?grades?\s+(?:due|posted|released|available|submitted)\b/i;
/** Holidays: refused unless a deliverable noun names the thing ("Thanksgiving reflection essay"). */
const HOLIDAY =
  /\b(thanksgiving|labou?r day|memorial day|independence day|juneteenth|veterans day|columbus day|indigenous peoples'? day|presidents'? day|martin luther king|mlk day|christmas|new year'?s(?: day| eve)?|easter|good friday|rosh hashanah|yom kippur|passover|diwali|lunar new year)\b/i;
/** A reading is not a graded deliverable (W12): "Reading: chapter 4", "Read chapters 3-5", "Chapter 4 readings". */
const READING = /^\s*(?:(?:required|assigned|optional|pre)[\s-]*)?readings?\b|^\s*read\b|\breadings?\s*$|^\s*chapters?\s+\d/i;
/** ...unless the reading is itself graded work: "Reading response 3", "Reading quiz". */
const GRADED_READING = /\b(quiz(?:zes)?|responses?|reflections?|summar(?:y|ies)|essays?|papers?|memos?|posts?|critiques?|journals?|briefs?|exams?|assignments?)\b/i;

export type NonDeliverable = "meeting/session" | "administrative" | "reading";

export function classifyNonDeliverable(title: string): NonDeliverable | null {
  const t = String(title ?? "").trim();
  if (ADMIN_DATE.test(t)) return "administrative";
  const head = t.split(/\s*(?::|\s[–—-]{1,2}\s|—|\()/)[0].trim() || t;
  if (DUE_PHRASE.test(head)) return null;
  if (HEAD_ENDS_IN_MEETING.test(head) || MEETING_ABOUT.test(head)) return "meeting/session";
  const hasNoun = DELIVERABLE_NOUN.test(t);
  if (!hasNoun && MEETING_WORD.test(t)) return "meeting/session";
  if (!hasNoun && HOLIDAY.test(t)) return "administrative";
  if (READING.test(t) && !GRADED_READING.test(t)) return "reading";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEDUP (AC-F2-14/15, AC-F1-11..14). Scoped to ONE course by the caller. Two rules, nothing looser:
//   1. the same normalised title (after a grade-weight like "(20%)" is dropped) due the same LOCAL
//      DAY is the same row -- and so is a same-titled stored row with NO due date (reported as such,
//      so the agent can offer to add the date: W7). The same title on a DIFFERENT day is a DIFFERENT
//      assignment: weekly "Discussion Post"s are separate deliverables (W1);
//   2. the same due INSTANT (within a minute -- 23:59:00 vs 23:59:59) AND one title's words a subset
//      of the other's AND the same HEAD noun AND the same numbers, with at least two words in the
//      shorter title: "Research Paper Proposal" is the stored "Research Proposal" (both proposals),
//      but "Research Paper Peer Review" is not "Research Paper", "Case Study 2" is not "Case Study",
//      and a bare "Paper" matches nothing by subset (W2: every time-less date defaults to 23:59:59,
//      so ANY two items due the same day share an instant -- the instant alone proves little).
// Never a bare substring/containment rule: "Research Paper" (Dec 9) must NOT swallow "Research Paper
// Proposal" (Oct 30) -- different instants, so rule 2 does not fire, and the titles differ (AC-F1-12).
// Titles are compared Unicode-aware here (W14: a non-Latin title used to normalise to "" and never
// dedup); `normTitle` above stays byte-identical to Nexus's own.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const WEIGHT_RE = /\(\s*\d+(?:\.\d+)?\s*(?:%|percent|pct)[^)]*\)|\b\d+(?:\.\d+)?\s*(?:%|percent\b|pct\b)(?:\s+of\s+(?:the\s+)?(?:final\s+|course\s+|overall\s+)?grade)?/gi;
const STOP = new Set(["the", "a", "an", "of", "and", "for", "on", "to", "in", "my"]);
export const dedupTitle = (s: string | null | undefined) =>
  String(s || "")
    .replace(WEIGHT_RE, " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const wordList = (s: string) => dedupTitle(s).split(" ").filter((w) => w && !STOP.has(w));
const words = (s: string) => new Set(wordList(s));
const isNum = (w: string) => /^\p{N}+[a-z]?$/u.test(w) || /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(w);
/** The head noun: the last non-number word, singularised ("Research Papers" -> "paper"). */
const headWord = (ws: string[]) => (ws.filter((w) => !isNum(w)).pop() ?? "").replace(/(?<!s)s$/, "");
const numbersOf = (ws: string[]) => ws.filter(isNum).sort().join(",");
const SAME_INSTANT_MS = 60_000;

/** The calendar day of an instant in `zone` (YYYY-MM-DD). */
function localDay(ms: number, zone: string): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: isValidZone(zone) ? zone : DEFAULT_COURSE_TZ });
}

/** Postgres/JSON due values → ms. Handles "2026-10-31T03:59:59.000Z" and "2026-10-31 03:59:59+00". */
export function parseStoredInstant(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  let s = String(v).trim().replace(" ", "T");
  s = s.replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export type DuplicateMatch = {
  row: Row;
  by: "title" | "title+due";
  /** The stored row has NO due date: the owner's date is new information (W7). */
  storedUndated?: boolean;
};

export function findDuplicate(
  cand: { title: string; dueMs: number | null; zone?: string },
  existing: Row[],
): DuplicateMatch | null {
  const ct = dedupTitle(cand.title);
  if (!ct) return null;
  const zone = cand.zone ?? DEFAULT_COURSE_TZ;
  const sameTitle = existing.filter((r) => dedupTitle(String(r.title ?? "")) === ct);
  if (sameTitle.length) {
    if (cand.dueMs === null) return { row: sameTitle[0], by: "title" };
    const day = localDay(cand.dueMs, zone);
    const sameDay = sameTitle.find((r) => {
      const rm = parseStoredInstant(r.due_date);
      return rm !== null && localDay(rm, zone) === day;
    });
    if (sameDay) return { row: sameDay, by: "title" };
    const undated = sameTitle.find((r) => parseStoredInstant(r.due_date) === null);
    if (undated) return { row: undated, by: "title", storedUndated: true };
    // Same title, every stored one on another day: a recurring deliverable, NOT a duplicate (W1).
  }
  if (cand.dueMs === null) return null;
  const cl = wordList(cand.title);
  const cw = new Set(cl);
  for (const r of existing) {
    const rm = parseStoredInstant(r.due_date);
    if (rm === null || Math.abs(rm - cand.dueMs) > SAME_INSTANT_MS) continue;
    const rl = wordList(String(r.title ?? ""));
    const rw = new Set(rl);
    if (Math.min(cw.size, rw.size) < 2) continue;
    const sub = [...cw].every((w) => rw.has(w)) || [...rw].every((w) => cw.has(w));
    if (!sub) continue;
    if (headWord(cl) !== headWord(rl) || numbersOf(cl) !== numbersOf(rl)) continue;
    return { row: r, by: "title+due" };
  }
  return null;
}

/** Same-titled stored rows on OTHER days, for the note on a recurring insert (so a MOVE is not missed). */
function sameTitleElsewhere(title: string, existing: Row[]): Row[] {
  const ct = dedupTitle(title);
  return ct ? existing.filter((r) => dedupTitle(String(r.title ?? "")) === ct) : [];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// COURSE BY CODE (AC-F2-16..19). Exact code (separators ignored) → exact name → nothing. NEVER a
// containment guess, and NEVER the first of several: Nexus's matchCourse returns list.find() for a
// duplicated code (courseLink.ts:72); here two hits are `course_ambiguous` and nothing is written.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type CourseResolution =
  | { ok: true; course: Row }
  | { ok: false; error: "course_required" | "course_not_found" | "course_ambiguous"; candidates?: Row[] };

export function resolveCourse(ref: unknown, courses: Row[]): CourseResolution {
  const r = typeof ref === "string" ? ref.trim() : "";
  if (!r) return { ok: false, error: "course_required" };
  const c = normCode(r);
  // A reference with nothing comparable in it ("!!!", "--") names no course -- and must not match a
  // course whose own code also normalises to "" (W15).
  if (!c && !normTitle(r)) return { ok: false, error: "course_required" };
  const byCode = courses.filter((x) => typeof x.code === "string" && x.code && normCode(x.code) === c);
  if (byCode.length === 1) return { ok: true, course: byCode[0] };
  if (byCode.length > 1) return { ok: false, error: "course_ambiguous", candidates: byCode };
  const n = normTitle(r);
  const byName = courses.filter((x) => normTitle(String(x.name ?? "")) === n);
  if (byName.length === 1) return { ok: true, course: byName[0] };
  if (byName.length > 1) return { ok: false, error: "course_ambiguous", candidates: byName };
  return { ok: false, error: "course_not_found" };
}

const courseBrief = (x: Row) => ({ id: x.id, code: x.code ?? null, name: x.name ?? null });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE single outbound WRITE call site. POST (insert) and PATCH (update) of /api/d1/assignments only;
// no DELETE exists in this file. Owner set LAST from server config; the token rides X-UAT-Token
// (W1); X-Agent-Tool + X-Agent-Ref name the caller so Nexus logs a pre-image row for the INSERT too
// (preimage.ts isAgentCall) and the audit can tell an agent write from the UAT harness by `tool`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
type WriteOutcome =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "http"; status: number; body: unknown }
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "not_configured" };

async function nexusWriteFetch(
  method: "POST" | "PATCH",
  query: Record<string, string>,
  body: Row,
  ref: string,
): Promise<WriteOutcome> {
  const base = nexusBase();
  const owner = nexusOwner();
  const token = uatToken();
  if (!base || !owner || !token) return { kind: "not_configured" };
  const url = new URL(`${base}/api/d1/assignments`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("owner", owner);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-UAT-Token": token,
        "X-Agent-Tool": NEXUS_WRITE_TOOL_NAME,
        "X-Agent-Ref": ref.slice(0, 200),
      },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return res.ok ? { kind: "ok", status: res.status, body: parsed } : { kind: "http", status: res.status, body: parsed };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return aborted ? { kind: "timeout" } : { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

function firstRow(body: unknown): Row | null {
  const rows = Array.isArray(body) ? body : Array.isArray((body as { rows?: unknown })?.rows) ? (body as { rows: unknown[] }).rows : [];
  const r = rows[0];
  return r && typeof r === "object" && typeof (r as Row).id === "string" && (r as Row).id ? (r as Row) : null;
}


function outcomeToResult(base: ItemResult, out: WriteOutcome, verb: "inserted" | "updated"): ItemResult {
  if (out.kind === "ok") {
    const row = firstRow(out.body);
    // persisted:true ONLY on a 2xx that carries a row id. A 200 with no id is not proof of a write.
    if (row) return { ...base, action: verb, persisted: true, assignment_id: String(row.id) };
    return { ...base, action: "failed", persisted: false, error: "no_row_id_in_response" };
  }
  if (out.kind === "timeout") {
    return {
      ...base,
      action: "failed",
      persisted: "unknown",
      error: "timeout",
      note: "The request timed out after it was sent, so it MAY have been saved. Check with get_nexus_assignments before telling the owner anything about this item; retrying is safe (a duplicate is detected, never inserted twice).",
    };
  }
  if (out.kind === "http") {
    const b = out.body as { error?: unknown; reason?: unknown } | null;
    const err =
      out.status === 404 ? "not_found" : out.status === 409 && b?.reason === "not_reversible" ? "not_reversible" : `http_${out.status}`;
    return { ...base, action: "failed", persisted: false, error: err, detail: typeof b?.error === "string" ? b.error.slice(0, 300) : undefined };
  }
  return { ...base, action: "failed", persisted: false, error: out.kind === "network" ? "network_error" : "nexus_not_configured" };
}

const PRIORITIES = new Set(["low", "medium", "high"]);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function localLabel(ms: number, zone: string): string {
  const tz = isValidZone(zone) ? zone : DEFAULT_COURSE_TZ;
  return new Date(ms).toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * Executor for BOTH surfaces (text dispatch in huddle.functions.ts, voice dispatch in
 * realtime-tools.server.ts) -- one copy, so the voice path cannot drift from the text path.
 * `ref` is the caller's correlation id (huddle / turn / agent), recorded by Nexus as actor_ref.
 */
export async function executeNexusWriteTool(
  args: Record<string, unknown>,
  ctx: { ref?: string } = {},
): Promise<Row> {
  if (!nexusWriteConfigured()) return { ok: false, persisted: false, error: "nexus_write_not_configured" };
  const ref = (ctx.ref ?? "huddle").trim() || "huddle";

  // Accept the documented {items:[…]} and, leniently, one flat item.
  const rawItems: unknown[] = Array.isArray(args.items)
    ? (args.items as unknown[])
    : args.title !== undefined || args.assignment_id !== undefined
      ? [args]
      : [];
  if (!rawItems.length) return { ok: false, persisted: false, error: "no_items" };
  if (rawItems.length > NEXUS_WRITE_MAX_BATCH) {
    return {
      ok: false,
      persisted: false,
      error: "batch_too_large",
      limit: NEXUS_WRITE_MAX_BATCH,
      note: `Nothing was written. Send at most ${NEXUS_WRITE_MAX_BATCH} items per call.`,
    };
  }
  // W3: the dedup is read-then-POST, so two calls in flight at once (two prime agents in one parallel
  // wave) could both read "no row" and both insert. Every write call in this server process runs one
  // at a time, so the second reads AFTER the first has written and reports `duplicate`.
  return withWriteLock(() => runNexusWrite(rawItems, ref));
}

/**
 * The process-wide write lock (W3). A promise chain, not a mutex library: each call waits for the
 * previous one to settle (success OR failure) before reading. Scope: ONE server instance -- two
 * Azure instances handling two requests at the same instant are not serialised by this (Nexus has
 * no unique constraint on assignments); see docs/FIX-nexus-write-redteam.md, W3 residual.
 */
let writeChain: Promise<unknown> = Promise.resolve();
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * The per-turn CLAIM KEY for a write call (W3): the normalised (course, title, due date) of every ADD
 * item and the (id, title, due date) of every UPDATE, sorted -- so two agents whose calls differ only
 * in an optional field (priority, description) or in item order claim the SAME key, and the second
 * one is handed the first one's outcome instead of writing again. Hashed so a 25-item batch cannot be
 * cut short by the ledger's 240-character key limit and collide with a different batch.
 */
export function nexusWriteClaimKey(args: Record<string, unknown>): string {
  const raw: unknown[] = Array.isArray(args.items) ? (args.items as unknown[]) : [args];
  const keys = raw
    .map((x) => {
      const it = (x && typeof x === "object" ? x : {}) as Row;
      const due = resolveDueInstant(it.due_date, it.due_time, it.time_zone);
      const when = due.ok ? localDay(due.ms, due.zone) : str(it.due_date).toLowerCase();
      const id = str(it.assignment_id);
      return id
        ? `upd|${id}|${dedupTitle(str(it.title))}|${due.ok ? due.iso : when}`
        : `add|${normCode(str(it.course)) || dedupTitle(str(it.course))}|${dedupTitle(str(it.title))}|${when}`;
    })
    .sort()
    .join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < keys.length; i++) {
    h ^= keys.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${raw.length}:${h.toString(16)}:${keys.length}`;
}

/**
 * What a suppressed duplicate call reports when the first call's outcome is not in hand (it was made
 * in an EARLIER chunk of a resumed turn). Every item is `unknown`, so the honesty guard forbids any
 * success claim and the agent is told to check -- never a fabricated "ok".
 */
export function nexusWriteUnknownOutcome(args: Record<string, unknown>): Row {
  const raw: unknown[] = Array.isArray(args.items) ? (args.items as unknown[]) : [args];
  const results: ItemResult[] = raw.map((x, index) => {
    const it = (x && typeof x === "object" ? x : {}) as Row;
    return {
      index,
      title: str(it.title) || undefined,
      action: "failed",
      persisted: "unknown",
      error: "outcome_not_in_this_chunk",
      note: "This exact write was already made earlier in this turn; its outcome is not available here. Check with get_nexus_assignments before saying anything about it.",
    };
  });
  return { ok: true, persisted: "unknown", inserted: 0, updated: 0, duplicate: 0, rejected: 0, failed: results.length, results };
}

async function runNexusWrite(rawItems: unknown[], ref: string): Promise<Row> {
  // The owner's courses, read once -- only when some item ADDS (an update names its row by id).
  const needsCourses = rawItems.some((it) => !str((it as Row | null)?.assignment_id));
  let courses: Row[] = [];
  if (needsCourses) {
    const cr = await nexusGet("courses");
    if (!cr.ok) {
      return { ok: false, persisted: false, error: `courses_unreadable:${cr.error}`, note: "Nothing was written: the owner's course list could not be read." };
    }
    const owner = nexusOwner();
    // Only HIS courses: never a shared sample/demo row (they carry another owner id).
    courses = cr.rows.filter((c) => !c.user_id || String(c.user_id) === owner);
  }
  const existingByCourse = new Map<string, Row[]>();
  const existingFor = async (courseId: string): Promise<Row[] | null> => {
    if (existingByCourse.has(courseId)) return existingByCourse.get(courseId)!;
    // A BARE value is d1's equality filter (an `eq.` prefix reaches Postgres as a literal).
    const r = await nexusGet("assignments", [["course_id", courseId]]);
    if (!r.ok) return null;
    const rows = r.rows.filter((x) => String(x.course_id ?? courseId) === courseId);
    existingByCourse.set(courseId, rows);
    return rows;
  };

  const results: ItemResult[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = (rawItems[i] && typeof rawItems[i] === "object" ? rawItems[i] : {}) as Row;
    // WHITELIST READ: these are the only keys that can ever influence a write. owner / user_id /
    // email / program_id / canvas_meta / id are never read, so they can never reach Nexus.
    const assignmentId = str(it.assignment_id);
    const title = str(it.title);
    const description = typeof it.description === "string" ? it.description : undefined;
    const points = typeof it.points === "number" && Number.isInteger(it.points) && it.points >= 0 ? it.points : undefined;
    // W16: a points value that cannot be stored (12.5, -3, "20%") is REFUSED -- never rounded, since a
    // weight is not points -- and the result SAYS so, so the agent cannot report it as saved.
    const pointsRefused =
      it.points !== undefined && it.points !== null && points === undefined
        ? `points ${JSON.stringify(it.points)} was NOT saved: points must be a whole number of real points. A percentage or weight belongs in description.`
        : undefined;
    const priority = PRIORITIES.has(str(it.priority).toLowerCase()) ? str(it.priority).toLowerCase() : undefined;
    const base: ItemResult = { index: i, title: title || undefined, action: "rejected", persisted: false };
    if (pointsRefused) base.points_note = pointsRefused;

    if (title) {
      const non = classifyNonDeliverable(title);
      if (non) {
        results.push({
          ...base,
          reason: non,
          note:
            non === "meeting/session"
              ? "Not an assignment: a meeting/session/residency belongs on the class SCHEDULE, not the assignments list. Nothing was written. If it really is a graded deliverable, ask the owner to name the deliverable itself (e.g. 'Residency 4 reflection paper')."
              : non === "reading"
                ? "Not an assignment: a reading is not a graded deliverable. Nothing was written. If there is graded work on it (a response, quiz or summary), ask the owner to name that."
                : "Not an assignment: a holiday, break or administrative calendar date, not a graded deliverable. Nothing was written.",
        });
        continue;
      }
    }

    if (assignmentId) {
      // ── UPDATE ── only the fields given; an update can never make a row undated (AC-F2-12).
      const patch: Row = {};
      if (title) patch.title = title;
      if (description !== undefined) patch.description = description;
      if (points !== undefined) patch.points = points;
      if (priority !== undefined) patch.priority = priority;
      let due: DueResolution | null = null;
      if ("due_date" in it) {
        due = resolveDueInstant(it.due_date, it.due_time, it.time_zone);
        if (!due.ok) {
          results.push({ ...base, reason: due.reason, detail: due.detail, note: "Nothing was changed: an assignment cannot be made undated or given a date without a year." });
          continue;
        }
        patch.due_date = due.iso;
      }
      if (!Object.keys(patch).length) {
        results.push({ ...base, reason: "no_fields", note: "Nothing to change was given." });
        continue;
      }
      const out = await nexusWriteFetch("PATCH", { id: assignmentId }, patch, ref);
      const r = outcomeToResult({ ...base, assignment_id: assignmentId }, out, "updated");
      if (due && due.ok) Object.assign(r, { due_date: due.iso, due_local: localLabel(due.ms, due.zone), time_assumed: due.timeAssumed || undefined, time_shifted: due.timeShifted });
      results.push(r);
      continue;
    }

    // ── ADD ──
    if (!title) {
      results.push({ ...base, reason: "title_required" });
      continue;
    }
    const due = resolveDueInstant(it.due_date, it.due_time, it.time_zone);
    if (!due.ok) {
      results.push({ ...base, reason: due.reason, detail: due.detail, note: "Not added: only DATED deliverables (with a year) go into Nexus. Ask the owner for the date." });
      continue;
    }
    const cres = resolveCourse(it.course, courses);
    if (!cres.ok) {
      results.push({
        ...base,
        reason: cres.error,
        error: cres.error,
        candidates: cres.candidates?.map(courseBrief),
        courses: cres.error === "course_not_found" ? courses.slice(0, 40).map(courseBrief) : undefined,
        note:
          cres.error === "course_ambiguous"
            ? "Nothing was written: that course reference matches more than one course. Ask the owner which one."
            : "Nothing was written: no course matches that code or exact name. Ask the owner which course, using the list given.",
      });
      continue;
    }
    const course = cres.course;
    const courseId = String(course.id);
    const existing = await existingFor(courseId);
    if (existing === null) {
      // Cannot prove it is not a duplicate -> do not write. A second row is the failure being prevented.
      results.push({ ...base, action: "failed", persisted: false, error: "existing_unreadable", course: courseBrief(course), note: "Nothing was written: the course's existing assignments could not be read to rule out a duplicate." });
      continue;
    }
    const dup = findDuplicate({ title, dueMs: due.ms, zone: due.zone }, existing);
    if (dup) {
      const storedMs = parseStoredInstant(dup.row.due_date);
      const differs = storedMs !== null && Math.abs(storedMs - due.ms) > SAME_INSTANT_MS;
      results.push({
        ...base,
        action: "duplicate",
        persisted: false,
        assignment_id: String(dup.row.id),
        course: courseBrief(course),
        stored_undated: dup.storedUndated || undefined,
        note: dup.storedUndated
          ? `Already in Nexus as "${String(dup.row.title)}", but that stored row has NO due date, so the date given (${localLabel(due.ms, due.zone)}) was NOT saved. Nothing new was added. Tell the owner and offer to add the date: call again with assignment_id and due_date to update it.`
          : differs
            ? `Already in Nexus as "${String(dup.row.title)}" but with a DIFFERENT due time (stored ${String(dup.row.due_date)}). Nothing was added. If the owner wants the new time, call again with assignment_id and due_date to update it.`
            : `Already in Nexus as "${String(dup.row.title)}". Nothing new was added.`,
      });
      continue;
    }
    const elsewhere = sameTitleElsewhere(title, existing);
    const body: Row = {
      course_id: courseId,
      title,
      type: "assignment",
      status: "active",
      due_date: due.iso,
    };
    if (typeof course.program_id === "string" && course.program_id) body.program_id = course.program_id;
    if (description !== undefined) body.description = description;
    if (points !== undefined) body.points = points;
    if (priority !== undefined) body.priority = priority;
    const out = await nexusWriteFetch("POST", {}, body, ref);
    const r = outcomeToResult(
      {
        ...base,
        course: courseBrief(course),
        due_date: due.iso,
        due_local: localLabel(due.ms, due.zone),
        time_assumed: due.timeAssumed || undefined,
        time_shifted: due.timeShifted,
      },
      out,
      "inserted",
    );
    if (r.persisted === true && elsewhere.length) {
      r.note = `Added as a SEPARATE assignment: "${title}" also exists due ${elsewhere.map((x) => String(x.due_date)).join(", ")} (a recurring deliverable). If the owner meant to MOVE that one, say so: the extra row would need removing in Nexus.`;
    }
    results.push(r);
    // Same-batch dedup: a second identical item in this call is a duplicate of the row just written.
    if (r.persisted === true && r.assignment_id) existing.push({ id: r.assignment_id, title, due_date: due.iso, course_id: courseId });
  }

  const allPersisted = results.every((r) => r.persisted === true);
  const anyUnknown = results.some((r) => r.persisted === "unknown");
  const persisted: true | false | "unknown" = allPersisted ? true : anyUnknown ? "unknown" : false;
  const count = (a: ItemResult["action"]) => results.filter((r) => r.action === a).length;
  return {
    ok: true,
    persisted,
    inserted: count("inserted"),
    updated: count("updated"),
    duplicate: count("duplicate"),
    rejected: count("rejected"),
    failed: count("failed"),
    results,
    // The truthful one-paragraph summary, built from the per-item results: the voice surface (whose
    // model speaks its own words) and any agent can say exactly this.
    outcome: nexusWriteOutcomeStatement(results),
    note:
      "Report each item exactly as its result says (`outcome` is a truthful summary you may say as-is). persisted:true = saved to Nexus. action 'duplicate' = it was already there, nothing new added. 'rejected' or 'failed' = NOT saved -- say so plainly and give the reason. persisted:'unknown' = timed out and may have landed -- verify with get_nexus_assignments first. Never say an item was added, saved or updated unless its own persisted is true.",
  };
}

/** One-line telemetry label (AC-F2-36): says WRITE, never the read tools' "row(s) from Nexus". */
export function nexusWriteSummary(out: Row): { summary: string; ok: boolean } {
  if (out.ok !== true) return { summary: `Nexus write FAILED: ${String(out.error ?? "failed")}`, ok: false };
  const results = (out.results as ItemResult[]) ?? [];
  const errs = [...new Set(results.filter((r) => r.action === "rejected" || r.action === "failed").map((r) => r.error ?? r.reason ?? "failed"))];
  const parts = [`${out.inserted ?? 0} inserted`, `${out.updated ?? 0} updated`];
  if (out.duplicate) parts.push(`${out.duplicate} duplicate`);
  if (errs.length) parts.push(`not saved: ${errs.join(", ")}`);
  const ok = out.persisted === true;
  return { summary: `${ok ? "Nexus write" : "Nexus write FAILED"}: ${parts.join(", ")}`.slice(0, 200), ok };
}

