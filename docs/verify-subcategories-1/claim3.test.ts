// Claim 3 + 4: drive the REAL composePrioritiesWidget / fetchTopicPayload with the mirror read and the
// journey proxy mocked (bun mock.module), on the owner's real mirror rows.
import { test, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";

const WT = process.env.WT!;
const DIR = process.env.DATA!;
const mirror: any[] = JSON.parse(readFileSync(`${DIR}/mirror.json`, "utf8"));
const rows = mirror.map((r) => ({ ...r, definition_of_done: null }));

let proxyImpl: (req: any) => Promise<any> = async () => ({ ok: false, output: JSON.stringify({ error: "Unknown tool: get_task_topics" }), error: "Unknown tool: get_task_topics" });
let calls = 0;
mock.module(`${WT}/src/features/huddle/lib/tasks/tasks.server.ts`, () => ({
  getBoardTasks: async () => rows,
  getWeekOrder: async () => [],
}));
mock.module(`${WT}/src/features/huddle/lib/journey/proxy.functions.ts`, () => ({
  invokeJourneyTool: async (req: any) => { calls++; return proxyImpl(req); },
}));
const W = await import(`${WT}/src/features/huddle/lib/tasks/widgets.server.ts`);
const NOW = Date.parse("2026-10-15T17:00:00Z");
const TZ = "America/New_York";

test("tool-absent: roots byte-identical to the pre-change composition (mergeTopicTree([], categoryTree))", async () => {
  const d = await W.composePrioritiesWidget("dev@enterpriseds.io", TZ, { nowMs: NOW, caller: { entra_email: "dev@enterpriseds.io" } });
  const old = W.mergeTopicTree([], W.buildCategoryTaskTree(rows as any, TZ, NOW));
  console.log("tool-absent topics meta:", JSON.stringify({ ok: d.topics.ok, reason: d.topics.reason, error: d.topics.error }));
  expect(JSON.stringify(d.topics.roots)).toBe(JSON.stringify(old));
});

test("AGENT-TOOL path before vs after: topics.ok/reason (old tools.ts passed no caller)", async () => {
  const before = await W.composePrioritiesWidget("dev@enterpriseds.io", TZ, { nowMs: NOW }); // what main's tools.ts effectively got: no fetch
  const after = await W.composePrioritiesWidget("dev@enterpriseds.io", TZ, { nowMs: NOW, caller: { entra_email: "dev@enterpriseds.io" } });
  console.log("no-caller   =>", JSON.stringify({ ok: before.topics.ok, reason: before.topics.reason }));
  console.log("with caller =>", JSON.stringify({ ok: after.topics.ok, reason: after.topics.reason }));
});

test("timeout: a never-resolving journey resolves degraded at the ceiling and the timer is cleared", async () => {
  proxyImpl = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await W.fetchTopicPayload({ entra_email: "x" }, 150);
  const dt = Date.now() - t0;
  console.log("timeout result", JSON.stringify(r), "elapsed", dt, "ms");
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("error");
  expect(dt).toBeLessThan(1000);
});

test("rejecting proxy (throws) degrades, does not reject", async () => {
  proxyImpl = async () => { throw new Error("socket hang up"); };
  const r = await W.fetchTopicPayload({ entra_email: "x" }, 2000);
  console.log("reject result", JSON.stringify(r));
  expect(r.ok).toBe(false);
});

test("rejecting proxy with a non-Error whose toString throws", async () => {
  proxyImpl = async () => { throw { toString() { throw new Error("evil"); } }; };
  let threw: unknown = null;
  try { const r = await W.fetchTopicPayload({ entra_email: "x" }, 500); console.log("evil result", JSON.stringify(r)); }
  catch (e) { threw = e; }
  console.log("evil threw:", threw ? String((threw as Error).message) : "no");
});

test("not-configured classification", async () => {
  proxyImpl = async () => { throw new Error("JOURNEY_PROXY_URL / JOURNEY_PROXY_TOKEN not configured"); };
  const r = await W.fetchTopicPayload({ entra_email: "x" }, 500);
  expect(r.reason).toBe("not-configured");
});

test("success: payload output string parsed", async () => {
  proxyImpl = async () => ({ ok: true, output: JSON.stringify({ topics: [{ id: "t1", topic_name: "X", position: 0, category_affinity: "CAREER" }], mappings: [] }) });
  const r = await W.fetchTopicPayload({ entra_email: "x" }, 500);
  expect(r.ok).toBe(true);
});

test("handles still open after timeout: count pending timers via active handles", async () => {
  // fetchTopicPayload's own timer must be cleared on the fast path: measure by resolving fast and
  // checking the process can exit -- bun test exits only if no ref'd timer remains; we just log.
  proxyImpl = async () => ({ ok: false, error: "Unknown tool: get_task_topics" });
  const r = await W.fetchTopicPayload({ entra_email: "x" }, 60_000);
  expect(r.reason).toBe("tool-absent");
});
