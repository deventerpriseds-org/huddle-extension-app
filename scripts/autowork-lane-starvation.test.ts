// WHAT:  Runs the REAL runScheduledAutoWork against a fake board to isolate one claim:
//        an unanswered confirm-ask at the top of an agent's Up Next blocks that agent's Doing slot,
//        even when a lower Up Next item is fully confirmed + approach-approved.
// WHY:   Live board (2026-10-20) can't isolate it — no agent has an approved item behind an asked one.
// EVIDENCE: control case B proves the harness detects a promotion, so case A's zero is real.
// STATUS:  CHARACTERIZES CURRENT (defective) behaviour, measured 2026-10-20 (2/2 pass). When the lane
//          fix lands, case A must flip to expect the approved item promoted — this file is its guard.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. Run: bun test scripts/autowork-lane-starvation.test.ts
import { test, expect, mock, beforeEach } from "bun:test";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);

let board: any[] = [];
let engagement = new Map<string, any>();
let promotions: any[] = [];
let enqueued: string[] = [];

mock.module(P("tasks/tasks.server.ts"), () => ({
  getOpenAssignedTasks: async () => board, // already in scorer order (index 0 = top)
  getBoardTasks: async () => board,
  getTaskBlockers: async () => new Map(),
  setAutoWorkSignature: async () => {},
  getTaskEngagementStates: async (ids: string[]) =>
    new Map(ids.filter((i) => engagement.has(i)).map((i) => [i, engagement.get(i)])),
  markConfirmAsked: async () => true,
  ensureReviewFlip: async () => {},
  getLatestPendingConfirmAskAt: async () => null,
  ensureConfirmAskAt: async () => {},
}));
mock.module(P("journey/identity.ts"), () => ({ resolveTaskEmail: async () => "owner@test" }));
mock.module(P("artifacts/artifacts.server.ts"), () => ({ listArtifacts: async () => [] }));
mock.module(P("tasks/turns.server.ts"), () => ({
  enqueueTurn: async (id: string) => { enqueued.push(id); return true; },
  taskIdsInReminderWindow: async () => new Set(),
}));
mock.module(P("identity/agent-workflow-config.server.ts"), () => ({
  isStructuredWorkflowRequired: async () => true, // live config: default_required = true
}));
mock.module(P("journey/proxy.functions.ts"), () => ({
  invokeJourneyTool: async ({ args }: any) => {
    promotions.push(...args.updates);
    return { ok: true, output: JSON.stringify({ updated: args.updates.length }) };
  },
}));

const { runScheduledAutoWork } = await import(`${SRC}/tasks/autowork.server.ts`);

const task = (id: string) => ({
  id, title: id, status: "UP_NEXT", assigned_agent: "tess-sutton", tags: [], completed_at: null,
  category: null, priority: "MEDIUM", is_priority: false, priority_rank: null, due_date: null,
});
const ASKED = { confirm_status: "asked", confirm_ask_at: "2026-08-01T00:00:00Z", approach_status: "pending", clarify_status: "none" };
const READY = { confirm_status: "confirmed", confirm_ask_at: null, approach_status: "approved", clarify_status: "none" };

beforeEach(() => { promotions = []; enqueued = []; engagement = new Map(); });

test("A: asked item on top -> approved item behind it is never started", async () => {
  board = [task("asked-top"), task("ready-second")];
  engagement.set("asked-top", ASKED);
  engagement.set("ready-second", READY);
  const r = await runScheduledAutoWork({ entra_email: "owner@test" }, { force: true });
  console.log("A result:", JSON.stringify({ promoted: r.promoted, enqueued: r.enqueued, promotions }));
  expect(promotions.filter((p) => p.status === "DOING")).toHaveLength(0);
  expect(enqueued).toHaveLength(0);
});

test("B (control): same two items, approved one on top -> it IS started", async () => {
  board = [task("ready-second"), task("asked-top")];
  engagement.set("asked-top", ASKED);
  engagement.set("ready-second", READY);
  const r = await runScheduledAutoWork({ entra_email: "owner@test" }, { force: true });
  console.log("B result:", JSON.stringify({ promoted: r.promoted, enqueued: r.enqueued, promotions }));
  expect(promotions).toContainEqual({ task_id: "ready-second", status: "DOING" });
  expect(enqueued.length).toBe(1);
});
