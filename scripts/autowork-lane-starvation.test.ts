// WHAT:  Runs the REAL runScheduledAutoWork against a fake board: which Up Next item reaches DOING, what the pass
//        ARMS on the confirm-ask spacing chain, and the approach re-drive. Section A (+ AC-34/35/36) of
//        .claude/AC-confirm-ask-rotation.md.
// WHY:   Live board (2026-10-20) couldn't isolate it — no agent had an approved item behind an asked one. The
//        claim was: an unanswered confirm-ask at the top of an agent's Up Next blocks that agent's Doing slot even
//        when a lower item is fully confirmed + approach-approved.
// EVIDENCE: control case B proves the harness detects a promotion, so a zero elsewhere is real.
// STATUS:  2026-10-20 this file CHARACTERIZED the defect (case A expected 0 promotions, 2/2 pass). 2026-10-27 the
//          lane fix landed and case A is FLIPPED: the approved item behind the asked one IS promoted (AC-1). Case A
//          is the guard for that fix — mutation-proved, see .claude/IMPL-confirm-ask-rotation.md.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. Run: bun test scripts/autowork-lane-starvation.test.ts
// Failing tests also print `FAIL <name>` (bun prints "(fail)"), so scripts/mutate.sh can attribute them.
import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);

let board: any[] = [];
let engagement = new Map<string, any>();
let promotions: any[] = [];
let enqueued: { id: string; payload: any }[] = [];
let armedFirst: string[] = [];
let armedReask: string[] = [];
let escalated: string[] = [];
let stateReads = 0;
let reminderIds = new Set<string>();
let required: (agent: string) => Promise<any> = async () => true; // live config: default_required = true

mock.module(P("tasks/tasks.server.ts"), () => ({
  getOpenAssignedTasks: async () => board, // already in scorer order (index 0 = top)
  getBoardTasks: async () => board,
  getTaskBlockers: async () => new Map(),
  setAutoWorkSignature: async () => {},
  getTaskEngagementStates: async (ids: string[]) => {
    stateReads++;
    return new Map(ids.filter((i) => engagement.has(i)).map((i) => [i, engagement.get(i)]));
  },
  ensureReviewFlip: async () => {},
  getLatestPendingConfirmAskAt: async () => null,
  ensureConfirmAskAt: async (id: string) => {
    armedFirst.push(id);
  },
  armConfirmReAskAt: async (id: string) => {
    armedReask.push(id);
    return true;
  },
  claimApproachRedrive: async (id: string, n: number) => {
    const s = engagement.get(id);
    if (!s || s.approach_redrive_count !== n && !(s.approach_redrive_count === undefined && n === 0)) return null;
    s.approach_redrive_count = n + 1;
    return n + 1;
  },
  releaseApproachRedrive: async () => {},
  escalateApproach: async (id: string) => {
    escalated.push(id);
  },
}));
mock.module(P("journey/identity.ts"), () => ({ resolveTaskEmail: async () => "owner@test" }));
mock.module(P("artifacts/artifacts.server.ts"), () => ({ listArtifacts: async () => [] }));
mock.module(P("tasks/turns.server.ts"), () => ({
  enqueueTurn: async (id: string, _h: string, _e: string, payload: any) => {
    enqueued.push({ id, payload });
    return true;
  },
  taskIdsInReminderWindow: async () => reminderIds,
}));
mock.module(P("identity/agent-workflow-config.server.ts"), () => ({
  isStructuredWorkflowRequired: (_email: string, agent: string) => required(agent),
  getWorkflowCaps: async () => ({ approach: 3, review: 3, question: 2 }),
}));
mock.module(P("journey/proxy.functions.ts"), () => ({
  invokeJourneyTool: async ({ args }: any) => {
    promotions.push(...args.updates);
    return { ok: true, output: JSON.stringify({ updated: args.updates.length }) };
  },
}));

