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
import { NEXUS_WRITE_TOOL_NAME, type ItemResult } from "./nexus-write-shared";

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

/** Wall-clock time in `tz` → the UTC instant (ms). Two-pass, so it is right on both sides of a DST switch. */
export function zonedLocalToUtcMs(
  y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMs(tz, guess);
  let t = guess - off1;
  const off2 = zoneOffsetMs(tz, t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

function validYmd(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

export type DueResolution =
  | { ok: true; iso: string; ms: number; timeAssumed: boolean; zone: string }
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
    if (!isValidZone(timeZone.trim())) return { ok: false, reason: "ambiguous-date", detail: `unknown time zone "${timeZone}"` };
    zone = timeZone.trim();
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
  return { ok: true, iso: isoZ(ms), ms, timeAssumed, zone };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS NOT AN ASSIGNMENT (AC-F2-11, OQ-11). A meeting word with no deliverable noun is a session;
// a deliverable noun wins ("Seminar paper" is a paper). Administrative calendar dates are never
// deliverables. The refusal REASON goes back to the agent so the owner can rephrase to override.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const DELIVERABLE_NOUN =
  /\b(papers?|proposals?|essays?|reports?|assignments?|submissions?|projects?|briefs?|memos?|deliverables?|drafts?|thesis|dissertation|case (?:study|analysis|write-?up)|reflections?|exams?|quiz(?:zes)?|midterms?|homework|problem sets?|portfolios?|bibliograph(?:y|ies)|literature review|write-?ups?|posts?|responses?)\b/i;
const MEETING_WORD =
  /\b(residenc(?:y|ies)|seminars?|sessions?|zoom|class meetings?|meetings?|orientation|office hours?|check-?points?|lectures?|webinars?|workshops?|kick-?off|attendance|participation|live class(?:es)?|synchronous|immersion)\b/i;
const ADMIN_DATE =
  /\b(drop deadline|add\s*\/\s*drop|add-drop|withdraw(?:al)? deadline|last day of class(?:es)?|first day of class(?:es)?|holidays?|no class(?:es)?|spring break|fall break|winter break|registration (?:opens|closes|deadline))\b/i;

export function classifyNonDeliverable(title: string): "meeting/session" | "administrative" | null {
  if (ADMIN_DATE.test(title)) return "administrative";
  if (MEETING_WORD.test(title) && !DELIVERABLE_NOUN.test(title)) return "meeting/session";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEDUP (AC-F2-14/15, AC-F1-11..14). Scoped to ONE course by the caller. Two rules, nothing looser:
//   1. the same normalised title (after a grade-weight like "(20%)" is dropped) is the same row;
//   2. the same due INSTANT (within a minute -- 23:59:00 vs 23:59:59) AND one title's words a subset
//      of the other's ("Research Paper Proposal" vs "Research Proposal").
// Never a bare substring/containment rule: "Research Paper" (Dec 9) must NOT swallow "Research Paper
// Proposal" (Oct 30) -- different instants, so rule 2 does not fire, and the titles differ (AC-F1-12).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const WEIGHT_RE = /\(\s*\d+(?:\.\d+)?\s*(?:%|percent|pct)[^)]*\)|\b\d+(?:\.\d+)?\s*(?:%|percent\b|pct\b)(?:\s+of\s+(?:the\s+)?(?:final\s+|course\s+|overall\s+)?grade)?/gi;
const STOP = new Set(["the", "a", "an", "of", "and", "for", "on", "to", "in", "my"]);
export const dedupTitle = (s: string | null | undefined) => normTitle(String(s || "").replace(WEIGHT_RE, " "));
const words = (s: string) => new Set(dedupTitle(s).split(" ").filter((w) => w && !STOP.has(w)));
const SAME_INSTANT_MS = 60_000;

/** Postgres/JSON due values → ms. Handles "2026-10-31T03:59:59.000Z" and "2026-10-31 03:59:59+00". */
export function parseStoredInstant(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  let s = String(v).trim().replace(" ", "T");
  s = s.replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export function findDuplicate(
  cand: { title: string; dueMs: number | null },
  existing: Row[],
): { row: Row; by: "title" | "title+due" } | null {
  const ct = dedupTitle(cand.title);
  if (!ct) return null;
  const exact = existing.find((r) => dedupTitle(String(r.title ?? "")) === ct);
  if (exact) return { row: exact, by: "title" };
  if (cand.dueMs === null) return null;
  const cw = words(cand.title);
  for (const r of existing) {
    const rm = parseStoredInstant(r.due_date);
    if (rm === null || Math.abs(rm - cand.dueMs) > SAME_INSTANT_MS) continue;
    const rw = words(String(r.title ?? ""));
    if (!cw.size || !rw.size) continue;
    const sub = [...cw].every((w) => rw.has(w)) || [...rw].every((w) => cw.has(w));
    if (sub) return { row: r, by: "title+due" };
  }
  return null;
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
    const priority = PRIORITIES.has(str(it.priority).toLowerCase()) ? str(it.priority).toLowerCase() : undefined;
    const base: ItemResult = { index: i, title: title || undefined, action: "rejected", persisted: false };

    if (title) {
      const non = classifyNonDeliverable(title);
      if (non) {
        results.push({
          ...base,
          reason: non,
          note:
            non === "meeting/session"
              ? "Not an assignment: a meeting/session/residency belongs on the class SCHEDULE, not the assignments list. Nothing was written. If it really is a graded deliverable, ask the owner to name the deliverable itself (e.g. 'Residency 4 reflection paper')."
              : "Not an assignment: an administrative calendar date, not a graded deliverable. Nothing was written.",
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
      if (due && due.ok) Object.assign(r, { due_date: due.iso, due_local: localLabel(due.ms, due.zone), time_assumed: due.timeAssumed || undefined });
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
    const dup = findDuplicate({ title, dueMs: due.ms }, existing);
    if (dup) {
      const storedMs = parseStoredInstant(dup.row.due_date);
      const differs = storedMs !== null && Math.abs(storedMs - due.ms) > SAME_INSTANT_MS;
      results.push({
        ...base,
        action: "duplicate",
        persisted: false,
        assignment_id: String(dup.row.id),
        course: courseBrief(course),
        note: differs
          ? `Already in Nexus as "${String(dup.row.title)}" but with a DIFFERENT due date (stored ${String(dup.row.due_date)}). Nothing was added. If the owner wants the new date, call again with assignment_id and due_date to update it.`
          : `Already in Nexus as "${String(dup.row.title)}". Nothing new was added.`,
      });
      continue;
    }
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
      { ...base, course: courseBrief(course), due_date: due.iso, due_local: localLabel(due.ms, due.zone), time_assumed: due.timeAssumed || undefined },
      out,
      "inserted",
    );
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
    note:
      "Report each item exactly as its result says. persisted:true = saved to Nexus. action 'duplicate' = it was already there, nothing new added. 'rejected' or 'failed' = NOT saved -- say so plainly and give the reason. persisted:'unknown' = timed out and may have landed -- verify with get_nexus_assignments first. Never say an item was added, saved or updated unless its own persisted is true.",
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

