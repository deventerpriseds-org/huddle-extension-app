// WHAT:          Runs the confirm-ask store layer's REAL SQL (tasks.server.ts) against a throwaway local Postgres:
//                the additive columns + legacy backfill, the send CAS + its rollback, re-arming, the due query's
//                lane filters, the pending-ask anchor, which asked task a plain "yes" binds to, and the
//                reassignment reset.
// WHY:           .claude/AC-confirm-ask-rotation.md AC-21/22/23/27/38/39/40. AC-27 is the gate-integrity item: with
//                several asked items per agent, "yes" used to bind to the newest updated_at, which any unrelated
//                write bumps. An ORDER BY can only be proven by a database, never by a JS mock of it.
// SUPERSEDES:    nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      .claude/IMPL-confirm-ask-rotation.md. Run:
//                  bash scripts/local-pg-up.sh
//                  LOCAL_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:54329/postgres bun scripts/confirm-reask-db.test.ts
// SAFETY:        refuses to run unless the admin URL points at 127.0.0.1/localhost, and every run uses a FRESH
//                database it creates (and drops) itself — it can never touch the live Azure PG.
import { Pool } from "pg";
import { mock } from "bun:test";
import { readFileSync } from "node:fs";

const ADMIN = process.env.LOCAL_PG_ADMIN_URL ?? "";
const host = (() => {
  try {
    return new URL(ADMIN).hostname;
  } catch {
    return "";
  }
})();
if (host !== "127.0.0.1" && host !== "localhost") {
  console.error("REFUSING: LOCAL_PG_ADMIN_URL must point at a local throwaway Postgres (see scripts/local-pg-up.sh).");
  process.exit(2);
}
const DB = `reask_${Date.now().toString(36)}`;
const admin = new Pool({ connectionString: ADMIN, ssl: { rejectUnauthorized: false } });
await admin.query(`CREATE DATABASE ${DB}`);
const url = new URL(ADMIN);
url.pathname = `/${DB}`;
process.env.AZURE_PG_URL = url.toString();
// DROP DATABASE ... WITH (FORCE) at the end terminates the app's own pooled connections (57P01); that is the
// intended teardown, not a test failure, so it must not crash the process before the verdict line is read.
process.on("uncaughtException", (e: unknown) => {
  if ((e as { code?: string })?.code === "57P01") return;
  throw e;
});
const db = new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
}

