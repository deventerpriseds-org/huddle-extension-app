// WHAT:          Simulated-clock proof of the confirm-ask RE-ASK loop: the REAL runScheduledAutoWork (arming) and
//                the REAL fireDueConfirmAsks (sending), ticked minute by minute over days against a stateful
//                in-memory store that mirrors tasks.server.ts's SQL semantics (ARMED_UNSENT_SQL, the send CAS,
//                set-once arming). Covers .claude/AC-confirm-ask-rotation.md section B and the kept section-C
//                spacing/window/flood properties (AC-41/42/44) against the EXISTING chain.
// WHY:           Owner, 2026-10-27: "keep re-asking, but in a loop moving to the next item in the lane". Live: 35
//                unanswered asks across 10 agents, oldest 2026-08-10, none ever re-asked (no re-ask path existed;
//                and a second ask through the heartbeat reused `autowork-confirm-${task_id}`, which ON CONFLICT DO
//                NOTHING turned into a silent no-op that was still counted as sent).
// SUPERSEDES:    nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      .claude/IMPL-confirm-ask-rotation.md. Run: bun scripts/confirm-reask-rotation.test.ts
//                The store here is a MODEL of the SQL; the SQL itself is proven against real Postgres by
//                scripts/confirm-reask-db.test.ts. Prints `PASS|FAIL <name>` per check (scripts/mutate.sh format).
import { mock } from "bun:test";
import { readFileSync } from "node:fs";

delete process.env.AZURE_PG_URL; // scheduling-config must resolve to its shipped defaults, never a real DB

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);
const TZ = "America/New_York";
const EMAIL = "owner@test";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
}

// ---- the simulated clock ----------------------------------------------------------------------------------
let SIM = 0;
const realNow = Date.now;
Date.now = () => SIM;

// ---- the in-memory store (a model of tasks.server.ts's SQL) -----------------------------------------------
type Row = {
  id: string;
  title: string;
  status: string;
  assigned_agent: string;
  tags: string[];
  completed_at: null;
  category: null;
  priority: string;
  is_priority: boolean;
  priority_rank: null;
  due_date: null;
};
type St = {
  confirm_status: "awaiting" | "asked" | "confirmed";
  confirm_ask_at: number | null;
  confirm_last_sent_at: number | null;
  confirm_ask_count: number;
  approach_status: string;
  clarify_status: string;
  approach_redrive_count: number;
  approach_redrive_last_at: number | null;
  confirmed_at: number | null;
};
let board: Row[] = [];
let states = new Map<string, St>();
let pushes: { id: string; at: number; taskId: string; agent: string; payload: any }[] = [];
let turnIds = new Set<string>();
let enqueueMode: "ok" | "false" | "throw" = "ok";
let dueThrows = false;
let storeCalls: string[] = [];
let reminderIds = new Set<string>();

const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());
const st = (id: string): St => {
  let s = states.get(id);
  if (!s) {
    s = {
      confirm_status: "awaiting", confirm_ask_at: null, confirm_last_sent_at: null, confirm_ask_count: 0,
      approach_status: "pending", clarify_status: "none", approach_redrive_count: 0, approach_redrive_last_at: null,
      confirmed_at: null,
    };
    states.set(id, s);
  }
  return s;
};
const armedUnsent = (s: St) =>
  s.confirm_ask_at !== null &&
  (s.confirm_status === "awaiting" || (s.confirm_status === "asked" && s.confirm_ask_at > (s.confirm_last_sent_at ?? -Infinity)));
const view = (id: string) => {
  const s = st(id);
  return {
    task_id: id, user_email: EMAIL, ...s,
    confirm_ask_at: iso(s.confirm_ask_at), confirm_last_sent_at: iso(s.confirm_last_sent_at),
    approach_redrive_last_at: iso(s.approach_redrive_last_at), confirmed_at: iso(s.confirmed_at),
  };
};

