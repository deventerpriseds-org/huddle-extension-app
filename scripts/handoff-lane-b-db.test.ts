// WHAT:          Runs Lane B's REAL SQL (F3 live-start marker + start claim, F4 live-ask stamping, F7 cross-turn
//                create claim) against a throwaway LOCAL Postgres.
// WHY:           docs/qc-evidence/AC-handoff-confirm-flow.md F3/F4/F7. ORDER BY / ON CONFLICT / CASE-guarded upserts
//                can only be proven by a database, never by a JS mock of one (same reasoning as confirm-reask-db).
// SUPERSEDES:    nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-handoff-lane-b.md. Run:
//                  bash scripts/local-pg-up.sh
//                  LOCAL_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:54329/postgres bun scripts/handoff-lane-b-db.test.ts
// SAFETY:        refuses to run unless the admin URL points at 127.0.0.1/localhost; every run creates and drops its
//                OWN fresh database, so it can never touch the live Azure PG or the journey board.
import { Pool } from "pg";

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
const DB = `laneb_${Date.now().toString(36)}`;
const admin = new Pool({ connectionString: ADMIN, ssl: { rejectUnauthorized: false } });
await admin.query(`CREATE DATABASE ${DB}`);
const url = new URL(ADMIN);
url.pathname = `/${DB}`;
process.env.AZURE_PG_URL = url.toString();
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
  const T = await import("../src/features/huddle/lib/tasks/tasks.server.ts");
  const TS = await import("../src/features/huddle/lib/tasks/turns.server.ts");
  await T.getLastConfirmSentAt(E); // runs the real tasks BOOTSTRAP_SQL
  await TS.getTurn("warmup"); // runs the real chat BOOTSTRAP_SQL

  const task = (id: string, status: string, agent = "finn-reid") =>
    db.query(`INSERT INTO tasks.journey_tasks (id,user_email,title,status,assigned_agent) VALUES ($1,$2,$3,$4,$5)`, [
      id,
      E,
      `Test-${id}`,
      status,
      agent,
    ]);

  // ================================ F4 ==========================================================================
  // AC-F4-3: a live proposal on a fresh task inserts an 'asked', sent row.
  await task("f4-fresh", "BACKLOG");
  await T.proposeTaskDod("f4-fresh", E, "Test- live DoD");
  let s = (await T.getTaskEngagementStates(["f4-fresh"])).get("f4-fresh")!;
  check(
    "AC-F4-3 fresh live proposal -> asked, last_sent set, ask_at == last_sent, count 1",
    s.confirm_status === "asked" &&
      !!s.confirm_last_sent_at &&
      new Date(s.confirm_ask_at!).getTime() === new Date(s.confirm_last_sent_at).getTime() &&
      s.confirm_ask_count === 1,
    JSON.stringify(s),
  );
  // Never downgrade a confirmed row (a re-proposal after confirm must not reopen the gate question).
  await task("f4-confirmed", "UP_NEXT");
  await T.proposeTaskDod("f4-confirmed", E, "Test- first DoD");
  await T.confirmTaskIntent("f4-confirmed", E, "Test- first DoD");
  const before = (await T.getTaskEngagementStates(["f4-confirmed"])).get("f4-confirmed")!;
  await T.proposeTaskDod("f4-confirmed", E, "Test- a later re-proposal");
  s = (await T.getTaskEngagementStates(["f4-confirmed"])).get("f4-confirmed")!;
  check(
    "F4 a proposal on a CONFIRMED row never downgrades it (status, last_sent, ask_at, count unchanged)",
    s.confirm_status === "confirmed" &&
      String(s.confirm_last_sent_at) === String(before.confirm_last_sent_at) &&
      String(s.confirm_ask_at) === String(before.confirm_ask_at) &&
      s.confirm_ask_count === before.confirm_ask_count,
    JSON.stringify({ before, s }),
  );
  // A future-armed autowork ask is consumed by the live ask (no second send queued behind it).
  await task("f4-armed", "UP_NEXT");
  await T.ensureConfirmAskAt("f4-armed", E, new Date(Date.now() + 3_600_000).toISOString());
  await T.proposeTaskDod("f4-armed", E, "Test- live DoD over an armed ask");
  const due = (await T.getDueConfirmAsks(new Date(Date.now() + 2 * 3_600_000).toISOString())).map((r) => r.task_id);
  check("AC-F4-4 a future-armed autowork ask is NOT still due after the live ask", !due.includes("f4-armed"), JSON.stringify(due));

  // ================================ F3 ==========================================================================
  // markLiveConfirm: only a CONFIRMED row can carry the live marker (fail closed).
  await task("f3-asked", "BACKLOG");
  await T.proposeTaskDod("f3-asked", E, "Test- DoD");
  check("AC-F3-6 markLiveConfirm refuses an 'asked' row", (await T.markLiveConfirm("f3-asked", "button")) === false);
  check("AC-F3-6 markLiveConfirm refuses a task with no engagement row", (await T.markLiveConfirm("f3-none", "button")) === false);
  s = (await T.getTaskEngagementStates(["f3-asked"])).get("f3-asked")!;
  check("AC-F3-6 ...and the refused row has no live marker", s.live_start_at === null && s.live_started_at === null, JSON.stringify(s));
  check("AC-F3-5 claimLiveStart refuses a row with no live marker", (await T.claimLiveStart("f3-asked")) === null);
  await task("f3-live", "BACKLOG");
  await T.proposeTaskDod("f3-live", E, "Test- DoD");
  await T.confirmTaskIntent("f3-live", E, "Test- DoD");
  check("F3 markLiveConfirm marks a confirmed row", (await T.markLiveConfirm("f3-live", "typed")) === true);
  s = (await T.getTaskEngagementStates(["f3-live"])).get("f3-live")!;
  check("F3 the marker + via are readable through ENGAGEMENT_COLS", !!s.live_start_at && s.live_start_via === "typed" && s.live_started_at === null, JSON.stringify(s));
  const c1 = await T.claimLiveStart("f3-live");
  const c2 = await T.claimLiveStart("f3-live");
  check("AC-F3-11 claimLiveStart is a CAS: first wins, second gets null", typeof c1 === "number" && c2 === null, JSON.stringify({ c1, c2 }));
  await T.releaseLiveStart("f3-live");
  check("F3 a released claim (DOING write failed) can be claimed again", typeof (await T.claimLiveStart("f3-live")) === "number");
  await T.releaseLiveStart("f3-live");
  const race = await Promise.all([T.claimLiveStart("f3-live"), T.claimLiveStart("f3-live"), T.claimLiveStart("f3-live")]);
  check("AC-F3-11 three concurrent claims -> exactly one winner", race.filter((x) => x !== null).length === 1, JSON.stringify(race));
  await T.resetEngagementOnReassignment("f3-live");
  s = (await T.getTaskEngagementStates(["f3-live"])).get("f3-live")!;
  check("F3 a reassignment clears the live marker (the new assignee never got the owner's live go-ahead)", s.live_start_at === null && s.live_started_at === null && s.live_start_via === null, JSON.stringify(s));


  // ================================ F7 ==========================================================================
  // The cross-turn create claim's REAL SQL: atomic under concurrency, held for the window, per user, releasable.
  const K = "test-obtain official transcript";
  const raceC = await Promise.all([1, 2, 3, 4].map(() => T.claimTaskCreateTitle(E, K, 10)));
  check("AC-F7-2 four concurrent claims for one (user,title) -> exactly one wins", raceC.filter((r) => r.claimed).length === 1, JSON.stringify(raceC));
  const later = await T.claimTaskCreateTitle(E, K, 10);
  check("AC-F7-1/F7-4 a second create seconds later (mirror not synced) is refused", later.claimed === false);
  await db.query(`UPDATE tasks.task_create_claims SET claimed_at = now() - interval '2 minutes' WHERE title_key = $1`, [K]);
  check("AC-F7-1 two minutes later is still refused (the observed gap)", (await T.claimTaskCreateTitle(E, K, 10)).claimed === false);
  await db.query(`UPDATE tasks.task_create_claims SET claimed_at = now() - interval '11 minutes' WHERE title_key = $1`, [K]);
  check("F7 after the window the claim is taken over (the mirror is authoritative again)", (await T.claimTaskCreateTitle(E, K, 10)).claimed === true);
  check("AC-F7-3 per USER: another user's identical title is independent", (await T.claimTaskCreateTitle("other@test.local", K, 10)).claimed === true);
  check("AC-F7-5 distinct titles are independent", (await T.claimTaskCreateTitle(E, "test-buy studio camera", 10)).claimed === true && (await T.claimTaskCreateTitle(E, "test-buy studio camera bag", 10)).claimed === true);
  await T.releaseTaskCreateTitle(E, K);
  check("F7 a released claim (failed create) can be taken again at once", (await T.claimTaskCreateTitle(E, K, 10)).claimed === true);
  const held = await T.claimTaskCreateTitle(E, K, 10);
  await task("f7-done", "DONE");
  await db.query(`UPDATE tasks.journey_tasks SET title='Test-Obtain official transcript', completed_at=now() WHERE id='f7-done'`);
  const doneTitles = held.claimed ? [] : await T.getTitlesCompletedSince(E, held.claimedAt);
  check("AC-F7-6 a task finished since the claim is visible to the claim escape", doneTitles.includes("Test-Obtain official transcript"), JSON.stringify(doneTitles));
  await T.retakeTaskCreateTitle(E, K);
  check("AC-F7-6 retake refreshes the claim (still held afterwards)", (await T.claimTaskCreateTitle(E, K, 10)).claimed === false);
} catch (e) {
  failures++;
  console.log(`FAIL harness threw -- ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await db.end().catch(() => {});
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
await admin.end().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
