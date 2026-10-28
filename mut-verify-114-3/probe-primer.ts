// WHAT:       Verifier probe (VERIFY-nexus-write-tool-3): primeNexusCourseContext's bound, back-off and owner filter,
//             with a fake fetch (slow / failing / other-owner rows / non-array body), plus the request it sends.
// WHY:        C4/C6/C9 of verify loop 3: cache / timeout / fallback of the course-list routing, read-only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-3.md. OFFLINE: fetch is replaced.
// Run: bun mut-verify-114-3/probe-primer.ts
const OWNER = "owner-uuid-1111";
Object.assign(process.env, { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: "srv-token" });
type Init = RequestInit | undefined;
let behaviour: "slow" | "fail" | "ok" | "html" = "slow";
const seen: Array<{ url: string; init: string[] }> = [];
globalThis.fetch = (async (input: string, init?: Init) => {
  seen.push({ url: String(input), init: Object.keys(init ?? {}) });
  if (behaviour === "slow") await new Promise((r) => setTimeout(r, 2500));
  if (behaviour === "fail") return new Response("{}", { status: 503 });
  if (behaviour === "html") return new Response("<html>login</html>", { status: 200 });
  return new Response(JSON.stringify([
    { id: "c1", code: "MGT-782", name: "Theories of Strategy", user_id: OWNER },
    { id: "c2", code: "FIN-999", name: "Someone Else's Course", user_id: "other-owner" },
  ]), { status: 200 });
}) as unknown as typeof fetch;

const { primeNexusCourseContext } = await import("../src/features/huddle/lib/nexus/course-context.server");
const cc = await import("../src/features/huddle/lib/nexus/course-context");
const t = async (label: string, fn: () => Promise<unknown>) => {
  const s = Date.now();
  const r = await fn();
  console.log(`${label}: ${JSON.stringify(r)} in ${Date.now() - s} ms`);
};
await t("cold + slow Nexus (2.5 s)", () => primeNexusCourseContext());
console.log("  MGT-782 mentioned right after:", cc.nexusCourseMentioned("my MGT-782 paper"));
await new Promise((r) => setTimeout(r, 1300));
console.log("  after the background read finished:", cc.nexusCourseMentioned("my MGT-782 paper"), "FIN-999 (other owner):", cc.nexusCourseMentioned("my FIN-999 paper"));
await t("warm", () => primeNexusCourseContext());
cc.setNexusCourseContext(null);
behaviour = "fail";
await t("cold + 503", () => primeNexusCourseContext());
const n = seen.length;
await t("again within 60 s", () => primeNexusCourseContext());
console.log("  fetches during back-off:", seen.length - n);
console.log("  request shape:", JSON.stringify(seen[0]));