mock.module(P("tasks/tasks.server.ts"), () => ({
  getOpenAssignedTasks: async () => board.filter((t) => t.status !== "DONE"),
  getBoardTasks: async () => board,
  getTaskBlockers: async () => new Map(),
  setAutoWorkSignature: async () => {},
  ensureReviewFlip: async () => {},
  getTaskEngagementStates: async (ids: string[]) => {
    storeCalls.push("getTaskEngagementStates");
    return new Map(ids.filter((i) => states.has(i)).map((i) => [i, view(i)]));
  },
  getLatestPendingConfirmAskAt: async () => {
    storeCalls.push("getLatestPendingConfirmAskAt");
    let m: number | null = null;
    for (const s of states.values()) if (armedUnsent(s) && s.confirm_ask_at! > SIM) m = Math.max(m ?? 0, s.confirm_ask_at!);
    return m === null ? null : new Date(m);
  },
  getLastConfirmSentAt: async () => {
    storeCalls.push("getLastConfirmSentAt");
    let m: number | null = null;
    for (const s of states.values()) if (s.confirm_last_sent_at !== null) m = Math.max(m ?? -Infinity, s.confirm_last_sent_at);
    return m === null ? null : new Date(m);
  },
  ensureConfirmAskAt: async (id: string, _e: string, at: string) => {
    const s = st(id);
    if (s.confirm_ask_at === null) s.confirm_ask_at = Date.parse(at);
  },
  armConfirmReAskAt: async (id: string, _e: string, at: string) => {
    const s = st(id);
    const a = Date.parse(at);
    if (s.confirm_status !== "asked" || s.confirm_last_sent_at === null) return false;
    if (!(s.confirm_ask_at === null || s.confirm_ask_at <= s.confirm_last_sent_at)) return false;
    if (!(a > s.confirm_last_sent_at)) return false;
    s.confirm_ask_at = a;
    return true;
  },
  reArmConfirmAskAt: async (id: string, _e: string, at: string) => {
    const s = st(id);
    if (armedUnsent(s)) s.confirm_ask_at = Date.parse(at);
  },
  getDueConfirmAsks: async (nowIso: string) => {
    storeCalls.push("getDueConfirmAsks");
    if (dueThrows) throw new Error("db down");
    const now = Date.parse(nowIso);
    return board
      .filter((t) => {
        const s = states.get(t.id);
        return (
          s && armedUnsent(s) && s.confirm_ask_at! <= now && s.clarify_status !== "open" && s.approach_status !== "escalated" &&
          ["UP_NEXT", "DOING"].includes(t.status) && !t.tags.includes("parking-lot")
        );
      })
      .sort((a, b) => st(a.id).confirm_ask_at! - st(b.id).confirm_ask_at!)
      .map((t) => {
        const s = st(t.id);
        return {
          task_id: t.id, user_email: EMAIL, assigned_agent: t.assigned_agent, title: t.title, category: null, tags: t.tags,
          confirm_status: s.confirm_status, confirm_ask_count: s.confirm_ask_count, confirm_last_sent_at: iso(s.confirm_last_sent_at),
        };
      });
  },
  claimConfirmAskSend: async (id: string, expected: number) => {
    const s = st(id);
    if (s.confirm_ask_count !== expected || !armedUnsent(s)) return null;
    s.confirm_status = "asked";
    s.confirm_ask_count++;
    s.confirm_last_sent_at = SIM;
    return { count: s.confirm_ask_count, sentAt: iso(SIM)! };
  },
  releaseConfirmAskSend: async (id: string, claim: { count: number; sentAt: string }, prev: { status: any; lastSentAt: string | null }) => {
    const s = st(id);
    if (s.confirm_ask_count !== claim.count || iso(s.confirm_last_sent_at) !== claim.sentAt || s.confirm_status !== "asked") return;
    s.confirm_status = prev.status;
    s.confirm_ask_count = claim.count - 1;
    s.confirm_last_sent_at = prev.lastSentAt === null ? null : Date.parse(prev.lastSentAt);
  },
  claimApproachRedrive: async (id: string, n: number) => {
    const s = st(id);
    if (s.approach_redrive_count !== n || s.confirm_status !== "confirmed" || s.approach_status !== "pending") return null;
    s.approach_redrive_count++;
    s.approach_redrive_last_at = SIM;
    return s.approach_redrive_count;
  },
  releaseApproachRedrive: async () => {},
  escalateApproach: async (id: string) => {
    st(id).approach_status = "escalated";
  },
}));
mock.module(P("journey/identity.ts"), () => ({ resolveTaskEmail: async () => EMAIL }));
mock.module(P("artifacts/artifacts.server.ts"), () => ({ listArtifacts: async () => [] }));
mock.module(P("tasks/turns.server.ts"), () => ({
  // ON CONFLICT (id) DO NOTHING semantics: a reused id inserts nothing and returns false.
  enqueueTurn: async (id: string, huddleId: string, _e: string, payload: any) => {
    if (enqueueMode === "throw") throw new Error("pool down");
    if (enqueueMode === "false" || turnIds.has(id)) return false;
    turnIds.add(id);
    if (payload?.notify === "push") {
      const m = /task_id "([^"]+)"/.exec(payload.text);
      pushes.push({ id, at: SIM, taskId: m ? m[1] : "?", agent: huddleId.slice(3), payload });
    }
    return true;
  },
  taskIdsInReminderWindow: async () => reminderIds,
}));
mock.module(P("identity/agent-workflow-config.server.ts"), () => ({
  isStructuredWorkflowRequired: async () => true,
  getWorkflowCaps: async () => ({ approach: 3, review: 3, question: 2 }),
}));
mock.module(P("journey/proxy.functions.ts"), () => ({
  invokeJourneyTool: async ({ args }: any) => {
    for (const u of args.updates ?? []) {
      const t = board.find((b) => b.id === u.task_id);
      if (t) t.status = u.status;
    }
    return { ok: true, output: JSON.stringify({ updated: (args.updates ?? []).length }) };
  },
}));

