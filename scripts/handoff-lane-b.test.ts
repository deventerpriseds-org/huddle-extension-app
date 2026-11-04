// WHAT:          Offline suite for Lane B F3 (a LIVE confirm starts THAT task now, owner Option A) and F7 (one request,
//                one task). Drives the REAL liveStartDecision / advanceLiveConfirmedTask / kickLiveConfirm /
//                runScheduledAutoWork / confirmTaskFromProposal with their stores stubbed in memory.
// WHY:           docs/qc-evidence/AC-handoff-confirm-flow.md F3 + F7 (spec on branch claude_ac-handoff-confirm):
//                confirmed tasks sat in BACKLOG until the 9/13/17 pass, and a low-ranked one never reached DOING at
//                all (CF-7). The fail-closed gate must survive the bypass.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-handoff-lane-b.md. Run: bun test scripts/handoff-lane-b.test.ts
// Each check prints `PASS <name>` / `FAIL <name>` so scripts/mutate.sh can attribute a failure.
import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);

let board: any[] = [];
let engagement = new Map<string, any>();
let journeyWrites: any[] = [];
let enqueued: { id: string; huddle: string; payload: any }[] = [];
let required: (agent: string) => Promise<any> = async () => true;
let reminderIds = new Set<string>();
let marks: { taskId: string; via: string }[] = [];
let ownedTask: any = null;
let confirmWrites: string[] = [];
// F7: an in-memory stand-in for tasks.task_create_claims (its real SQL is proven in handoff-lane-b-db.test.ts).
let claims = new Map<string, number>();
let completedTitles: string[] = [];
let claimStoreDown = false;
let releases: string[] = [];

mock.module(P("tasks/tasks.server.ts"), () => ({
  getOpenAssignedTasks: async () => board.filter((t) => t.status !== "DONE" && !t.blocked && t.assigned_agent),
  getBoardTasks: async () => board,
  getTaskBlockers: async () => new Map(),
  setAutoWorkSignature: async () => {},
  getTaskEngagementStates: async (ids: string[]) =>
    new Map(ids.filter((i) => engagement.has(i)).map((i) => [i, engagement.get(i)])),
  getTaskEngagementState: async (id: string) => engagement.get(id) ?? null,
  ensureReviewFlip: async () => {},
  getLatestPendingConfirmAskAt: async () => null,
  ensureConfirmAskAt: async () => {},
  armConfirmReAskAt: async () => true,
  claimApproachRedrive: async () => null,
  releaseApproachRedrive: async () => {},
  escalateApproach: async () => {},
  // The real SQL of these three is proven in scripts/handoff-lane-b-db.test.ts; here they mirror its WHERE clauses.
  markLiveConfirm: async (taskId: string, via: string) => {
    const s = engagement.get(taskId);
    if (!s || s.confirm_status !== "confirmed") return false;
    s.live_start_at = new Date().toISOString();
    s.live_start_via = via;
    s.live_started_at = null;
    marks.push({ taskId, via });
    return true;
  },
  claimLiveStart: async (taskId: string) => {
    const s = engagement.get(taskId);
    if (!s || !s.live_start_at || s.live_started_at || s.confirm_status !== "confirmed") return null;
    s.live_started_at = new Date().toISOString();
    return new Date(s.live_start_at).getTime();
  },
  releaseLiveStart: async (taskId: string) => {
    const s = engagement.get(taskId);
    if (s) s.live_started_at = null;
  },
  getOwnedTaskForConfirmAsk: async () => ownedTask,
  claimTaskCreateTitle: async (email: string, key: string, windowMinutes: number) => {
    if (claimStoreDown) throw new Error("claim store unreachable");
    const k = `${email}|${key}`;
    const at = claims.get(k);
    if (at !== undefined && Date.now() - at < windowMinutes * 60_000) {
      return { claimed: false, claimedAt: new Date(at).toISOString() };
    }
    claims.set(k, Date.now());
    return { claimed: true };
  },
  retakeTaskCreateTitle: async (email: string, key: string) => {
    claims.set(`${email}|${key}`, Date.now());
  },
  releaseTaskCreateTitle: async (email: string, key: string) => {
    releases.push(key);
    claims.delete(`${email}|${key}`);
  },
  getTitlesCompletedSince: async () => completedTitles,
  getTasksForUser: async () => [],
  confirmTaskIntent: async (taskId: string) => {
    confirmWrites.push(taskId);
    const s = engagement.get(taskId) ?? { task_id: taskId };
    s.confirm_status = "confirmed";
    engagement.set(taskId, s);
  },
}));
mock.module(P("journey/identity.ts"), () => ({ resolveTaskEmail: async () => "owner@test" }));
mock.module(P("artifacts/artifacts.server.ts"), () => ({ listArtifacts: async () => [] }));
mock.module(P("tasks/turns.server.ts"), () => ({
  enqueueTurn: async (id: string, huddle: string, _e: string, payload: any) => {
    if (enqueued.some((e) => e.id === id)) return false; // the real store: ON CONFLICT (id) DO NOTHING
    enqueued.push({ id, huddle, payload });
    return true;
  },
  taskIdsInReminderWindow: async () => reminderIds,
  createReminder: async () => {},
}));
mock.module(P("identity/agent-workflow-config.server.ts"), () => ({
  isStructuredWorkflowRequired: (_email: string, agent: string) => required(agent),
  getWorkflowCaps: async () => ({ approach: 3, review: 3, question: 2 }),
}));
mock.module(P("journey/proxy.functions.ts"), () => ({
  invokeJourneyTool: async ({ toolName, args }: any) => {
    journeyWrites.push({ toolName, args });
    if (toolName === "batch_update_tasks") return { ok: true, output: JSON.stringify({ updated: args.updates.length }) };
    return { ok: true, output: "{}" };
  },
}));

