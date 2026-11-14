// WHAT:       Verifier loop 6 (U5): after the U1/U4 fix ("an unread newer copy is transient however long"), a sent.json
//             incident whose reader never reads again (no owed work-feed email -> loadFeedSent never runs), driven
//             through the real applyFeedStaleness against the REAL bell SQL on a throwaway local PostgreSQL.
//             Prints observations; asserts nothing.
// WHY:        Does the fix trade the double announcement for a stuck alert / a silenced later staleness alert?
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-5.md
// Harness copied from scripts/feed-staleness-sql.test.ts. All data synthetic (.example).
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
const dir = mkdtempSync(join(tmpdir(), "verify6-"));
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

const U = (iso: string) => Date.parse(iso);
const P = (id: string, v: unknown) => console.log(`${id.padEnd(84)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const R = await import("../src/features/huddle/lib/email/email-replies.server");
  const S = await import("../src/features/huddle/lib/correspondence/feed-staleness");
  const pool = getSharedPool();
  const store = { raise: R.raiseFeedAttention, clear: R.clearFeedAttention, notePending: R.notePendingFeedAttention };
  let announced: string[] = [];
  const notify = async (r: { file: string; nowMs: number }) => (announced.push(`${r.file}@${new Date(r.nowMs).toISOString()}`), true);
  const row = async (rid: string) => (await pool.query(`SELECT status, graph_message_id ep FROM chat.email_replies WHERE id=$1`, [rid])).rows[0] ?? null;
  const chk = (owner: string) => async (nowIso: string, lmIso: string, read: { status: string; at: string } | null) => {
    const rd = read ? { status: read.status, checkedMs: U(read.at) } : null;
    const rep = await S.applyFeedStaleness(owner, [{ file: "sent", meta: { kind: "ok", lastModifiedMs: U(lmIso) }, read: rd }], U(nowIso), 6, store, notify);
    const r = await row(S.feedAttentionId(owner, "sent"));
    return `${rep.states.sent} raised=${rep.raised} cleared=${rep.cleared} urgent=${rep.urgent} row=${r ? `${r.status}/${r.ep}` : "none"}`;
  };
  const INC = S.INCOMPLETE_STATUS;
  // U5: sent incident; the flow is fixed an hour later; NO owed work-feed email, so sent.json is never read again.
  const O7 = "o7@eds.example";
  const c7 = chk(O7);
  P("U5a Mon 10:10 ET: reader read sent (lm 9:50) -> incomplete", await c7("2026-11-16T15:10:00Z", "2026-11-16T14:50:00Z", { status: INC, at: "2026-11-16T15:00:00Z" }));
  P("U5b Mon 11:10 ET: flow FIXED, complete copy lm 10:55, never read", await c7("2026-11-16T16:10:00Z", "2026-11-16T15:55:00Z", { status: INC, at: "2026-11-16T15:00:00Z" }));
  P("U5c Tue 12:10 ET: same (file complete + fresh for 25h)", await c7("2026-11-17T17:10:00Z", "2026-11-16T15:55:00Z", { status: INC, at: "2026-11-16T15:00:00Z" }));
  await pool.query(`UPDATE chat.email_replies SET status='dismissed' WHERE id=$1`, [S.feedAttentionId(O7, "sent")]);
  P("U5d Fri 12:10 ET: dismissed; flow STOPPED since Mon 10:55 (4 working days)", await c7("2026-11-20T17:10:00Z", "2026-11-16T15:55:00Z", { status: INC, at: "2026-11-16T15:00:00Z" }));
  P("U5d+ next Wed: still stopped (9 days)", await c7("2026-11-25T17:10:00Z", "2026-11-16T15:55:00Z", { status: INC, at: "2026-11-16T15:00:00Z" }));
  P("U5  announcements", announced);
  // Control: same timeline but the reader DID read the fixed copy (status ok) -> staleness is raised.
  const O8 = "o8@eds.example";
  const c8 = chk(O8);
  announced = [];
  await c8("2026-11-16T15:10:00Z", "2026-11-16T14:50:00Z", { status: INC, at: "2026-11-16T15:00:00Z" });
  P("C5b control: reader read the fixed copy (ok) -> clears", await c8("2026-11-16T16:10:00Z", "2026-11-16T15:55:00Z", { status: "ok", at: "2026-11-16T16:00:00Z" }));
  P("C5d control: Fri, flow stopped since Mon 10:55", await c8("2026-11-20T17:10:00Z", "2026-11-16T15:55:00Z", { status: "ok", at: "2026-11-16T16:00:00Z" }));
  P("C5  announcements", announced);
  await pool.end();
} catch (e) {
  console.log("HARNESS ERROR:", e instanceof Error ? e.stack : e);
} finally {
  stop();
}