const AW = await import(`${SRC}/tasks/autowork.server.ts`);
const { runScheduledAutoWork, fireDueConfirmAsks, insideFanWindow, confirmIntentDirective } = AW;

const task = (id: string, agent = "tess-sutton", status = "UP_NEXT"): Row => ({
  id, title: `Test-${id}`, status, assigned_agent: agent, tags: [], completed_at: null, category: null,
  priority: "MEDIUM", is_priority: false, priority_rank: null, due_date: null,
});
function reset() {
  board = [];
  states = new Map();
  pushes = [];
  turnIds = new Set();
  enqueueMode = "ok";
  dueThrows = false;
  storeCalls = [];
  reminderIds = new Set();
}
function localHM(n: number): { h: number; m: number; day: string } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(n));
  const o: Record<string, string> = {};
  for (const x of p) if (x.type !== "literal") o[x.type] = x.value;
  return { h: Number(o.hour) % 24, m: Number(o.minute), day: `${o.year}-${o.month}-${o.day}` };
}
/** Tick minute by minute: the cadence pass at 9/13/17 local (SCHEDULING_DEFAULTS.autowork), the heartbeat every minute. */
async function simulate(from: number, to: number, onTick?: (now: number) => void | Promise<void>) {
  for (SIM = from; SIM < to; SIM += MIN) {
    if (onTick) await onTick(SIM);
    const { h, m } = localHM(SIM);
    if (m === 0 && (h === 9 || h === 13 || h === 17)) await runScheduledAutoWork({ entra_email: EMAIL }, { force: true, timeZone: TZ });
    await fireDueConfirmAsks(new Date(SIM));
  }
}
const start = Date.parse("2026-11-02T09:00:00-05:00"); // a Monday, 9:00 ET