const { runScheduledAutoWork } = await import(`${SRC}/tasks/autowork.server.ts`);

const task = (id: string, status = "UP_NEXT", agent = "tess-sutton", tags: string[] = []) => ({
  id, title: id, status, assigned_agent: agent, tags, completed_at: null,
  category: null, priority: "MEDIUM", is_priority: false, priority_rank: null, due_date: null,
});
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ASKED = () => ({ confirm_status: "asked", confirm_ask_at: "2026-08-01T00:00:00Z", confirm_last_sent_at: "2026-08-01T00:00:00Z", confirm_ask_count: 1, approach_status: "pending", clarify_status: "none" });
const READY = () => ({ confirm_status: "confirmed", confirm_ask_at: null, approach_status: "approved", clarify_status: "none" });
const AWAITING = () => ({ confirm_status: "awaiting", confirm_ask_at: null, approach_status: "pending", clarify_status: "none" });
const PENDING_APPROACH = () => ({ confirm_status: "confirmed", confirmed_at: ago(2 * DAY), approach_status: "pending", approach_redrive_count: 0, approach_redrive_last_at: null, clarify_status: "none" });

const run = (opts: any = { force: true }) => runScheduledAutoWork({ entra_email: "owner@test" }, opts);
const doing = () => promotions.filter((p) => p.status === "DOING").map((p) => p.task_id);
const research = () => enqueued.filter((e) => !e.id.startsWith("autowork-approach-")); // research turns only

/** AC-17 on every case: automation only ever writes UP_NEXT or DOING — never DONE/BACKLOG/IN_REVIEW, never tags. */
function assertNoShelving() {
  for (const p of promotions) {
    expect(["UP_NEXT", "DOING"]).toContain(p.status);
    expect(p.tags).toBeUndefined();
  }
}

/** bun prints "(fail) name"; mutate.sh needs "FAIL name" on a line. */
function t(name: string, fn: () => Promise<void>) {
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      console.log(`FAIL ${name}`);
      throw e;
    }
  });
}

beforeEach(() => {
  promotions = [];
  enqueued = [];
  armedFirst = [];
  armedReask = [];
  escalated = [];
  stateReads = 0;
  engagement = new Map();
  reminderIds = new Set();
  required = async () => true;
});

t("A: asked item on top -> the approved item behind it IS started (AC-1, flipped)", async () => {
  board = [task("asked-top"), task("ready-second")];
  engagement.set("asked-top", ASKED());
  engagement.set("ready-second", READY());
  const r = await run();
  console.log("A result:", JSON.stringify({ promoted: r.promoted, enqueued: r.enqueued, promotions }));
  expect(promotions.filter((p) => p.status === "DOING")).toEqual([{ task_id: "ready-second", status: "DOING" }]);
  expect(enqueued.map((e) => e.id).filter((id) => id.includes("ready-second"))).toHaveLength(1);
  expect(enqueued).toHaveLength(1);
  expect(promotions.some((p) => p.task_id === "asked-top")).toBe(false);
  assertNoShelving();
});

t("B (control): same two items, approved one on top -> it IS started (AC-2)", async () => {
  board = [task("ready-second"), task("asked-top")];
  engagement.set("asked-top", ASKED());
  engagement.set("ready-second", READY());
  const r = await run();
  console.log("B result:", JSON.stringify({ promoted: r.promoted, enqueued: r.enqueued, promotions }));
  expect(promotions).toContainEqual({ task_id: "ready-second", status: "DOING" });
  expect(enqueued.length).toBe(1);
  assertNoShelving();
});

t("AC-3 lane [asked, asked, ready] -> the 3rd is promoted and enqueued", async () => {
  board = [task("a1"), task("a2"), task("r3")];
  engagement.set("a1", ASKED());
  engagement.set("a2", ASKED());
  engagement.set("r3", READY());
  await run();
  expect(doing()).toEqual(["r3"]);
  expect(enqueued.map((e) => e.id).some((id) => id.endsWith("-r3"))).toBe(true);
  assertNoShelving();
});