const E = "owner@test.local";
try {
  // ---- M: the PRE-CHANGE table shape with a legacy 'asked' row, then the real bootstrap migrates it ----------
  await db.query(`CREATE SCHEMA tasks;
    CREATE TABLE tasks.task_engagement_state (
      task_id TEXT PRIMARY KEY, user_email TEXT NOT NULL, confirm_status TEXT NOT NULL DEFAULT 'awaiting',
      proposed_dod TEXT, proposed_reminder_at TIMESTAMPTZ, confirmed_dod TEXT, confirm_ask_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ, last_review_ping_at TIMESTAMPTZ, next_review_ping_at TIMESTAMPTZ,
      revision_count INT NOT NULL DEFAULT 0, entered_review_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO tasks.task_engagement_state (task_id,user_email,confirm_status,confirm_ask_at,updated_at)
      VALUES ('legacy','${E}','asked','2026-08-10T14:00:00Z','2026-10-01T00:00:00Z');`);

  const T = await import("../src/features/huddle/lib/tasks/tasks.server.ts");
  await T.getLastConfirmSentAt(E); // first call runs the real BOOTSTRAP_SQL

  const cols = (
    await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='tasks' AND table_name='task_engagement_state'`,
    )
  ).rows.map((r) => r.column_name);
  for (const c of ["confirm_last_sent_at", "confirm_ask_count", "approach_redrive_count", "approach_redrive_last_at"]) {
    check(`AC-21 column ${c} exists after bootstrap`, cols.includes(c));
  }
  const legacy = (await T.getTaskEngagementStates(["legacy"])).get("legacy")!;
  check(
    "M1 legacy asked row backfilled: last_sent = its armed instant, count = 1",
    new Date(legacy.confirm_last_sent_at!).toISOString() === "2026-08-10T14:00:00.000Z" && legacy.confirm_ask_count === 1,
    JSON.stringify({ s: legacy.confirm_last_sent_at, n: legacy.confirm_ask_count }),
  );
  check("M2 legacy row is NOT armed (no instant past its last send)", !(await T.getDueConfirmAsks(new Date().toISOString())).some((r) => r.task_id === "legacy"));

  // ---- fixtures: journey tasks in various lane states ------------------------------------------------------
  const task = (id: string, status: string, agent = "tess-sutton", tags = "{}") =>
    db.query(
      `INSERT INTO tasks.journey_tasks (id,user_email,title,status,assigned_agent,tags) VALUES ($1,$2,$3,$4,$5,$6::text[])`,
      [id, E, `Test-${id}`, status, agent, tags],
    );
  const eng = async (id: string, status: string, askAt: string | null, extra = "") => {
    await db.query(
      `INSERT INTO tasks.task_engagement_state (task_id,user_email,confirm_status,confirm_ask_at) VALUES ($1,$2,$3,$4)`,
      [id, E, status, askAt],
    );
    if (extra) await db.query(`UPDATE tasks.task_engagement_state SET ${extra} WHERE task_id=$1`, [id]);
  };
  const past = "2026-10-01T10:00:00Z";
  await task("legacy", "UP_NEXT");
  await task("due-upnext", "UP_NEXT");
  await eng("due-upnext", "awaiting", past);
  await task("due-doing", "DOING");
  await eng("due-doing", "awaiting", past);
  await task("due-backlog", "BACKLOG");
  await eng("due-backlog", "awaiting", past);
  await task("due-parked", "UP_NEXT", "tess-sutton", "{parking-lot}");
  await eng("due-parked", "awaiting", past);
  await task("due-blocked", "UP_NEXT");
  await eng("due-blocked", "awaiting", past);
  await db.query(`INSERT INTO tasks.task_blockers (task_id,user_email,reason) VALUES ('due-blocked',$1,'needs creds')`, [E]);
  await task("due-clarify", "UP_NEXT");
  await eng("due-clarify", "awaiting", past, "clarify_status='open'");
  await task("due-future", "UP_NEXT");
  await eng("due-future", "awaiting", "2099-01-01T00:00:00Z");

  const due = (await T.getDueConfirmAsks(new Date().toISOString())).map((r) => r.task_id);
  check("AC-40 a due ask on an UP_NEXT task IS selected", due.includes("due-upnext"), JSON.stringify(due));
  check("AC-40 a due ask on a DOING (unconfirmed) task IS selected", due.includes("due-doing"), JSON.stringify(due));
  check("AC-40 a due ask on a task moved back to BACKLOG is NOT selected", !due.includes("due-backlog"), JSON.stringify(due));
  check("AC-40 a parking-lot task is NOT selected", !due.includes("due-parked"));
  check("AC-40 a task flagged in task_blockers is NOT selected", !due.includes("due-blocked"));
  check("AC-33 a task with an open clarifying question is NOT selected", !due.includes("due-clarify"));
  check("due query: a not-yet-due ask is NOT selected", !due.includes("due-future"));
  const tagsNotNull = (
    await db.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema='tasks' AND table_name='journey_tasks' AND column_name='tags'`)
  ).rows[0]?.is_nullable;
  check("AC-39 journey_tasks.tags is NOT NULL by DDL (so the parking-lot test cannot NULL-out a row)", tagsNotNull === "NO", String(tagsNotNull));

  // ---- AC-21/22/23: the send CAS, its rollback, and a second attempt -----------------------------------------
  const c1 = await T.claimConfirmAskSend("due-upnext", 0);
  check("AC-22 first claim wins (count 0 -> 1)", c1?.count === 1, JSON.stringify(c1));
  const c1b = await T.claimConfirmAskSend("due-upnext", 0);
  check("AC-22 a second claim of the SAME attempt loses (no double send)", c1b === null, JSON.stringify(c1b));
  let s = (await T.getTaskEngagementStates(["due-upnext"])).get("due-upnext")!;
  check("AC-21 claim stamps confirm_last_sent_at and sets asked", s.confirm_status === "asked" && !!s.confirm_last_sent_at);
  await T.releaseConfirmAskSend("due-upnext", c1!, { status: "awaiting", lastSentAt: null });
  s = (await T.getTaskEngagementStates(["due-upnext"])).get("due-upnext")!;
  check(
    "AC-23 release after a refused enqueue restores awaiting / count 0 / no last-sent",
    s.confirm_status === "awaiting" && s.confirm_ask_count === 0 && s.confirm_last_sent_at === null,
    JSON.stringify({ st: s.confirm_status, n: s.confirm_ask_count, ls: s.confirm_last_sent_at }),
  );
  check(
    "AC-23 after release the ask is still armed and due (retried next tick)",
    (await T.getDueConfirmAsks(new Date().toISOString())).some((r) => r.task_id === "due-upnext"),
  );
  const c2 = await T.claimConfirmAskSend("due-upnext", 0);
  check("AC-22 the retry claims attempt 1 again", c2?.count === 1, JSON.stringify(c2));

  // ---- re-arming an asked item: set-once per round, never into the past -------------------------------------
  const lastSent = new Date((await T.getTaskEngagementStates(["due-upnext"])).get("due-upnext")!.confirm_last_sent_at!);
  const before = new Date(lastSent.getTime() - 60_000).toISOString();
  check("re-arm refuses an instant at/before the last send", !(await T.armConfirmReAskAt("due-upnext", E, before)));
  await db.query(`DELETE FROM tasks.task_engagement_state WHERE task_id='due-future'`); // its 2099 instant would own the max
  const slot = new Date(Date.now() + 3 * 3600_000).toISOString();
  check("re-arm accepts a future instant for a sent ask", await T.armConfirmReAskAt("due-upnext", E, slot));
  check("re-arm is set-once per round (a 2nd pass cannot push it out)", !(await T.armConfirmReAskAt("due-upnext", E, new Date(Date.now() + 9 * 3600_000).toISOString())));
  const anchor = await T.getLatestPendingConfirmAskAt(E);
  check("the spacing anchor sees a RE-ARMED re-ask as pending", anchor?.toISOString() === slot, `${anchor?.toISOString()} vs ${slot}`);
  const c3 = await T.claimConfirmAskSend("due-upnext", 1);
  check("AC-21 a re-ask send advances the attempt count to 2", c3?.count === 2, JSON.stringify(c3));
  const ls = await T.getLastConfirmSentAt(E);
  check("getLastConfirmSentAt returns the newest real send", !!ls && ls.toISOString() === c3?.sentAt, `${ls?.toISOString()} vs ${c3?.sentAt}`);

  // ---- clock skew (VERIFY-confirm-ask-rotation-1): "due" is decided on the APP clock. When it runs ahead of the
  // DB, an ask armed a few seconds in the DB's future is claimed; the stamp must still land past confirm_ask_at,
  // or the row stays armed-unsent and is sent a second time.
  await task("skew", "UP_NEXT", "flex-grimes");
  await db.query(
    `INSERT INTO tasks.task_engagement_state (task_id,user_email,confirm_status,confirm_ask_at) VALUES ('skew',$1,'awaiting', now() + interval '3 seconds')`,
    [E],
  );
  const appAhead = new Date(Date.now() + 10_000).toISOString();
  const skDue = (await T.getDueConfirmAsks(appAhead)).filter((r: { task_id: string }) => r.task_id === "skew");
  check("skew: an ask armed in the DB's future is due on an app clock 10s ahead", skDue.length === 1);
  const skClaim = await T.claimConfirmAskSend("skew", 0);
  check("skew: the claim succeeds", skClaim?.count === 1, JSON.stringify(skClaim));
  const skAgain = (await T.getDueConfirmAsks(appAhead)).filter((r: { task_id: string }) => r.task_id === "skew");
  check("skew: after one send the ask is NOT still due (no double-send)", skAgain.length === 0, JSON.stringify(skAgain));
  check("skew: and a second claim on the same attempt is refused", (await T.claimConfirmAskSend("skew", 1)) === null);

  // ---- AC-27: "yes" binds to the most recently SENT asked task, not the most recently WRITTEN ---------------
  await task("bind-A", "UP_NEXT", "cole-blake");
  await task("bind-B", "UP_NEXT", "cole-blake");
  await eng("bind-A", "asked", "2026-10-20T10:00:00Z", "confirm_last_sent_at='2026-10-20T10:00:00Z', confirm_ask_count=1");
  await eng("bind-B", "asked", "2026-10-21T10:00:00Z", "confirm_last_sent_at='2026-10-21T10:00:00Z', confirm_ask_count=1");
  await T.proposeTaskDod("bind-A", E, "Test- a DoD written AFTER B was asked"); // bumps A's updated_at
  const pc = await T.getPendingConfirmForAgent(E, "cole-blake");
  check("AC-27 a plain yes binds to B (asked last), not A (written last)", pc?.taskId === "bind-B", JSON.stringify(pc));
  // Same property on the OTHER SQL branch: a user linked to an identity profile (user_id set) — the live owner's
  // shape. The unlinked email above takes the email-only branch.
  const E2 = "linked@test.local";
  const OID = "00000000-0000-4000-8000-0000000000aa";
  await db.query(`INSERT INTO identity.profiles (entra_object_id, username) VALUES ($1, $2)`, [OID, E2]);
  await db.query(`INSERT INTO identity.profile_emails (entra_object_id, email, source) VALUES ($1, $2, 'entra')`, [OID, E2]);
  for (const [id, sent] of [["link-A", "2026-10-20T10:00:00Z"], ["link-B", "2026-10-21T10:00:00Z"]]) {
    await db.query(`INSERT INTO tasks.journey_tasks (id,user_email,title,status,assigned_agent) VALUES ($1,$2,$3,'UP_NEXT','sam-trent')`, [id, E2, `Test-${id}`]);
    await db.query(
      `INSERT INTO tasks.task_engagement_state (task_id,user_email,user_id,confirm_status,confirm_ask_at,confirm_last_sent_at,confirm_ask_count)
       VALUES ($1,$2,$3,'asked',$4,$4,1)`,
      [id, E2, OID, sent],
    );
  }
  await T.proposeTaskDod("link-A", E2, "Test- a DoD written AFTER link-B was asked");
  const pc2 = await T.getPendingConfirmForAgent(E2, "sam-trent");
  check("AC-27 (linked user / user_id branch) a plain yes binds to the last-SENT ask", pc2?.taskId === "link-B", JSON.stringify(pc2));
  // The text and voice call sites pass that row's id straight through — no re-selection in between.
  const hf = readFileSync(`${import.meta.dir}/../src/features/huddle/lib/huddle.functions.ts`, "utf8");
  const rt = readFileSync(`${import.meta.dir}/../src/features/huddle/lib/voice/realtime-tools.server.ts`, "utf8");
  check(
    "AC-27 the deterministic 'yes' path confirms exactly getPendingConfirmForAgent's task (text + voice)",
    /const pc = await getPendingConfirmForAgent\(em, dmAgent\);[\s\S]{0,400}await confirmTaskIntent\(pc\.taskId, em, dod\);/.test(hf) &&
      /const pending = await getPendingConfirmForAgent\(email, ctx\.agentId\);[\s\S]{0,900}taskId: pending\.taskId,/.test(rt),
  );

  // ---- AC-28: the Confirm BUTTON carries its own task id — it confirms A even though B was asked last -------
  mock.module(require.resolve("../src/features/huddle/lib/journey/proxy.functions.ts"), () => ({
    invokeJourneyTool: async () => ({ ok: true, output: "{}" }),
  }));
  await T.proposeTaskDod("bind-B", E, "Test- B's proposed DoD");
  const { confirmTaskFromProposal } = await import("../src/features/huddle/lib/tasks/confirm-ask.functions.ts");
  const btn = await confirmTaskFromProposal({ caller: { entra_email: E }, taskId: "bind-A", email: E });
  const ab = await T.getTaskEngagementStates(["bind-A", "bind-B"]);
  check(
    "AC-28 tapping Confirm on A confirms A only, although B was asked last",
    btn.ok === true && ab.get("bind-A")!.confirm_status === "confirmed" && ab.get("bind-B")!.confirm_status === "asked",
    JSON.stringify({ btn, a: ab.get("bind-A")!.confirm_status, b: ab.get("bind-B")!.confirm_status }),
  );

  // ---- AC-38: reassignment clears the re-ask history ---------------------------------------------------------
  await db.query(`UPDATE tasks.task_engagement_state SET approach_redrive_count=2, approach_redrive_last_at=now() WHERE task_id='due-upnext'`);
  await T.resetEngagementOnReassignment("due-upnext");
  s = (await T.getTaskEngagementStates(["due-upnext"])).get("due-upnext")!;
  check(
    "AC-38 reassignment resets last-sent, ask count and re-drive count",
    s.confirm_last_sent_at === null && s.confirm_ask_count === 0 && s.approach_redrive_count === 0 && s.approach_redrive_last_at === null && s.confirm_status === "awaiting",
    JSON.stringify(s),
  );

  // ---- approach re-drive CAS (AC-34/35) -------------------------------------------------------------------------
  await task("redrive", "UP_NEXT", "iris-vale");
  await eng("redrive", "confirmed", null, "approach_status='pending'");
  const r1 = await T.claimApproachRedrive("redrive", 0);
  const r1b = await T.claimApproachRedrive("redrive", 0);
  check("AC-34 re-drive claim is a CAS (second claim of the same count loses)", r1 === 1 && r1b === null, `${r1} ${r1b}`);
  await T.releaseApproachRedrive("redrive", 1, null);
  s = (await T.getTaskEngagementStates(["redrive"])).get("redrive")!;
  check("AC-34 a refused re-drive is released (count back to 0)", s.approach_redrive_count === 0 && s.approach_redrive_last_at === null);
  await db.query(`UPDATE tasks.task_engagement_state SET approach_status='escalated' WHERE task_id='redrive'`);
  check("AC-36 an escalated approach cannot be re-driven", (await T.claimApproachRedrive("redrive", 0)) === null);

} catch (e) {
  failures++;
  console.log(`FAIL harness threw -- ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await db.end().catch(() => {});
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
// The app pools keep connections open; drop the database with FORCE so they cannot hold it.
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
await admin.end().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