// =====================================================================================================
console.log("B1. rotation order: never-asked first, then least-recently-SENT, ties by lane order, wrapping (AC-24)");
reset();
board = [task("A"), task("B"), task("C")];
Object.assign(st("A"), { confirm_status: "asked", confirm_ask_count: 1, confirm_last_sent_at: start - 2 * DAY, confirm_ask_at: start - 2 * DAY });
Object.assign(st("B"), { confirm_status: "awaiting", confirm_ask_at: start - MIN });
Object.assign(st("C"), { confirm_status: "asked", confirm_ask_count: 1, confirm_last_sent_at: start - DAY, confirm_ask_at: start - DAY });
await simulate(start, start + 3 * DAY);
const seq = pushes.map((p) => p.taskId);
check("AC-24 the first four asks to tess are B, A, C, B", seq.slice(0, 4).join(",") === "B,A,C,B", seq.join(","));
check("AC-22 every ask got a DISTINCT turn id", new Set(pushes.map((p) => p.id)).size === pushes.length, pushes.map((p) => p.id).join(" "));
check("AC-22 the bare legacy first-ask id `autowork-confirm-<task_id>` is never minted", !pushes.some((p) => /^autowork-confirm-[ABC]$/.test(p.id)));
check("AC-22 re-asks use their own id shape (autowork-reask-<task>-<attempt>-<stamp>)", pushes.filter((p) => p.taskId !== "B" || p !== pushes[0]).slice(1).every((p) => p.id.startsWith("autowork-reask-")), pushes.map((p) => p.id).join(" "));
check(
  "AC-21 each re-ask advanced the item's attempt count and last-sent",
  st("A").confirm_ask_count === 1 + pushes.filter((p) => p.taskId === "A").length && st("A").confirm_last_sent_at! > start,
  JSON.stringify(st("A")),
);
{
  const re = pushes.find((p) => p.taskId === "A")!;
  const first = pushes.find((p) => p.taskId === "B")!;
  check("AC-29 a re-ask payload names its task id and instructs propose_task_intent for it", /task_id "A"/.test(re.payload.text) && re.payload.text.includes("propose_task_intent"));
  check("AC-29 a re-ask is a PUSH to the assigned agent's DM", re.payload.notify === "push" && re.payload.huddleId === "dm-tess-sutton");
  check("AC-30 a re-ask reads as a follow-up, the first ask as a greeting", re.payload.text.includes("FOLLOW-UP") && re.payload.text.includes("Circling back") && !first.payload.text.includes("FOLLOW-UP"));
}
let minGap = Infinity;
for (let i = 1; i < pushes.length; i++) minGap = Math.min(minGap, pushes[i].at - pushes[i - 1].at);
check("AC-26 consecutive asks to one agent are >= the gap's minimum (45 min) apart", minGap >= 45 * MIN, `${minGap / MIN} min`);

// =====================================================================================================
console.log("\nB2. re-sorting the lane between ticks does not make it skip or repeat (AC-25)");
reset();
board = [task("A"), task("B"), task("C")];
for (const [id, ago] of [["A", 3], ["B", 2], ["C", 4]] as const) {
  Object.assign(st(id), { confirm_status: "asked", confirm_ask_count: 1, confirm_last_sent_at: start - ago * DAY, confirm_ask_at: start - ago * DAY });
}
await simulate(start, start + 3 * DAY, () => {
  board.reverse(); // the scorer's order changes every minute
});
{
  const s = pushes.map((p) => p.taskId);
  const firstRound = s.slice(0, 3);
  check("AC-25 the first round asks each item exactly once, oldest send first (C, A, B)", firstRound.join(",") === "C,A,B", s.join(","));
  let ok = true;
  for (let i = 0; i + 3 <= s.length; i += 3) if (new Set(s.slice(i, i + 3)).size !== Math.min(3, s.slice(i, i + 3).length)) ok = false;
  check("AC-25 no item is asked twice before every other item has been asked once", ok, s.join(","));
}

