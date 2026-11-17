// WHAT:       Runs the REAL bell SQL for the OpenAI out-of-credit alert (raiseAiQuotaAttention / clearAiQuotaAttention /
//             settleAttentionForHuddle / listOpenAttention in lib/email/email-replies.server.ts) against a throwaway local
//             PostgreSQL, driven through the real monitor (lib/ai-quota/ai-quota.ts): concurrent raises from several
//             "instances" open ONE row and post ONE notice; dismiss holds for the outage; success clears once.
// WHY:        The in-memory twin in scripts/ai-quota-alert.test.ts mirrors what the author THINKS the SQL does; this
//             exercises the SQL itself (the lesson of scripts/correspondence-ledger-sql.test.ts).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-quota-alert-background.md.
//
// Run: bun scripts/ai-quota-alert-sql.test.ts   (needs PostgreSQL 16/17 binaries; SKIPS cleanly without)
// Harness copied from scripts/feed-staleness-sql.test.ts. All data synthetic (.example).
// Harness copied from scripts/correspondence-ledger-sql.test.ts. All data synthetic (.example).
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
const dir = mkdtempSync(join(tmpdir(), "aiquota-"));
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
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const O = "owner@eds.example";
const U = (iso: string) => Date.parse(iso);
const NOW = U("2026-11-17T15:00:00Z");

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const R = await import("../src/features/huddle/lib/email/email-replies.server");
  const Q = await import("../src/features/huddle/lib/ai-quota/ai-quota");
  const pool = getSharedPool();
  const store = { raise: R.raiseAiQuotaAttention, clear: R.clearAiQuotaAttention };
  const QUOTA = new Error('OpenAI Responses 429: {"error":{"code":"insufficient_quota"}}');
  const id = Q.aiQuotaAttentionId(O);
  const rowOf = async (rid = id) =>
    (await pool.query(`SELECT kind, status, graph_message_id AS job, subject, from_name, huddle_id FROM chat.email_replies WHERE id=$1`, [rid])).rows[0];
  const count = async () => Number((await pool.query(`SELECT count(*) n FROM chat.email_replies WHERE kind='ai_quota'`)).rows[0].n);
  const notices: string[] = [];
  const mk = () =>
    Q.createAiQuotaMonitor({ store, notify: async (r) => (notices.push(r.kind), true), now: () => NOW, log: () => {}, throttleMs: 0 });

  // Concurrent raise across FOUR "instances" sharing the real table: exactly one opens the row and notifies.
  const ms = [mk(), mk(), mk(), mk()];
  const outs = await Promise.all(ms.map((m, i) => m.onFailure(i % 2 ? "Task proposals" : "Actions classifier", O, QUOTA)));
  t("D1 concurrent raise (4 instances) -> exactly one alerted", outs.filter((o) => o === "alerted").length, 1);
  t("D1 one row, one notice", [await count(), notices.length], [1, 1]);
  const r1 = await rowOf();
  t("D2 the row is an open ai_quota row in Iris's chat naming the job",
    [r1.kind, r1.status, r1.huddle_id, r1.from_name],
    ["ai_quota", "owed", "dm-iris-chase", "OpenAI is out of credit. AI checks, agent replies and routing are paused until the account is topped up."]);
  t("D3 a second quota error -> no duplicate", [await ms[0].onFailure("Grooming", O, QUOTA), await count(), notices.length], ["already_open", 1, 1]);
  t("D4 listed first in the bell", (await R.listOpenAttention(O))[0]?.id, id);
  t("D5 talking to Iris does NOT clear it", [await R.settleAttentionForHuddle(O, "dm-iris-chase"), (await rowOf()).status], [0, "owed"]);
  // Dismiss holds for the rest of the outage.
  await R.settleEmailReply(id, "dismissed");
  t("D6 dismissed row is not reopened by the same outage", [await ms[1].onFailure("Grooming", O, QUOTA), (await rowOf()).status, notices.length], ["already_open", "dismissed", 1]);
  // Success ends it (from open OR dismissed); concurrent successes clear once.
  const cl = await Promise.all(ms.map((m) => m.onSuccess("Stand-up", O)));
  t("D7 concurrent successes -> exactly one cleared", cl.filter((o) => o === "cleared").length, 1);
  t("D7 row auto-cleared, not listed", [(await rowOf()).status, (await R.listOpenAttention(O)).length], ["replied", 0]);
  t("D8 next outage reopens the SAME row", [await ms[2].onFailure("Auto-work", O, QUOTA), await count(), (await rowOf()).status, (await rowOf()).subject], ["alerted", 1, "owed", "OpenAI is out of credit (hit by Auto-work)"]);
  // Never touches another owner's row or another kind.
  await pool.query(`INSERT INTO chat.email_replies (id, owner_email, mailbox, graph_message_id, kind, huddle_id) VALUES ('attn-ai_quota-x', $1, '', 'm', 'chat', 'dm-iris-chase')`, [O]);
  t("D9 raise never takes over a non-ai_quota row", [await R.raiseAiQuotaAttention({ id: "attn-ai_quota-x", ownerEmail: O, job: "j", title: "t", detail: "d", huddleId: "dm-iris-chase" }), (await rowOf("attn-ai_quota-x")).kind], [false, "chat"]);
  t("D10 another owner cannot clear this owner's row", await R.clearAiQuotaAttention(id, "other@eds.example"), false);
  await pool.end();
} catch (e) {
  fail++;
  console.log("FAIL harness:", e instanceof Error ? e.message : e);
} finally {
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