t("AC-4 lane [ready-1, ready-2] -> only ready-1 (DOING writes per agent = 1)", async () => {
  board = [task("ready-1"), task("ready-2")];
  engagement.set("ready-1", READY());
  engagement.set("ready-2", READY());
  await run();
  expect(doing()).toEqual(["ready-1"]);
  assertNoShelving();
});

t("AC-5 agent already has 1 DOING -> no UP_NEXT item promoted", async () => {
  board = [task("busy", "DOING"), task("ready-up")];
  engagement.set("busy", READY());
  engagement.set("ready-up", READY());
  await run();
  expect(doing()).toEqual([]);
  assertNoShelving();
});

t("AC-6 2 IN_REVIEW -> no promotion, no research turn; asks STILL armed (owner 2026-10-27, no review-frozen pause)", async () => {
  board = [task("rev1", "IN_REVIEW"), task("rev2", "IN_REVIEW"), task("ready-up"), task("fresh"), task("backlog-1", "BACKLOG")];
  engagement.set("ready-up", READY());
  engagement.set("fresh", AWAITING());
  await run();
  expect(promotions).toEqual([]); // no DOING and no BACKLOG->UP_NEXT top-up while frozen
  expect(research()).toHaveLength(0);
  expect(armedFirst).toEqual(["fresh"]);
  assertNoShelving();
});

t("AC-7 lane [confirmed+approach pending, ready] -> ready promoted, pending not (it gets an approach re-drive instead)", async () => {
  board = [task("pend"), task("ready")];
  engagement.set("pend", PENDING_APPROACH());
  engagement.set("ready", READY());
  await run();
  expect(doing()).toEqual(["ready"]);
  expect(enqueued.some((e) => e.id.startsWith("autowork-approach-pend-"))).toBe(true);
  assertNoShelving();
});

t("AC-8 lane [escalated, ready] -> ready promoted; escalated neither promoted, asked, nor re-driven (AC-36)", async () => {
  board = [task("esc"), task("ready")];
  engagement.set("esc", { ...PENDING_APPROACH(), approach_status: "escalated" });
  engagement.set("ready", READY());
  await run();
  expect(doing()).toEqual(["ready"]);
  expect(enqueued.some((e) => e.id.includes("esc"))).toBe(false);
  expect([...armedFirst, ...armedReask]).not.toContain("esc");
  expect(escalated).toEqual([]);
  assertNoShelving();
});

t("AC-9 lane [ready but clarify open, ready-2] -> ready-2 promoted; the clarify-open item gets no promotion and no turn", async () => {
  board = [task("clar"), task("ready-2")];
  engagement.set("clar", { ...READY(), clarify_status: "open" });
  engagement.set("ready-2", READY());
  await run();
  expect(doing()).toEqual(["ready-2"]);
  expect(enqueued.some((e) => e.id.includes("clar"))).toBe(false);
  assertNoShelving();
});

t("AC-10 every lane item asked -> 0 DOING, 0 research turns", async () => {
  board = [task("x1"), task("x2"), task("x3")];
  for (const id of ["x1", "x2", "x3"]) engagement.set(id, ASKED());
  await run();
  expect(doing()).toEqual([]);
  expect(research()).toHaveLength(0);
  assertNoShelving();
});

t("AC-11 12-item lane, only #9 ready -> #9 IS promoted", async () => {
  board = Array.from({ length: 12 }, (_, i) => task(`l${i + 1}`));
  for (let i = 1; i <= 12; i++) engagement.set(`l${i}`, i === 9 ? READY() : ASKED());
  await run();
  expect(doing()).toEqual(["l9"]);
  assertNoShelving();
});

