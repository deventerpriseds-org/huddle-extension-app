// WHAT:       Runs the REAL Fireflies queue SQL (lib/fireflies/minutes-store.server.ts, unmodified) against a
//             throwaway local PostgreSQL and replays the sequences that matter: retries, concurrent
//             heartbeats, a crashed worker, a delivery landing WHILE a worker holds the lease, the
//             summary-wait window, and running out of attempts.
// WHY:        Verify loop 2 (docs/qc-evidence/VERIFY-fireflies-minutes-2.md, branch
//             claude_verify-fireflies-minutes-2) found two queue defects (D7 lost mid-lease delivery, D8
//             attempts exhausted after 60 min of summary polling) that the 62 fake-store checks in
//             scripts/fireflies-minutes.test.ts could not see, because a fake mirrors what the author
//             THINKS the SQL does. This test exercises the SQL itself.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:fireflies-minutes.
//
// Run: bun scripts/fireflies-queue-sql.test.ts   (needs PostgreSQL 16 binaries; SKIPS cleanly without them)
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin"].find((d) => existsSync(join(d, "initdb")));
if (!BIN) {
  console.log("SKIP: no PostgreSQL binaries found");
  process.exit(0);
}
const PORT = 55000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), "ffq-"));
const asPg = process.getuid?.() === 0 ? ["runuser", "-u", "postgres", "--"] : [];
const run = (cmd: string[]) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr || r.stdout}`);
};
if (asPg.length) execSync(`chown postgres ${dir}`);
run([...asPg, `${BIN}/initdb`, "-D", `${dir}/data`, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
execSync(`openssl req -new -x509 -days 1 -nodes -subj /CN=localhost -keyout ${dir}/data/server.key -out ${dir}/data/server.crt 2>/dev/null`);
if (asPg.length) execSync(`chown postgres ${dir}/data/server.key ${dir}/data/server.crt && chmod 600 ${dir}/data/server.key`);
writeFileSync(`${dir}/data/postgresql.auto.conf`, `port=${PORT}\nssl=on\nunix_socket_directories='${dir}'\nlisten_addresses='127.0.0.1'\n`);
if (asPg.length) execSync(`chown postgres ${dir}/data/postgresql.auto.conf`);
run([...asPg, `${BIN}/pg_ctl`, "-D", `${dir}/data`, "-l", `${dir}/log`, "-w", "start"]);
const stop = () => spawnSync(asPg[0] ?? `${BIN}/pg_ctl`, asPg.length ? [...asPg.slice(1), `${BIN}/pg_ctl`, "-D", `${dir}/data`, "-m", "immediate", "stop"] : ["-D", `${dir}/data`, "-m", "immediate", "stop"]);

let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const s = await import("../src/features/huddle/lib/fireflies/minutes-store.server");
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const pool = getSharedPool();
  await s.getMinutesSettings("x@example.com"); // runs the bootstrap DDL
  const row = async (id: string) =>
    (await pool.query(
      `SELECT pending_email pe, pending_onedrive po, email_status es, emails_sent n, attempts a, email_error err,
              onedrive_status os FROM chat.fireflies_meetings WHERE meeting_id=$1`,
      [id],
    )).rows[0];
  const due = (id: string) => pool.query(`UPDATE chat.fireflies_meetings SET next_attempt_at = now() - interval '1 s' WHERE meeting_id=$1`, [id]);
  const claim = async (id: string) => (await s.claimDueMeetings(10)).find((r) => r.meeting_id === id);
  const O = "owner@example.com";

  // Q1 retry before and after the send: one email
  await s.recordWebhook("q1", O, "meeting.transcribed", null);
  await s.recordWebhook("q1", O, "meeting.transcribed", null);
  let r = await claim("q1");
  await s.recordEmailSent("q1", r!.queue_version, { source: "luna", kind: "luna", hash: "h", recipients: ["a@b.co"] });
  await s.recordOneDrive("q1", r!.queue_version, { ok: true, path: "/p" });
  await s.releaseMeeting("q1", r!.queue_version, 60, false);
  await s.recordWebhook("q1", O, "meeting.transcribed", null);
  t("Q1 a retry after the send queues nothing (no email, no re-upload)", [(await row("q1")).pe, (await row("q1")).po], [false, false]);

  // Q2 two concurrent heartbeats lease once
  await s.recordWebhook("q2", O, "meeting.transcribed", null);
  const [a, b] = await Promise.all([s.claimDueMeetings(10), s.claimDueMeetings(10)]);
  t("Q2 concurrent claims: exactly one worker gets the meeting", [...a, ...b].filter((x) => x.meeting_id === "q2").length, 1);

  // Q3 crashed worker: lease blocks, lapse frees
  await s.recordWebhook("q3", O, "meeting.transcribed", null);
  await claim("q3");
  t("Q3 a leased meeting is not re-claimed", !!(await claim("q3")), false);
  await pool.query(`UPDATE chat.fireflies_meetings SET lease_until = now() - interval '1 s' WHERE meeting_id='q3'`);
  t("Q3 after the lease lapses it is re-claimed", !!(await claim("q3")), true);

  // Q4 (D7) a delivery that lands WHILE the worker holds the lease is not lost
  await s.recordWebhook("q4", O, "meeting.transcribed", null);
  r = await claim("q4");
  await s.recordWebhook("q4", O, "meeting.summarized", null); // arrives mid-work
  await s.recordEmailSent("q4", r!.queue_version, { source: "fireflies", kind: "custom", hash: "h", recipients: ["a@b.co"] });
  await s.recordOneDrive("q4", r!.queue_version, { ok: true, path: "/p" });
  await s.releaseMeeting("q4", r!.queue_version, 600, false);
  const q4 = await row("q4");
  t("Q4 (D7) mid-lease delivery keeps the work pending (OneDrive re-save + email re-check)", [q4.pe, q4.po, q4.es], [true, true, "sent"]);
  t("Q4 (D7) ...and the meeting is due again at once, not after the backoff", !!(await claim("q4")), true);

  // Q5 (D8) Fireflies-summary wait: 5-minute polls do NOT use up attempts
  await s.recordWebhook("q5", O, "meeting.transcribed", null);
  for (let i = 0; i < 36; i++) {
    // 36 polls = 3 hours of waiting
    r = await claim("q5");
    if (!r) break;
    await s.recordEmailProblem("q5", r.queue_version, "fireflies", "waiting:fireflies_summary_missing", false);
    await s.recordOneDrive("q5", r.queue_version, { ok: true, path: "/p" });
    await s.releaseMeeting("q5", r.queue_version, 300, false);
    await due("q5");
  }
  t("Q5 (D8) 36 waiting polls (3h) never exhaust the attempt cap", [(await row("q5")).a, !!(await claim("q5"))], [0, true]);

  // Q6 (D8) real failures DO count, and running out records a visible final failure
  await s.recordWebhook("q6", O, "meeting.transcribed", null);
  for (let i = 0; i < 12; i++) {
    r = await claim("q6");
    if (!r) break;
    await s.recordEmailProblem("q6", r.queue_version, "luna", "luna_timeout", false);
    await s.releaseMeeting("q6", r.queue_version, 60, true);
    await s.giveUpIfExhausted("q6");
    await due("q6");
  }
  const q6 = await row("q6");
  t("Q6 (D8) after 12 failed passes: final, visible, no longer pending", [q6.a, q6.es, q6.err, q6.pe], [12, "failed", "gave_up:luna_timeout", false]);

  // Q7 a stale reprocessed_at (retry of a resend) does not re-queue; a newer one does
  await s.recordWebhook("q7", O, "meeting.transcribed", 100);
  r = await claim("q7");
  await s.recordEmailSent("q7", r!.queue_version, { source: "luna", kind: "luna", hash: "h", recipients: ["a@b.co"] });
  await s.recordOneDrive("q7", r!.queue_version, { ok: true, path: "/p" });
  await s.releaseMeeting("q7", r!.queue_version, 60, false);
  await s.recordWebhook("q7", O, "meeting.transcribed", 100);
  t("Q7 same reprocessed_at -> nothing re-queued", [(await row("q7")).pe, (await row("q7")).po], [false, false]);
  await s.recordWebhook("q7", O, "meeting.transcribed", 200);
  t("Q7 newer reprocessed_at -> email re-check + re-save queued", [(await row("q7")).pe, (await row("q7")).po], [true, true]);

  // Q8 a final problem never overwrites a successful send
  await s.recordWebhook("q8", O, "meeting.transcribed", null);
  r = await claim("q8");
  await s.recordEmailSent("q8", r!.queue_version, { source: "luna", kind: "luna", hash: "h", recipients: ["a@b.co"] });
  await s.recordEmailProblem("q8", r!.queue_version, "luna", "recipients_invalid", true);
  t("Q8 a later final problem keeps email_status 'sent'", (await row("q8")).es, "sent");

  // Q9 (D9) passes the host stops before they finish (never released) end in a visible failure
  await s.recordWebhook("q9", O, "meeting.transcribed", null);
  let claims = 0;
  for (let i = 0; i < 30; i++) {
    if (!(await claim("q9"))) break;
    claims++;
    await pool.query(`UPDATE chat.fireflies_meetings SET lease_until = now() - interval '1 s' WHERE meeting_id='q9'`); // killed
  }
  const q9 = await row("q9");
  t("Q9 (D9) 5 killed passes, then a final visible failure (not retried forever)", [claims, q9.pe, q9.po, q9.es, q9.err, q9.os], [5, false, false, "failed", "gave_up:pass_did_not_finish", "failed"]);

  // Q10 (D9) a pass that FINISHES resets the count: 3h of finished waiting polls are never cut off
  await s.recordWebhook("q10", O, "meeting.transcribed", null);
  let polls = 0;
  for (let i = 0; i < 36; i++) {
    r = await claim("q10");
    if (!r) break;
    polls++;
    await s.recordEmailProblem("q10", r.queue_version, "fireflies", "waiting:fireflies_summary_missing", false);
    await s.releaseMeeting("q10", r.queue_version, 300, false);
    await due("q10");
  }
  t("Q10 (D9) 36 finished polls are all claimed and the meeting is still pending", [polls, (await row("q10")).pe], [36, true]);

  // Q11 (D9) a new delivery after a stalled give-up re-queues the meeting with a fresh count
  await s.recordWebhook("q9", O, "meeting.summarized", null);
  t("Q11 (D9) a new delivery after the give-up is claimable again", !!(await claim("q9")), true);

  await pool.end();
} catch (e) {
  fail++;
  console.log("FAIL harness:", e instanceof Error ? e.message : e);
} finally {
  stop();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
