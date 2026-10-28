// WHAT:       The owner's REAL course codes and names from Nexus, as routing CONTEXT: "does this message
//             name one of HIS courses?" -- the strong signal that a coursework ask is his coursework.
// WHY:        Loop 2 used a GENERIC course-code regex (`[A-Z]{2,4}[- ]?\d{3}`) as strong context, so a
//             flight number ("UA 902"), a visa form ("DS-160"), an IRS form ("941") and a ticker ("NVDA
//             200") all read as a course and handed travel/finance/business asks to Elle/Iris
//             (docs/VERIFY-nexus-write-tool-2.md, D6). A real course code is DATA in Nexus, not a shape.
// SUPERSEDES: the generic course-code strongPatterns of NEXUS_ASSIGNMENTS_CAPABILITY (agents.ts, loop 2).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-loop3.md (D6); scripts/nexus-write-loop3.test.ts (L3-D6*).
//
// PURE: no server imports, so lib/capabilities.ts (also bundled for the client) can read it. The cache is
// FILLED on the server by course-context.server.ts (the existing read path, nexusGet("courses")) and by the
// write tool whenever it reads the course list; tests inject it with setNexusCourseContext(). A stale or
// empty cache means "no strong course context" -- routing then falls back to the weak signals only.

export const NEXUS_COURSE_CONTEXT_TTL_MS = 5 * 60_000;

type CourseLike = { code?: unknown; name?: unknown };
type Cache = { at: number; codes: RegExp[]; names: string[] };
let cache: Cache | null = null;

const norm = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Course-code matchers from a code or name: "MGT-782" -> /mgt[\s\-_]?782/ as a whole token. */
function codeMatchers(s: string): RegExp[] {
  const out: RegExp[] = [];
  for (const m of s.matchAll(/([A-Za-z]{2,6})\s*[-_ ]?\s*(\d{3,4}[A-Za-z]?)(?![0-9])/g)) {
    out.push(new RegExp(`(?<![\\p{L}\\p{N}])${m[1].toLowerCase()}[\\s\\-_]?${m[2].toLowerCase()}(?![\\p{L}\\p{N}])`, "iu"));
  }
  return out;
}

/**
 * Replace the cached course list (the owner's own courses only -- the caller filters by owner). `null`
 * clears it. Names count only when they are a real phrase (2+ words, 8+ characters): a course named
 * "Strategy" must not make every "strategy" a coursework signal.
 */
export function setNexusCourseContext(courses: CourseLike[] | null, nowMs: number = Date.now()): void {
  if (!courses) {
    cache = null;
    return;
  }
  const codes: RegExp[] = [];
  const names: string[] = [];
  for (const c of courses) {
    const code = typeof c.code === "string" ? c.code : "";
    const name = typeof c.name === "string" ? c.name : "";
    codes.push(...codeMatchers(code), ...codeMatchers(name));
    const n = norm(name);
    if (n.split(" ").filter((w) => /\p{L}/u.test(w)).length >= 2 && n.length >= 8) names.push(n);
  }
  cache = { at: nowMs, codes, names };
}

/** True while the cached course list is younger than the TTL. */
export function nexusCourseContextFresh(nowMs: number = Date.now()): boolean {
  return !!cache && nowMs - cache.at < NEXUS_COURSE_CONTEXT_TTL_MS;
}

/** Does `text` name one of the owner's real courses (code or full name)? False when the cache is stale/empty. */
export function nexusCourseMentioned(text: string, nowMs: number = Date.now()): boolean {
  if (!cache || !nexusCourseContextFresh(nowMs)) return false;
  const raw = String(text ?? "");
  if (cache.codes.some((re) => re.test(raw))) return true;
  const t = ` ${norm(raw)} `;
  return cache.names.some((n) => t.includes(` ${n} `));
}
