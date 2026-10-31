// WHAT:          Runs Lane B's REAL SQL (F3 live-start marker, F4 live-ask stamping + latest-message binding read,
//                F7 cross-turn create claim) against a throwaway LOCAL Postgres.
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

  // AC-F4-1/8: the latest-agent-message read, from the durable turn store.
  const H = "dm-finn-reid";
  const turn = async (id: string, replies: unknown[], result: unknown = null, ageSec = 0) => {
    await db.query(
      `INSERT INTO chat.pending_turns (id, huddle_id, user_email, payload, status, replies, result, updated_at)
       VALUES ($1,$2,$3,'{}'::jsonb,'done',$4::jsonb,$5::jsonb, now() - make_interval(secs => $6))`,
      [id, H, E, JSON.stringify(replies), result === null ? null : JSON.stringify(result), ageSec],
    );
  };
  await turn("t-old-autowork-ask", [{ agentId: "finn-reid", text: "brakes?", confirmAsk: { taskId: "X" } }], null, 3600);
  await turn("t-handoff-ask", [{ agentId: "finn-reid", text: "budget plan", confirmAsk: { taskId: "Y" } }], null, 60);
  await db.query(
    `INSERT INTO chat.pending_turns (id, huddle_id, user_email, payload, status) VALUES ('t-current', $1, $2, '{}'::jsonb, 'running')`,
    [H, E],
  );
  let latest = await TS.getLatestAgentReplyTurn(E, H, "t-current");
  check("AC-F4-1 latest agent reply turn is the hand-off ask, not the older autowork ask", TS.confirmAskTaskIdOfLatestReply(latest) === "Y", latest?.id ?? "null");
  await turn("t-status-update", [{ agentId: "finn-reid", text: "Your 3pm moved to 4pm." }], null, 5);
  latest = await TS.getLatestAgentReplyTurn(E, H, "t-current");
  check("AC-F4-2 a newer plain status update means nothing is bound", TS.confirmAskTaskIdOfLatestReply(latest) === null, latest?.id ?? "null");
  await turn("t-sync", [], { replies: [{ text: "sync plan", confirmAsk: { taskId: "Z" } }] }, 1);
  latest = await TS.getLatestAgentReplyTurn(E, H, "t-current");
  check("F4 a sync-completed turn (result.replies) is read as the latest message", TS.confirmAskTaskIdOfLatestReply(latest) === "Z", latest?.id ?? "null");
  latest = await TS.getLatestAgentReplyTurn("someone-else@test.local", H, "t-current");
  check("AC-F4-8 another user's turns are never read", latest === null, latest?.id ?? "null");
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