t("AC-12 12-item lane -> no demote/park/retag, no UP_NEXT top-up (room 0)", async () => {
  board = [...Array.from({ length: 12 }, (_, i) => task(`l${i + 1}`)), task("bk", "BACKLOG")];
  for (let i = 1; i <= 12; i++) engagement.set(`l${i}`, ASKED());
  await run();
  expect(promotions.filter((p) => p.status === "UP_NEXT")).toEqual([]);
  expect(promotions.every((p) => p.status === "DOING")).toBe(true);
  assertNoShelving();
});

t("AC-12b whole-lane rotation: a 12-item never-asked lane arms a FIRST ask for every item, in lane order", async () => {
  board = Array.from({ length: 12 }, (_, i) => task(`n${i + 1}`));
  await run();
  expect(armedFirst).toEqual(Array.from({ length: 12 }, (_, i) => `n${i + 1}`));
});

t("AC-13 gate resolver REJECTS -> 0 promotions, 0 research, the pass resolves", async () => {
  required = async () => {
    throw new Error("config pool down");
  };
  board = [task("asked"), task("awaiting"), task("pend")];
  engagement.set("asked", ASKED());
  engagement.set("awaiting", AWAITING());
  engagement.set("pend", { ...PENDING_APPROACH(), approach_redrive_count: 3 });
  const r = await run();
  expect(r.ok).toBe(true);
  expect(doing()).toEqual([]);
  expect(research()).toHaveLength(0);
  assertNoShelving();
});

t("AC-13b agent ABSENT from the requirement map (resolver yields undefined) -> treated as REQUIRED", async () => {
  required = async () => undefined;
  board = [task("asked"), task("awaiting")];
  engagement.set("asked", ASKED());
  engagement.set("awaiting", AWAITING());
  await run();
  expect(doing()).toEqual([]);
  expect(research()).toHaveLength(0);
});

t("AC-14 a task already in DOING with confirm 'asked' (reached DOING unconfirmed) is NOT enqueued and NOT demoted", async () => {
  board = [task("raced", "DOING"), task("up1")];
  engagement.set("raced", ASKED());
  engagement.set("up1", READY());
  await run();
  expect(enqueued.some((e) => e.id.includes("raced") && !e.id.startsWith("autowork-approach-"))).toBe(false);
  expect(promotions.some((p) => p.task_id === "raced")).toBe(false);
  assertNoShelving();
});

t("AC-15 parking-lot and reminder-window items are never promoted, armed, or re-armed", async () => {
  board = [task("parked", "UP_NEXT", "tess-sutton", ["parking-lot"]), task("remind"), task("asked-old")];
  engagement.set("parked", READY());
  engagement.set("remind", READY());
  engagement.set("asked-old", ASKED());
  reminderIds = new Set(["remind"]);
  await run();
  expect(doing()).toEqual([]);
  expect([...armedFirst, ...armedReask]).not.toContain("parked");
  expect([...armedFirst, ...armedReask]).not.toContain("remind");
  expect(armedReask).toEqual(["asked-old"]);
});

t("AC-16 promoteOnly with a READY item -> only UP_NEXT promotions, nothing enqueued", async () => {
  board = [task("ready-up"), task("bk", "BACKLOG")];
  engagement.set("ready-up", READY());
  await run({ force: true, promoteOnly: true });
  expect(promotions.every((p) => p.status === "UP_NEXT")).toBe(true);
  expect(enqueued).toEqual([]);
});

t("AC-18 WIP caps unchanged (3/1/2)", async () => {
  const src = readFileSync(`${SRC}/tasks/autowork.server.ts`, "utf8");
  expect(src).toContain("const UP_NEXT_CAP = 3;");
  expect(src).toContain("const DOING_CAP = 1;");
  expect(src).toContain("const REVIEW_CAP = 2;");
});

t("AC-19 engagement state is read ONCE per pass, covering every agent's lane", async () => {
  board = [task("t1"), task("t2"), task("c1", "UP_NEXT", "cole-blake"), task("c2", "DOING", "cole-blake")];
  await run();
  expect(stateReads).toBe(1);
});