// =====================================================================================================
console.log("\nB3. an answered item drops out; a confirmed + approved one starts even below unanswered ones (AC-31/32)");
reset();
board = [task("A"), task("C"), task("B")];
for (const [id, ago] of [["A", 3], ["C", 4], ["B", 5]] as const) {
  Object.assign(st(id), { confirm_status: "asked", confirm_ask_count: 1, confirm_last_sent_at: start - ago * DAY, confirm_ask_at: start - ago * DAY });
}
let answeredAt = 0;
await simulate(start, start + 6 * DAY, (now) => {
  // The user answers B's ask ten minutes after it is (re)sent; the approach is approved an hour later.
  const b = pushes.find((p) => p.taskId === "B");
  if (b && !answeredAt && now >= b.at + 10 * MIN) {
    Object.assign(st("B"), { confirm_status: "confirmed", confirmed_at: now });
    answeredAt = now;
  }
  if (answeredAt && now === answeredAt + HOUR) st("B").approach_status = "approved";
});
{
  const afterAnswer = pushes.filter((p) => p.at > answeredAt).map((p) => p.taskId);
  check("AC-31 after B is answered it is never confirm-asked again", answeredAt > 0 && !afterAnswer.includes("B"), afterAnswer.join(","));
  check("AC-31 rotation continues over the remaining unanswered items", afterAnswer.length >= 2 && afterAnswer.every((x) => x === "A" || x === "C"), afterAnswer.join(","));
  check("AC-32 B (confirmed + approved, below A and C) was promoted to DOING", board.find((t) => t.id === "B")!.status === "DOING");
}

// =====================================================================================================
console.log("\nB4. a refused or failed enqueue is never counted as sent (AC-23)");
reset();
board = [task("A")];
Object.assign(st("A"), { confirm_status: "awaiting", confirm_ask_at: start - MIN });
SIM = start;
for (const mode of ["false", "throw"] as const) {
  enqueueMode = mode;
  const before = JSON.stringify(st("A"));
  const n = await fireDueConfirmAsks(new Date(SIM));
  check(`AC-23 enqueue ${mode === "false" ? "returns false (id conflict)" : "throws"} -> return value 0`, n === 0, String(n));
  check(`AC-23 enqueue ${mode} -> state not advanced (still awaiting, count 0, no last-sent, still due)`, JSON.stringify(st("A")) === before, `${before} -> ${JSON.stringify(st("A"))}`);
}
enqueueMode = "ok";
SIM = start + MIN;
check("AC-23 the next tick sends it, with a fresh id", (await fireDueConfirmAsks(new Date(SIM))) === 1 && pushes.length === 1);
// The F3 shape exactly: a SECOND ask on the same task whose id already exists must not be counted.
reset();
board = [task("A")];
Object.assign(st("A"), { confirm_status: "asked", confirm_ask_count: 1, confirm_last_sent_at: start - 2 * DAY, confirm_ask_at: start - MIN });
SIM = start;
turnIds.add(`autowork-reask-A-2-${start.toString(36)}`); // pre-existing row with the id this send would mint
const n2 = await fireDueConfirmAsks(new Date(SIM));
check("AC-22/23 an id conflict on a re-ask -> not counted, attempt stays 1, still armed", n2 === 0 && st("A").confirm_ask_count === 1 && armedUnsent(st("A")), JSON.stringify(st("A")));

