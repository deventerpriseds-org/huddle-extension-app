// WHAT:       Fills the routing course-context cache (course-context.ts) from Nexus through the EXISTING read
//             path (`nexusGet("courses")`, the same call get_nexus_courses makes), owner-filtered.
// WHY:        D6 (docs/VERIFY-nexus-write-tool-2.md): coursework context must be the owner's real course list,
//             not a regex. Routing runs at the start of every turn, so the read is BOUNDED: a cached list is
//             used for its TTL; a cold read is awaited at most `waitMs` and otherwise finishes in the
//             background for the next turn -- this turn then routes on the weak signals only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-loop3.md (D6).

import { nexusGet, nexusOwner, nexusReadConfigured } from "./nexus.server";
import { nexusCourseContextFresh, setNexusCourseContext } from "./course-context";

const RETRY_AFTER_FAILURE_MS = 60_000;
let inflight: Promise<void> | null = null;
let lastFailureAt = 0;

/** "fresh" (cache used), "loaded" (read now), or "unavailable" (not configured / failed / still loading). */
export async function primeNexusCourseContext(opts: { waitMs?: number } = {}): Promise<"fresh" | "loaded" | "unavailable"> {
  if (nexusCourseContextFresh()) return "fresh";
  if (!nexusReadConfigured()) return "unavailable";
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return "unavailable";
  if (!inflight) {
    inflight = (async () => {
      try {
        const r = await nexusGet("courses");
        if (!r.ok) {
          lastFailureAt = Date.now();
          return;
        }
        const owner = nexusOwner();
        setNexusCourseContext(r.rows.filter((c) => !c.user_id || String(c.user_id) === owner) as Array<{ code?: unknown; name?: unknown }>);
      } catch {
        lastFailureAt = Date.now();
      } finally {
        inflight = null;
      }
    })();
  }
  const waitMs = opts.waitMs ?? 1500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    inflight.then(() => true),
    new Promise<boolean>((res) => {
      timer = setTimeout(() => res(false), waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return done && nexusCourseContextFresh() ? "loaded" : "unavailable";
}