const A = await import(`${SRC}/tasks/autowork.server.ts`);
const { confirmTaskFromProposal } = await import(`${SRC}/tasks/confirm-ask.functions.ts`);
const C = await import(`${SRC}/tasks/create-task-core.ts`);

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
}
const T = (id: string, status: string, agent = "finn-reid", extra: any = {}) => ({
  id,
  title: `Test-${id}`,
  status,
  priority: null,
  category: "research",
  is_priority: false,
  priority_rank: null,
  due_date: null,
  completed_at: null,
  assigned_agent: agent,
  tags: [],
  definition_of_done: null,
  ...extra,
});
const live = (extra: any = {}) => ({
  confirm_status: "confirmed",
  approach_status: "approved",
  clarify_status: "none",
  live_start_at: "2026-11-04T10:00:00.000Z",
  live_started_at: null,
  ...extra,
});
const doingWrites = () =>
  journeyWrites.flatMap((w) =>
    w.toolName === "update_task" && w.args.status === "DOING"
      ? [w.args.task_id]
      : w.toolName === "batch_update_tasks"
        ? w.args.updates.filter((u: any) => u.status === "DOING").map((u: any) => u.task_id)
        : [],
  );

beforeEach(() => {
  board = [];
  engagement = new Map();
  journeyWrites = [];
  enqueued = [];
  required = async () => true;
  reminderIds = new Set();
  marks = [];
  ownedTask = null;
  confirmWrites = [];
  claims = new Map();
  completedTitles = [];
  claimStoreDown = false;
  releases = [];
});