t("AC-24/26 re-ask rotation in the pass: one armed re-ask per agent, the least-recently-SENT, never while it has a pending ask", async () => {
  board = [task("A"), task("C"), task("X", "UP_NEXT", "cole-blake"), task("Y", "UP_NEXT", "cole-blake")];
  engagement.set("A", { ...ASKED(), confirm_last_sent_at: ago(2 * DAY), confirm_ask_at: ago(2 * DAY) });
  engagement.set("C", { ...ASKED(), confirm_last_sent_at: ago(3 * DAY), confirm_ask_at: ago(3 * DAY) });
  // cole has a re-ask already armed and unsent on X -> nothing new for cole
  engagement.set("X", { ...ASKED(), confirm_last_sent_at: ago(3 * DAY), confirm_ask_at: new Date(Date.now() + 3600_000).toISOString() });
  engagement.set("Y", { ...ASKED(), confirm_last_sent_at: ago(5 * DAY), confirm_ask_at: ago(5 * DAY) });
  await run();
  expect(armedReask).toEqual(["C"]);
});

t("AC-20 floor: an item last sent < 24h ago is NOT re-armed", async () => {
  board = [task("recent")];
  engagement.set("recent", { ...ASKED(), confirm_last_sent_at: ago(23 * 3600_000), confirm_ask_at: ago(23 * 3600_000) });
  await run();
  expect(armedReask).toEqual([]);
});

t("AC-34 confirmed + approach pending -> internal propose_approach turn; DoD not re-asked; nothing promoted", async () => {
  board = [task("pend")];
  engagement.set("pend", PENDING_APPROACH());
  await run();
  const e = enqueued.find((x) => x.id.startsWith("autowork-approach-pend-"));
  expect(e).toBeTruthy();
  expect(e!.payload.text).toContain("propose_approach");
  expect(e!.payload.text).toContain('task_id "pend"');
  expect(e!.payload.text).toContain("Do NOT ask the user to re-confirm");
  expect(e!.payload.internal).toBe(true);
  expect(e!.payload.notify).toBe("batch");
  expect(engagement.get("pend").confirm_status).toBe("confirmed");
  expect(doing()).toEqual([]);
  expect([...armedFirst, ...armedReask]).not.toContain("pend");
});

t("AC-35 re-drive cap reached (WorkflowCaps.approach) -> no further re-drive; it escalates", async () => {
  board = [task("pend")];
  engagement.set("pend", { ...PENDING_APPROACH(), approach_redrive_count: 3 });
  await run();
  expect(enqueued.some((e) => e.id.startsWith("autowork-approach-"))).toBe(false);
  expect(escalated).toEqual(["pend"]);
  const src = readFileSync(`${SRC}/tasks/autowork.server.ts`, "utf8");
  expect(src).toContain("n >= caps.approach");
});

t("AC-35b cap spent but the last nudge was inside the 24h floor -> NOT escalated yet (floor before cap)", async () => {
  // VERIFY-confirm-ask-rotation-3 (R3): AC-35 starts past the floor, so it passed with the cap checked first too —
  // which escalated to the owner up to a day early. This case pins the order.
  board = [task("pend")];
  engagement.set("pend", { ...PENDING_APPROACH(), approach_redrive_count: 3, approach_redrive_last_at: ago(3600_000) });
  await run();
  expect(escalated).toEqual([]);
  expect(enqueued.some((e) => e.id.startsWith("autowork-approach-"))).toBe(false);
});

t("AC-34b a re-drive is not repeated inside the per-item floor", async () => {
  board = [task("pend")];
  engagement.set("pend", { ...PENDING_APPROACH(), approach_redrive_count: 1, approach_redrive_last_at: ago(3600_000) });
  await run();
  expect(enqueued.some((e) => e.id.startsWith("autowork-approach-"))).toBe(false);
});
