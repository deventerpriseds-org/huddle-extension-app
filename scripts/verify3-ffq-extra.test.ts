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
  // ---- verify loop 3 EXTRA sequences (not in the author's test) ----
  const lease = async (id: string) => (await pool.query(`SELECT lease_until IS NULL nl, next_attempt_at <= now() d FROM chat.fireflies_meetings WHERE meeting_id=$1`, [id])).rows[0];
  let r;
  // X1 delivery lands between claim and release, and the pass FAILED
  await s.recordWebhook("x1", O, "meeting.transcribed", null);
  r = await claim("x1");
  await s.recordOneDrive("x1", r!.queue_version, { ok: false, error: "onedrive_upload_503" });
  await s.recordWebhook("x1", O, "meeting.summarized", null);
  await s.releaseMeeting("x1", r!.queue_version, 60, true);
  const g1 = await s.giveUpIfExhausted("x1");
  t("X1 failed pass + mid-lease delivery: attempts not counted, due now, no give-up", [(await row("x1")).a, (await lease("x1")).d, g1, (await row("x1")).po], [0, true, false, true]);

  // X2 giveUp racing a fresh delivery (delivery lands after release, before giveUp)
  await s.recordWebhook("x2", O, "meeting.transcribed", null);
  for (let i = 0; i < 11; i++) { r = await claim("x2"); await s.releaseMeeting("x2", r!.queue_version, 60, true); await due("x2"); }
  r = await claim("x2");
  await s.releaseMeeting("x2", r!.queue_version, 60, true);
  const mid = (await row("x2")).a;
  await s.recordWebhook("x2", O, "meeting.transcribed", null);
  const g2 = await s.giveUpIfExhausted("x2");
  t("X2 delivery between release and giveUp: no give-up, still pending, attempts reset", [mid, g2, (await row("x2")).pe, (await row("x2")).a], [12, false, true, 0]);

  // X3 delivery AFTER a give-up revives the meeting
  await s.recordWebhook("x3", O, "meeting.transcribed", null);
  for (let i = 0; i < 12; i++) { r = await claim("x3"); await s.recordEmailProblem("x3", r!.queue_version, "luna", "luna_timeout", false); await s.releaseMeeting("x3", r!.queue_version, 60, true); await s.giveUpIfExhausted("x3"); await due("x3"); }
  const before = await row("x3");
  await s.recordWebhook("x3", O, "meeting.transcribed", null);
  t("X3 gave up, then a new delivery re-queues both branches", [before.pe, (await row("x3")).pe, (await row("x3")).po, (await row("x3")).a, !!(await claim("x3"))], [false, true, true, 0, true]);

  // X4 a pass that DIES (killed at the hosting ceiling / restart) never releases: the lease lapses, re-claimed.
  await s.recordWebhook("x4", O, "meeting.transcribed", null);
  let claims = 0;
  for (let i = 0; i < 30; i++) {
    r = await claim("x4");
    if (!r) break;
    claims++;
    await pool.query(`UPDATE chat.fireflies_meetings SET lease_until = now() - interval '1 s' WHERE meeting_id='x4'`);
  }
  t("X4 (probe) 30 killed passes: attempts stay 0, still pending, still claimable (no cap applies)", [claims, (await row("x4")).a, (await row("x4")).pe], [30, 0, true]);

  // X5 final email problem while the version moved: pending kept, re-worked at once
  await s.recordWebhook("x5", O, "meeting.transcribed", null);
  r = await claim("x5");
  await s.recordWebhook("x5", O, "meeting.transcribed", null);
  await s.recordEmailProblem("x5", r!.queue_version, "fireflies", "fireflies_summary_missing", true);
  await s.releaseMeeting("x5", r!.queue_version, 300, false);
  t("X5 final problem with moved version: still pending, due now", [(await row("x5")).pe, (await row("x5")).es, !!(await claim("x5"))], [true, "failed", true]);

  await pool.end();
} catch (e) {
  fail++;
  console.log("FAIL harness:", e instanceof Error ? e.message : e);
} finally {
  stop();
}
if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log("\nall passed");