// =====================================================================================================
console.log("\nB5. clarify / leaving the lane / reminder window / reassignment (AC-33, AC-37, AC-38, AC-40)");
reset();
// The lane is kept FULL (3 Up Next items) so the pass's BACKLOG->UP_NEXT top-up has no room: with room, the
// existing top-up would legitimately re-stage L into Up Next, and its asks would then resume (that is the
// "returns to UP_NEXT" half below, not a leak).
board = [task("Q"), task("Q2"), task("Q3"), task("L")];
for (const id of ["Q", "Q2", "Q3"]) {
  Object.assign(st(id), { confirm_status: "asked", confirm_ask_count: 1, confirm_last_sent_at: start - 3 * DAY, confirm_ask_at: start - 3 * DAY, clarify_status: "open" });
}
Object.assign(st("L"), { confirm_status: "asked", confirm_ask_count: 1, confirm_last_sent_at: start - 3 * DAY, confirm_ask_at: start - 3 * DAY });
board.find((t) => t.id === "L")!.status = "BACKLOG";
await simulate(start, start + 2 * DAY);
check("AC-33 an item with an open clarifying question gets no ask", !pushes.some((p) => p.taskId === "Q"));
check("AC-37 an asked item moved back to BACKLOG is not re-asked", !pushes.some((p) => p.taskId === "L"));
st("Q").clarify_status = "none";
board.find((t) => t.id === "L")!.status = "UP_NEXT";
const resumeFrom = start + 2 * DAY;
await simulate(resumeFrom, resumeFrom + 2 * DAY);
const resumed = pushes.filter((p) => p.at >= resumeFrom);
check("AC-33 once the question is answered it re-enters rotation", resumed.some((p) => p.taskId === "Q"));
check("AC-37 returned to UP_NEXT, it resumes from its history", resumed.some((p) => p.taskId === "L"));
check("AC-37 ...with no burst (consecutive asks >= 45 min apart)", resumed.every((p, i) => i === 0 || p.at - resumed[i - 1].at >= 45 * MIN));
// reminder window
reset();
board = [task("R")];
Object.assign(st("R"), { confirm_status: "awaiting", confirm_ask_at: start - MIN });
reminderIds = new Set(["R"]);
SIM = start;
check("AC-40 a task in its reminder window is not asked", (await fireDueConfirmAsks(new Date(SIM))) === 0 && pushes.length === 0);
// reassignment: the reset (resetEngagementOnReassignment, proven in SQL by confirm-reask-db) -> next ask is a FIRST ask
reset();
board = [task("Z", "cole-blake")];
Object.assign(st("Z"), { confirm_status: "awaiting", confirm_ask_count: 0, confirm_last_sent_at: null, confirm_ask_at: null }); // post-reset shape
await simulate(start, start + 6 * HOUR);
check("AC-38 after a reset the new assignee's ask is a FIRST ask (id + directive)", pushes.length === 1 && pushes[0].id.startsWith("autowork-confirm-Z-1-") && !pushes[0].payload.text.includes("FOLLOW-UP"), pushes.map((p) => p.id).join(" "));

// =====================================================================================================
console.log("\nC1. the live-shaped backlog over 7 days: spacing, windows, deploy-day flood (AC-41, AC-42, AC-44)");
reset();
const LIVE: [string, number][] = [
  ["tess-sutton", 12], ["sam-trent", 5], ["eli-vaughn", 5], ["cole-blake", 3], ["ezra-miles", 2],
  ["flex-grimes", 2], ["iris-chase", 2], ["cam-post", 1], ["elle-rowan", 1], ["finn-reid", 1],
];
let k = 0;
for (const [agent, n] of LIVE) {
  for (let i = 0; i < n; i++) {
    const id = `s${k++}`;
    board.push(task(id, agent));
    const sent = Date.parse("2026-08-10T14:00:00Z") + k * HOUR; // >60 days before the run
    Object.assign(st(id), { confirm_status: "asked", confirm_ask_count: 1, confirm_last_sent_at: sent, confirm_ask_at: sent });
  }
}
for (let i = 0; i < 5; i++) board.push(task(`fresh${i}`, ["sam-trent", "eli-vaughn", "finn-reid", "cam-post", "iris-chase"][i]));
const deployAt = Date.parse("2026-11-02T10:17:00-05:00"); // a Monday, mid-window
await simulate(deployAt, deployAt + 7 * DAY);
{
  let gap = Infinity;
  for (let i = 1; i < pushes.length; i++) gap = Math.min(gap, pushes[i].at - pushes[i - 1].at);
  check("AC-41 any two consecutive confirm pushes (first asks + re-asks, all agents) are >= 45 min apart", gap >= 45 * MIN, `${gap / MIN} min over ${pushes.length} pushes`);
  const outside = pushes.filter((p) => !insideFanWindow(new Date(p.at), TZ, [{ start: 9, end: 18 }, { start: 20, end: 22 }]));
  check("AC-42 100% of pushes fall inside the fan windows (9-18, 20-22 ET)", outside.length === 0, outside.map((p) => new Date(p.at).toISOString()).join(" "));
  const firstHour = pushes.filter((p) => p.at < deployAt + HOUR);
  check("AC-44 at most 1 confirm push in the first hour after deploy", firstHour.length <= 1, String(firstHour.length));
  const perDay = new Map<string, number>();
  for (const p of pushes) perDay.set(localHM(p.at).day, (perDay.get(localHM(p.at).day) ?? 0) + 1);
  const firstAsked = new Set(pushes.filter((p) => p.id.startsWith("autowork-confirm-")).map((p) => p.taskId));
  check("first asks for the 5 fresh items all went out within the run", [0, 1, 2, 3, 4].every((i) => firstAsked.has(`fresh${i}`)), [...firstAsked].join(","));
  const reasked = new Set(pushes.filter((p) => p.id.startsWith("autowork-reask-")).map((p) => p.taskId));
  check("every one of the 10 agents with a stale ask was re-asked during the week", LIVE.every(([a]) => pushes.some((p) => p.agent === a && p.id.startsWith("autowork-reask-"))));
  check("AC-12/43-shape: nothing was shelved -- every stale item is still UP_NEXT and unanswered ones still 'asked'", board.filter((t) => t.id.startsWith("s")).every((t) => t.status === "UP_NEXT" && st(t.id).confirm_status === "asked"));
  console.log(`  pushes=${pushes.length} per-day=${JSON.stringify(Object.fromEntries(perDay))} distinct-reasked=${reasked.size}/35`);
}

