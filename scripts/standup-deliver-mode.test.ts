// WHAT:       proves the stand-up can be PULLED as content without being delivered to chat --
//             `runScheduledStandup(caller, { deliver: false })` returns the structured digest,
//             posts nothing in Terry's DM, and does NOT advance the change-gate watermark.
// WHY:        the stand-up existed only as a chat message: surfaceDigest handed a prose brief to
//             Terry and the result carried nothing but COUNTS, so no other surface could render it.
//             The owner asked for it to be deliverable like the other digests (email/Slack/phone),
//             which requires a caller to be able to SEE the content. The dangerous half is the
//             watermark: if a content pull called setLastStandupAt, the real stand-up an hour later
//             would report "nothing to report" about work it had never told anyone.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   mutation results in .claude/IMPL-standup-deliver-mode.md; AC section G of
//             journey-voice/.claude/AC-digest-delivery.md (digest 3, "Terry's stand-up output").
//
// Run: bun scripts/standup-deliver-mode.test.ts   (npm run test:standup-deliver)
//
// NON-VACUITY: the two modes are driven through the SAME production function over the SAME fixture,
// and the assertions are on side effects RECORDED BY THE STUBS (enqueueTurn calls, setLastStandupAt
// calls) rather than on anything this test computes. Removing the `deliver` branch makes them fail.
import { mock } from "bun:test";

let p = 0,
  f = 0;
const t = (n: string, c: boolean, d = "") => {
  c ? (p++, console.log("ok " + n)) : (f++, console.log("FAIL " + n + " — " + d));
};

// ---- recorded side effects -------------------------------------------------
const calls = { enqueueTurn: 0, runTurnById: 0, setLastStandupAt: 0 };

const NOW = Date.now();
const task = (o: Record<string, unknown>) => ({
  status: "UP_NEXT",
  priority: "MEDIUM",
  category: "WORK",
  is_priority: false,
  priority_rank: null,
  due_date: null,
  pushed_count: 0,
  created_at: new Date(NOW).toISOString(),
  completed_at: null,
  assigned_agent: "terry-locke",
  tags: [],
  is_scheduled: false,
  start_time: null,
  ...o,
});

const BOARD = [
  task({ id: "rev-1", title: "Pricing one-pager", status: "IN_REVIEW" }),
  task({ id: "open-1", title: "Draft Q3 plan" }),
];

mock.module("../src/features/huddle/lib/journey/identity.ts", () => ({
  resolveTaskEmail: async () => "owner@example.com",
}));

mock.module("../src/features/huddle/lib/artifacts/artifacts.server.ts", () => ({
  // One artifact inside the 24h lookback, so the change gate opens and the run is not skipped.
  listArtifacts: async () => [
    {
      id: "a1",
      name: "Pricing one-pager",
      agent_id: "terry-locke",
      folder: "Docs",
      task_id: "rev-1",
      created_at: new Date(NOW - 60_000).toISOString(),
      status: "approved",
    },
  ],
}));

mock.module("../src/features/huddle/lib/tasks/tasks.server.ts", () => ({
  getBoardTasks: async () => BOARD,
  getTasksForUser: async () => BOARD,
  getTaskBlockers: async () => new Map(),
  getLastStandupAt: async () => null,
  setLastStandupAt: async () => {
    calls.setLastStandupAt++;
  },
  getTaskEngagementStatesSince: async () => new Set(["rev-1"]),
}));

mock.module("../src/features/huddle/lib/tasks/turns.server.ts", () => ({
  enqueueTurn: async () => {
    calls.enqueueTurn++;
    return true;
  },
  taskIdsInReminderWindow: async () => new Set<string>(),
}));

mock.module("../src/features/huddle/lib/huddle.functions.ts", () => ({
  runTurnById: async () => {
    calls.runTurnById++;
  },
}));

const { runScheduledStandup } = await import("../src/features/huddle/lib/tasks/standup.server.ts");

const caller = { entra_email: "owner@example.com" };

// ---- MODE A: content pull (deliver: false) ---------------------------------
const pulled = await runScheduledStandup(caller, { deliver: false, runId: "pull-1" });
const afterPull = { ...calls };

t("pull returns a run that was not skipped", pulled.ok && !pulled.skipped, JSON.stringify(pulled).slice(0, 200));
t("pull returns the structured digest (the whole point)", !!pulled.digest, "digest missing");
t(
  "pull's digest carries produced work",
  (pulled.digest?.produced ?? []).some((x) => x.title === "Pricing one-pager"),
  JSON.stringify(pulled.digest?.produced),
);
t(
  "pull's digest carries the review queue",
  (pulled.digest?.inReview ?? []).some((x) => x.title === "Pricing one-pager"),
  JSON.stringify(pulled.digest?.inReview),
);
t(
  "pull's digest carries priorities from rankTasks",
  (pulled.digest?.priorities ?? []).length > 0,
  JSON.stringify(pulled.digest?.priorities),
);
t("pull's digest carries the prose brief", (pulled.digest?.brief ?? "").length > 0, "brief empty");

// The two that actually matter.
t("a content pull posts NOTHING in chat", afterPull.enqueueTurn === 0 && afterPull.runTurnById === 0,
  `enqueueTurn=${afterPull.enqueueTurn} runTurnById=${afterPull.runTurnById}`);
t("a content pull does NOT advance the change-gate watermark", afterPull.setLastStandupAt === 0,
  `setLastStandupAt=${afterPull.setLastStandupAt}`);

// ---- MODE B: the real stand-up (default) -----------------------------------
const delivered = await runScheduledStandup(caller, { runId: "deliver-1" });

t("the default run still delivers to chat", calls.enqueueTurn === 1 && calls.runTurnById === 1,
  `enqueueTurn=${calls.enqueueTurn} runTurnById=${calls.runTurnById}`);
t("the default run still advances the watermark", calls.setLastStandupAt === 1,
  `setLastStandupAt=${calls.setLastStandupAt}`);
t("the delivered run ALSO returns the digest, so either path can be rendered", !!delivered.digest,
  "digest missing on the delivered path");
t(
  "both paths produce the same brief for the same fixture",
  pulled.digest?.brief === delivered.digest?.brief,
  "briefs diverge between pull and deliver",
);

console.log(`\n${p} passed, ${f} failed`);
if (f) process.exit(1);