// ---------------------------------------------------------------- pure verdict (AC-F3-5, AC-F3-6, AC-F3-10)
test("F3 liveStartDecision table", () => {
  const D = A.liveStartDecision;
  const t = T("x", "BACKLOG");
  check("AC-F3-5 no live marker -> never starts (background caps)", D({ state: live({ live_start_at: null }), task: t, required: true }).start === false);
  check("AC-F3-6(i) live marker + approach pending -> no DOING", D({ state: live({ approach_status: "pending" }), task: t, required: true }).start === false);
  check("AC-F3-6(i') live marker + approach escalated -> no DOING", D({ state: live({ approach_status: "escalated" }), task: t, required: true }).start === false);
  check("AC-F3-6(iii) live marker + confirm_status asked -> no DOING", D({ state: live({ confirm_status: "asked" }), task: t, required: true }).start === false);
  check("AC-F3-6(iii') live marker + confirm_status asked, workflow NOT required -> still no DOING", D({ state: live({ confirm_status: "asked" }), task: t, required: false }).start === false);
  check("AC-F3-6(ii) requirement unknown (undefined/null) counts as REQUIRED", D({ state: live({ approach_status: "pending" }), task: t, required: undefined }).start === false && D({ state: live({ approach_status: "pending" }), task: t, required: null }).start === false);
  check("F3 confirmed + approved + live -> start", D({ state: live(), task: t, required: true }).start === true);
  check("F3 confirmed + live, workflow explicitly not required -> start without an approach", D({ state: live({ approach_status: "pending" }), task: t, required: false }).start === true);
  check("AC-F3-10 reminder-tagged task never starts work", D({ state: live(), task: T("x", "BACKLOG", "finn-reid", { tags: ["reminder"] }), required: true }).start === false);
  check("AC-F3-10 task in its reminder window never starts work", D({ state: live(), task: t, required: true, inReminderWindow: true }).start === false);
  check("F3 parked task never starts", D({ state: live(), task: T("x", "BACKLOG", "finn-reid", { tags: ["parking-lot"] }), required: true }).start === false);
  check("AC-F3-11 already started -> no second start", D({ state: live({ live_started_at: "2026-11-04T10:01:00Z" }), task: t, required: true }).start === false);
  check("F3 already DOING / IN_REVIEW -> no write", ["DOING", "IN_REVIEW", "DONE"].every((s) => D({ state: live(), task: T("x", s), required: true }).start === false));
  check("F3 open clarifying question pauses the start", D({ state: live({ clarify_status: "open" }), task: t, required: true }).start === false);
  check("F3 unassigned / blocked (absent from the open list) -> no start", D({ state: live(), task: null, required: true }).start === false);
  const pend = D({ state: live({ approach_status: "pending" }), task: t, required: true }) as any;
  check("F3 pending approach asks for the approach step; escalated does not", pend.needsApproach === true && (D({ state: live({ approach_status: "escalated" }), task: t, required: true }) as any).needsApproach === false);
  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------- targeted start, Option A (AC-F3-2/3/7/8)
test("F3 targeted live start, past the DOING cap and REVIEW freeze", async () => {
  // finn: 1 DOING, 2 IN_REVIEW (frozen), 3 UP_NEXT, and the live task ranked 10th in BACKLOG.
  board = [
    T("doing-1", "DOING"),
    T("rev-1", "IN_REVIEW"),
    T("rev-2", "IN_REVIEW"),
    T("up-1", "UP_NEXT"),
    T("up-2", "UP_NEXT"),
    T("up-3", "UP_NEXT"),
    ...Array.from({ length: 9 }, (_, i) => T(`bl-${i}`, "BACKLOG")),
    T("live-10th", "BACKLOG"),
  ];
  for (const t of board) engagement.set(t.id, { task_id: t.id, confirm_status: "confirmed", approach_status: "approved" });
  engagement.set("live-10th", { task_id: "live-10th", ...live() });
  const r = await A.advanceLiveConfirmedTask({ taskId: "live-10th", email: "owner@test" });
  check("AC-F3-3/F3-7 the SPECIFIC live task reaches DOING despite DOING=1, REVIEW=2 and rank 10", r.started === true, JSON.stringify(r));
  check("AC-F3-8 ONLY that task's status was written", JSON.stringify(doingWrites()) === JSON.stringify(["live-10th"]) && journeyWrites.length === 1, JSON.stringify(journeyWrites));
  check("AC-F3-2 its work turn is enqueued in the assignee's DM", enqueued.length === 1 && enqueued[0].huddle === "dm-finn-reid" && enqueued[0].id.startsWith("live-work-live-10th-"), JSON.stringify(enqueued.map((e) => e.id)));
  check("AC-F3-8 no confirm ask is sent by a live start", !enqueued.some((e) => /confirm/i.test(e.id)));
  const again = await A.advanceLiveConfirmedTask({ taskId: "live-10th", email: "owner@test" });
  check("AC-F3-11 a second advance (double tap / second approval) starts nothing more", again.started === false && enqueued.length === 1 && journeyWrites.length === 1, JSON.stringify(again));
  expect(failures).toEqual([]);
});

test("F3 fail-closed paths write nothing", async () => {
  board = [T("t1", "BACKLOG")];
  engagement.set("t1", { task_id: "t1", confirm_status: "confirmed", approach_status: "approved", live_start_at: null });
  const r1 = await A.advanceLiveConfirmedTask({ taskId: "t1", email: "owner@test" });
  check("AC-F3-5 a confirmed+approved task WITHOUT the live marker is not started by the live path", r1.started === false && journeyWrites.length === 0 && enqueued.length === 0);
  engagement.set("t1", { task_id: "t1", ...live({ approach_status: "pending" }) });
  required = async () => {
    throw new Error("config read failed");
  };
  const r2 = await A.advanceLiveConfirmedTask({ taskId: "t1", email: "owner@test", approachTurn: true });
  check("AC-F3-6(ii) a requirement read that THROWS counts as required: no DOING", r2.started === false && doingWrites().length === 0, JSON.stringify(r2));
  check("AC-F3-1 the approach step is enqueued instead (same flow, no cadence wait)", r2.approachTurnEnqueued === true && enqueued.length === 1 && enqueued[0].id.startsWith("live-approach-t1-") && enqueued[0].payload.internal === true);
  await A.advanceLiveConfirmedTask({ taskId: "t1", email: "owner@test", approachTurn: true });
  check("AC-F3-11 a retry enqueues no second approach turn", enqueued.length === 1);
  required = async () => true;
  engagement.set("t1", { task_id: "t1", ...live({ approach_status: "pending" }) });
  enqueued = [];
  const r3 = await A.advanceLiveConfirmedTask({ taskId: "t1", email: "owner@test", approachTurn: false });
  check("F3 typed path mid-turn (approachTurn:false) enqueues no approach turn", r3.started === false && enqueued.length === 0);
  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------- background caps unchanged (AC-F3-4)
test("F3 background pass keeps the caps after a live start", async () => {
  // finn already has a LIVE-started DOING task plus 3 ready (confirmed + approved) Up Next items.
  board = [T("live-doing", "DOING"), T("up-1", "UP_NEXT"), T("up-2", "UP_NEXT"), T("up-3", "UP_NEXT"), T("bl-1", "BACKLOG")];
  for (const t of board) engagement.set(t.id, { task_id: t.id, confirm_status: "confirmed", approach_status: "approved" });
  engagement.set("live-doing", { task_id: "live-doing", ...live({ live_started_at: "2026-11-04T10:01:00Z" }) });
  await A.runScheduledAutoWork({ entra_email: "owner@test" }, { force: true });
  check("AC-F3-4 a cadence pass makes 0 new DOING promotions for an agent with a live-started DOING", doingWrites().length === 0, JSON.stringify(doingWrites()));
  const upNextWrites = journeyWrites.flatMap((w) => (w.toolName === "batch_update_tasks" ? w.args.updates.filter((u: any) => u.status === "UP_NEXT") : []));
  check("AC-F3-4 UP_NEXT stays capped at 3 (no top-up past the cap)", upNextWrites.length === 0, JSON.stringify(upNextWrites));
  // And with 2 already DOING (one live-started), the pass still promotes nothing.
  journeyWrites = [];
  board = [T("live-doing", "DOING"), T("doing-2", "DOING"), T("up-1", "UP_NEXT")];
  await A.runScheduledAutoWork({ entra_email: "owner@test" }, { force: true });
  check("AC-F3-4 two DOING (one live) -> still 0 promotions", doingWrites().length === 0);
  // CONTROL: the same harness DOES see a promotion when the DOING slot is free, so the zeros above are real.
  journeyWrites = [];
  board = [T("up-1", "UP_NEXT"), T("up-2", "UP_NEXT")];
  await A.runScheduledAutoWork({ entra_email: "owner@test" }, { force: true });
  check("AC-F3-4 control: a free DOING slot IS promoted by the pass (exactly 1)", doingWrites().length === 1, JSON.stringify(doingWrites()));
  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------- the one kick point (AC-F3-9/10/11)
test("F3 confirmTaskFromProposal is the live kick for button and voice", async () => {
  board = [T("btn", "BACKLOG")];
  ownedTask = { id: "btn", title: "Test-btn", status: "BACKLOG", tags: [], confirm_status: "asked", proposed_dod: "Test- DoD", proposed_reminder_at: null, assigned_agent: "finn-reid" };
  engagement.set("btn", { task_id: "btn", confirm_status: "asked", approach_status: "pending" });
  const r = await confirmTaskFromProposal({ caller: { entra_email: "owner@test" }, taskId: "btn", email: "owner@test" });
  await new Promise((res) => setTimeout(res, 20)); // the advance runs in the background (AC-F3-15)
  check("AC-F3-9 a button confirm records the live marker via kickLiveConfirm", r.ok === true && marks.length === 1 && marks[0].via === "button", JSON.stringify({ r, marks }));
  check("AC-F3-1 a button confirm enqueues the approach step at once", enqueued.some((e) => e.id.startsWith("live-approach-btn-")), JSON.stringify(enqueued.map((e) => e.id)));
  ownedTask = { ...ownedTask, confirm_status: "confirmed" };
  const again = await confirmTaskFromProposal({ caller: { entra_email: "owner@test" }, taskId: "btn", email: "owner@test" });
  await new Promise((res) => setTimeout(res, 20));
  check("AC-F3-11 a double tap (alreadyDone) re-marks nothing and enqueues nothing", again.alreadyDone === true && marks.length === 1 && enqueued.filter((e) => e.id.startsWith("live-approach-btn-")).length === 1);

  marks = [];
  enqueued = [];
  board = [T("rem", "UP_NEXT", "finn-reid", { tags: ["reminder"] })];
  ownedTask = { id: "rem", title: "Test-rem", status: "UP_NEXT", tags: ["reminder"], confirm_status: "asked", proposed_dod: "Test- remind", proposed_reminder_at: new Date(Date.now() + 86_400_000).toISOString(), assigned_agent: "finn-reid" };
  engagement.set("rem", { task_id: "rem", confirm_status: "asked" });
  await confirmTaskFromProposal({ caller: { entra_email: "owner@test" }, taskId: "rem", email: "owner@test" });
  await new Promise((res) => setTimeout(res, 20));
  check("AC-F3-10 a REMIND confirm starts no work: no live marker, no turn, no DOING", marks.length === 0 && enqueued.length === 0 && doingWrites().length === 0, JSON.stringify({ marks, enqueued }));

  marks = [];
  ownedTask = { id: "v", title: "Test-v", status: "BACKLOG", tags: [], confirm_status: "asked", proposed_dod: "Test- DoD", proposed_reminder_at: null, assigned_agent: "finn-reid" };
  engagement.set("v", { task_id: "v", confirm_status: "asked" });
  await confirmTaskFromProposal({ caller: { entra_email: "owner@test" }, taskId: "v", email: "owner@test", via: "voice" });
  check("F3 a voice confirm is recorded as via=voice", marks.length === 1 && marks[0].via === "voice");
  expect(failures).toEqual([]);
});

test("F3 kickLiveConfirm never marks an unconfirmed row", async () => {
  engagement.set("u", { task_id: "u", confirm_status: "asked" });
  const r = await A.kickLiveConfirm({ taskId: "u", email: "owner@test", via: "typed", approachTurn: true });
  check("AC-F3-6 the live marker can only exist on a confirmed row", r.marked === false && marks.length === 0 && enqueued.length === 0);
  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------- wiring (source checks)
test("F3 wiring", () => {
  const hf = readFileSync(`${SRC}/huddle.functions.ts`, "utf8");
  const ag = readFileSync(`${SRC}/tasks/approach-gate.server.ts`, "utf8");
  const ca = readFileSync(`${SRC}/tasks/confirm-ask.functions.ts`, "utf8");
  const rt = readFileSync(`${SRC}/voice/realtime-tools.server.ts`, "utf8");
  check("AC-F3-5 an INTERNAL turn's confirm_task_intent never records a live confirmation", /const recordLiveTypedConfirm = async \(taskId: string, email: string\) => \{\s*if \(data\.internal\) return;/.test(hf));
  check("AC-F4-11 BOTH confirm_task_intent handlers record a typed live confirm", (hf.match(/await confirmTaskIntent\(taskId, email, dod\);\s*await recordLiveTypedConfirm\(taskId, email\);/g) ?? []).length === 2);
  check("F3 every turn exit advances typed live confirms (approach step if the agent skipped it)", (hf.match(/await advanceLiveConfirmedTasks\(\);/g) ?? []).length === 3);
  check("AC-F3-2 the shared approach gate starts a live task on a PASS", /approveApproach\(opts\.taskId, opts\.email, opts\.approach\)[\s\S]{0,700}advanceLiveConfirmedTask\(\{ taskId: opts\.taskId, email: opts\.email \}\)/.test(ag));
  check("AC-F3-14 an owner override starts a live task", /if \(!applied\) return \{ ok: true, alreadyDone: true, taskId, title: task\.title \};[\s\S]{0,500}advanceLiveConfirmedTask\(\{ taskId, email \}\)/.test(ca));
  check("F3 voice confirms are tagged via=voice", /via: "voice"/.test(rt));
  // AC-F3-9: no new DOING writer outside the promoter (autowork.server.ts).
  const writers = ["huddle.functions.ts", "tasks/confirm-ask.functions.ts", "tasks/approach-gate.server.ts", "tasks/tasks.server.ts", "voice/realtime-tools.server.ts"].filter((f) =>
    /status:\s*"DOING"/.test(readFileSync(`${SRC}/${f}`, "utf8")),
  );
  check("AC-F3-9 no DOING writer outside autowork.server.ts in the files this lane touched", writers.length === 0, writers.join(","));
  expect(failures).toEqual([]);
});

// ================================================================================================ F7
const CALLER = { entra_email: "owner@test" };
const freshTurn = () => ({
  ledger: new Set<string>(), // per-turn ledger: a different turn never sees it
  loadTitles: async () => ({ titles: new Set<string>(), unavailable: null }), // stale mirror: not synced yet
  claim: (k: string) => C.claimCreateTitle(CALLER, k),
});

test("F7 one request never creates the same task twice", async () => {
  const title = "Test-Obtain official transcript";
  const t1 = await C.screenRawJourneyCreate("quick_create_task", { title }, freshTurn());
  const t2 = await C.screenRawJourneyCreate("quick_create_task", { title: "test-obtain  official transcript." }, freshTurn());
  check("AC-F7-1 two identical requests minutes apart (stale mirror both times) -> 1 create", t1.action === "forward" && t2.action === "skip", JSON.stringify([t1.action, t2.action]));
  claims = new Map();
  const race = await Promise.all([1, 2, 3].map(() => C.screenRawJourneyCreate("quick_create_task", { title }, freshTurn())));
  check("AC-F7-2 three CONCURRENT turns (user + follow-up + worker) -> exactly 1 forwards", race.filter((d) => d.action === "forward").length === 1, JSON.stringify(race.map((d) => d.action)));
  claims = new Map();
  const single = C.claimCreateTitle(CALLER, C.normalizeTaskTitle(title));
  const raw = C.screenRawJourneyCreate("quick_create_task", { title }, freshTurn());
  const [a, b] = await Promise.all([single, raw]);
  check("AC-F7-3/F7-9 create_huddle_task's claim and a raw create collide on the SAME key", (a.ok ? 1 : 0) + (b.action === "forward" ? 1 : 0) === 1);
  claims = new Map();
  const d1 = await C.screenRawJourneyCreate("quick_create_task", { title: "Test-buy studio camera bag" }, freshTurn());
  const d2 = await C.screenRawJourneyCreate("quick_create_task", { title: "Test-buy studio camera" }, freshTurn());
  check("AC-F7-5 distinct titles are NOT merged", d1.action === "forward" && d2.action === "forward");
  completedTitles = ["Test-buy studio camera"];
  const d3 = await C.screenRawJourneyCreate("quick_create_task", { title: "Test-buy studio camera" }, freshTurn());
  check("AC-F7-6 a task finished since the claim never blocks a re-create", d3.action === "forward");
  completedTitles = [];
  claimStoreDown = true;
  const d4 = await C.screenRawJourneyCreate("quick_create_task", { title: "Test-claim store down" }, freshTurn());
  check("AC-F7-7 claim store down -> the create proceeds AND says dedup unavailable", d4.action === "forward" && !!d4.dedupUnavailable, JSON.stringify(d4));
  claimStoreDown = false;
  claims = new Map();
  const b1 = await C.screenRawJourneyCreate("parse_and_create_tasks", { tasks: ["Test-A", "Test-B"] }, freshTurn());
  const b2 = await C.screenRawJourneyCreate("parse_and_create_tasks", { tasks: ["Test-B", "Test-C"] }, freshTurn());
  check("F7 a second batch forwards only its new entry", b2.action === "forward" && JSON.stringify((b2 as any).args.tasks) === JSON.stringify(["Test-C"]) && b1.action === "forward");
  check("F7 a forwarded create reports the keys it claimed", b1.action === "forward" && (b1 as any).claimedKeys.length === 2);
  await C.releaseRawCreateClaims(CALLER, b1);
  const b3 = await C.screenRawJourneyCreate("quick_create_task", { title: "Test-A" }, freshTurn());
  check("F7 a FAILED create's claims are released, so the retry is not called a duplicate", releases.length === 2 && b3.action === "forward");
  const noCaller = await C.claimCreateTitle(undefined, "x");
  check("F7 no caller identity (no board write follows) claims nothing", noCaller.ok === true && !claims.has("undefined|x"));
  expect(failures).toEqual([]);
});

test("F7 wiring: every create path takes the claim and releases it on failure", () => {
  const hf = readFileSync(`${SRC}/huddle.functions.ts`, "utf8");
  const rt = readFileSync(`${SRC}/voice/realtime-tools.server.ts`, "utf8");
  const core = readFileSync(`${SRC}/tasks/create-task-core.ts`, "utf8");
  check("AC-F7-9 text raw-create guard + produce path pass the claim", (hf.match(/claim: \(k\) => claimCreateTitle\(data\.caller, k\)/g) ?? []).length === 2);
  check("AC-F7-9 voice raw-create router passes the claim", /claim: \(k\) => claimCreateTitle\(ctx\.caller, k\)/.test(rt));
  check("AC-F7-2 create_huddle_task claims before the journey write", /const claim = await claimCreateTitle\(data\.caller, titleKey\);\s*if \(!claim\.ok\)/.test(hf));
  check("AC-F7-2 create_huddle_tasks claims per survivor", /const c = await claimCreateTitle\(data\.caller, key\);/.test(hf));
  check("AC-F7-2 voice create_huddle_task(s) claims per survivor", /const claim = await claimCreateTitle\(ctx\.caller, key\);/.test(rt));
  check("F7 failed creates release (text single, batch x2, raw x2, produce)", (hf.match(/releaseCreateTitle\(data\.caller, titleKey\)/g) ?? []).length === 1 && (hf.match(/await releaseBatchClaims\(\);/g) ?? []).length === 2 && (hf.match(/releaseRawCreateClaims\(data\.caller, (dedup\.decision|dedup)\)/g) ?? []).length === 3);
  check("AC-F7-9 still ONE normalizer definition", (core.match(/function normalizeTaskTitle/g) ?? []).length === 0 && (readFileSync(`${SRC}/tasks/scoring.ts`, "utf8").match(/export function normalizeTaskTitle/g) ?? []).length === 1);
  expect(failures).toEqual([]);
});
