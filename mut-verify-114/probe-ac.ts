// WHAT:       Verifier probe (VERIFY-nexus-write-tool-1): the offline-testable Feature-2 ACs not covered by
//             the other probes -- F2-14/15/16/17/18/19/23/30/34/36/43/45.
// WHY:        C1 mapping with observed evidence, not the builder's.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-1.md. OFFLINE: fake fetch.
// Run: bun mut-verify-114/probe-ac.ts
import { executeNexusWriteTool, nexusWriteTools, nexusWriteSummary } from "../src/features/huddle/lib/nexus/nexus-write.server";
import { nexusReadTools } from "../src/features/huddle/lib/nexus/nexus.server";
import { routeMessage, laneOwnerFor } from "../src/features/huddle/lib/routing";
import { AGENTS } from "../src/features/huddle/data/agents";

type Row = Record<string, unknown>;
const OWNER = "o-1";
const FULL = { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: "tok" };
const setEnv = (o: Record<string, string>) => {
  for (const k of ["NEXUS_API_URL", "NEXUS_OWNER_ID", "UAT_BYPASS_TOKEN"]) delete process.env[k];
  Object.assign(process.env, o);
};
const COURSES: Row[] = [
  { id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p", user_id: OWNER },
  { id: "csm", code: null, name: "Strategic Management", user_id: OWNER },
  { id: "t1", code: "TST-701", name: "Test A", user_id: OWNER },
  { id: "t2", code: "TST 701", name: "Test B", user_id: OWNER },
];
let ASSIGN: Row[] = [];
const reset = () => (ASSIGN = [{ id: "aafbf80f-512a-4ea8-892b-0d9c9548c09e", course_id: "c782", title: "Research Proposal", due_date: "2026-10-31T03:59:59.000Z" }]);
let mode = "ok";
let posts = 0;
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
  if (method === "GET") {
    if (url.pathname.endsWith("/courses")) return json(200, COURSES);
    const f = JSON.parse(url.searchParams.get("filters") ?? "[]") as [string, string][];
    const cid = f.find(([c]) => c === "course_id")?.[1];
    return json(200, ASSIGN.filter((a) => a.course_id === cid));
  }
  posts++;
  const abort = () => { const e = new Error("a"); e.name = "AbortError"; throw e; };
  if (mode === "throw") throw new Error("ECONNRESET");
  if (mode === "400") return json(400, { error: "bad" });
  if (mode === "500") return json(500, { error: "boom" });
  if (mode === "noid") return json(200, { rows: [] });
  const row = { id: `n${posts}`, ...(JSON.parse(String(init?.body)) as Row) };
  ASSIGN.push(row);
  if (mode === "timeoutAfterCommit") abort();
  return json(200, { rows: [row] });
}) as unknown as typeof fetch;

const run = async (items: Row[]) => (await executeNexusWriteTool({ items }, { ref: "p" })) as Row;
const one = (o: Row) => (o.results as Row[]).map((r) => `${r.action}/${String(r.persisted)}${r.error ? `/${r.error}` : ""}${r.reason ? `/${r.reason}` : ""}${r.assignment_id ? ` id=${r.assignment_id}` : ""}${(r.course as Row)?.id ? ` course=${(r.course as Row).id}` : ""}`).join(" | ");

setEnv(FULL);
reset();
console.log("F2-14 Research Paper Proposal 23:59 ET:", one(await run([{ course: "MGT-782", title: "Research Paper Proposal", due_date: "2026-10-30", due_time: "23:59", time_zone: "ET" }])));
reset(); mode = "timeoutAfterCommit"; posts = 0;
const first = one(await run([{ course: "MGT-782", title: "Test-Case Brief 9", due_date: "2026-11-12" }]));
mode = "ok";
const retry = one(await run([{ course: "MGT-782", title: "Test-Case Brief 9", due_date: "2026-11-12" }]));
console.log(`F2-15 timeout-after-commit: ${first} ; retry: ${retry} ; rows=${ASSIGN.filter((a) => a.title === "Test-Case Brief 9").length}`);
reset();
for (const c of ["MGT-782", "mgt 782", "MGT782", "mgt-782", "MGT-782-W1 (202711)", "MGT-999", "TST-701", "Strategic Management", "Strategy"]) {
  console.log(`F2-16..19 course ${JSON.stringify(c)}:`, one(await run([{ course: c, title: "Test-Memo 1", due_date: "2026-11-20" }])));
  reset();
}
console.log("F2-23 mixed batch:", one(await run([
  { course: "MGT-782", title: "Test-Memo A", due_date: "2026-11-20" },
  { course: "MGT-782", title: "Test-Memo B" },
  { course: "MGT-782", title: "Test-Memo C", due_date: "2026-11-21" },
])));
for (const m of ["ok", "400", "500", "throw", "noid", "timeoutAfterCommit"]) {
  reset(); mode = m;
  const o = await run([{ course: "MGT-782", title: `Test-Memo ${m}`, due_date: "2026-11-22" }]);
  console.log(`F2-34 POST ${m}:`, one(o), "| F2-36 telemetry:", JSON.stringify(nexusWriteSummary(o)));
}
mode = "ok";
const perms: Array<[string, Record<string, string>]> = [
  ["full", FULL], ["no URL", { NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: "tok" }],
  ["no owner", { NEXUS_API_URL: "https://n", UAT_BYPASS_TOKEN: "tok" }], ["no token", { NEXUS_API_URL: "https://n", NEXUS_OWNER_ID: OWNER }],
];
for (const [label, env] of perms) {
  setEnv(env);
  console.log(`F2-30 ${label}: write tools=${nexusWriteTools().length} read tools=${(nexusReadTools() as unknown[]).length}`);
}
setEnv(FULL);
const ALL = AGENTS.map((a) => a.id);
console.log("F2-43 1:1 finn 'add my MGT-782 research paper due Dec 9' ->", JSON.stringify(laneOwnerFor("add my MGT-782 research paper due Dec 9", "finn-reid")));
for (const t of ["assign the grocery run to Iris", "add a task to my board to call the bank", "what's on my board", "log my run this morning", "how much did I spend on dining", "book my flight to Denver"]) {
  const r = routeMessage({ text: t, scope: "group", members: ALL, history: [] } as Parameters<typeof routeMessage>[0]);
  console.log(`F2-45 ${JSON.stringify(t)} -> ${r.winners[0]} (${r.decision.reason.slice(0, 30)})`);
}