// =====================================================================================================
console.log("\nC2. heartbeat cost and failure isolation (AC-52, AC-53)");
reset();
SIM = start;
storeCalls = [];
const t0 = realNow();
const idle = await fireDueConfirmAsks(new Date(SIM));
const took = realNow() - t0;
check("AC-52 an idle tick (nothing due) makes exactly ONE store query", idle === 0 && storeCalls.join(",") === "getDueConfirmAsks", storeCalls.join(","));
check("AC-52 an idle tick adds < 200 ms", took < 200, `${took} ms`);
dueThrows = true;
let threw = false;
try {
  check("AC-53 a throwing selection resolves to 0", (await fireDueConfirmAsks(new Date(SIM))) === 0);
} catch {
  threw = true;
}
check("AC-53 fireDueConfirmAsks never throws", !threw);
{
  const sched = readFileSync(`${SRC}/tasks/scheduler.server.ts`, "utf8");
  const fireIdx = sched.indexOf("await fireDueConfirmAsks(now);");
  const claimIdx = sched.indexOf("claimed = await claimDueScheduledJobs(20);");
  const guarded = /try \{\s*const \{ fireDueConfirmAsks \} = await import\("\.\/autowork\.server"\);\s*await fireDueConfirmAsks\(now\);\s*\} catch/.test(sched);
  check("AC-53 the heartbeat calls it inside its own try, BEFORE claiming the other jobs", guarded && fireIdx > 0 && claimIdx > fireIdx);
}

// =====================================================================================================
console.log("\nC3. config-centric: no interval/cap literal in the scheduler (AC-51, re-scoped)");
{
  const aw = readFileSync(`${SRC}/tasks/autowork.server.ts`, "utf8");
  const ts = readFileSync(`${SRC}/tasks/tasks.server.ts`, "utf8");
  const sc = readFileSync(`${SRC}/identity/scheduling-config.server.ts`, "utf8");
  check("AC-51 the 24h per-item floor is defined in scheduling-config.server.ts", /export const CONFIRM_REASK_MIN_HOURS_DEFAULT = 24;/.test(sc));
  check("AC-51 ...and resolved, not hardcoded, in autowork.server.ts", aw.includes("resolveConfirmReaskMinHours(email)") && !/\b24\s*\*\s*(3_?600_?000|HOUR|60\s*\*\s*60)/.test(aw));
  check("AC-51 tasks.server.ts carries no re-ask interval literal", !/interval '24 hours'|24 \* 3600/.test(ts));
}

// a direct check of the follow-up directive builder
check(
  "AC-30 confirmIntentDirective(followUp) differs from the first-ask directive",
  confirmIntentDirective({ id: "x", title: "t", assigned_agent: "tess-sutton" }, { followUp: true }) !==
    confirmIntentDirective({ id: "x", title: "t", assigned_agent: "tess-sutton" }),
);

Date.now = realNow;
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
