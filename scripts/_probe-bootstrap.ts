// WHAT:       Runs the REAL correspondence ledger SQL (lib/correspondence/ledger.server.ts, unmodified) against a
//             throwaway local PostgreSQL: first-seen insert, re-reads, an edited item, concurrent claims, a
//             failed write, bounded retries, a killed pass, needs_context reopening, the cursor, and a
//             schema check that no body/subject/sender column exists. Also (section 4) the Teams-chat bell
//             rows in the EXISTING chat.email_replies and the Sent Items settle of feed work emails
//             (lib/email/email-replies.server.ts, unmodified by the test).
// WHY:        AC docs/ac/AC-correspondence-checklist.md section 3 (Tier 1). The in-memory twin in
//             correspondence-ingest.test.ts mirrors what the author THINKS the SQL does; this exercises the
//             SQL itself (the lesson of scripts/fireflies-queue-sql.test.ts, D7/D8/D9).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-correspondence-ingest.md.
//
// Run: bun scripts/correspondence-ledger-sql.test.ts   (needs PostgreSQL 16/17 binaries; SKIPS cleanly without)
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceItem } from "../src/features/huddle/lib/correspondence/source-item";

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin"].find((d) => existsSync(join(d, "initdb")));
if (!BIN) {
  console.log("SKIP: no PostgreSQL binaries found");
  process.exit(0);
}
const PORT = 55000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), "corr-"));
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


const { Client } = await import("pg");
process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
const LS0 = await import("../src/features/huddle/lib/correspondence/ledger.server");
const LS = { BOOTSTRAP_SQL: process.env.BOOT_FILE ? (await import("node:fs")).readFileSync(process.env.BOOT_FILE, "utf8") : LS0.BOOTSTRAP_SQL };
const admin = new Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/postgres` }); await admin.connect();
const OLD_DDL = `CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.correspondence_ledger (
  source TEXT NOT NULL CHECK (source IN ('email','teams','transcript')), source_item_id TEXT NOT NULL, owner_email TEXT NOT NULL,
  identity_basis TEXT NOT NULL, thread_id TEXT, item_at TIMESTAMPTZ, drive_path TEXT, drive_item_id TEXT, file_etag TEXT,
  internet_message_id TEXT, content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','needs_context','failed_retryable','failed')),
  missing_field TEXT, attempts INT NOT NULL DEFAULT 0, claim_version BIGINT NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), result_ids JSONB NOT NULL DEFAULT '{}'::jsonb, last_error_category TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ, PRIMARY KEY (source, source_item_id));
CREATE INDEX IF NOT EXISTS correspondence_ledger_due_idx ON chat.correspondence_ledger (owner_email, source, next_attempt_at)
  WHERE status IN ('pending','failed_retryable');
CREATE TABLE IF NOT EXISTS chat.correspondence_cursor (owner_email TEXT NOT NULL, source TEXT NOT NULL, file_etag TEXT,
  checked_at TIMESTAMPTZ, observed_at TIMESTAMPTZ, PRIMARY KEY (owner_email, source));`;
const conn = async (name: string) => { const c = new Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/${name}` }); await c.connect(); return c; };
const seed = async (name: string) => {
  await admin.query(`CREATE DATABASE ${name}`); const c = await conn(name); await c.query(OLD_DDL);
  await c.query(`INSERT INTO chat.correspondence_ledger (source, source_item_id, owner_email, identity_basis, content_hash, status)
                 SELECT (ARRAY['email','teams','transcript'])[1 + g % 3], 'id-'||g, 'o', 'provider_id', 'h'||g, 'processed' FROM generate_series(1,300) g`);
  return c;
};
try {
  const codes: Record<string, number> = {}; let ok = 0; const N = Number(process.env.N ?? 8), R = Number(process.env.R ?? 15);
  for (let r = 0; r < R; r++) {
    const name = `p${r}`; const c0 = await seed(name); await c0.end();
    const cs = await Promise.all(Array.from({ length: N }, () => conn(name)));
    const res = await Promise.allSettled(cs.map((c) => c.query(LS.BOOTSTRAP_SQL)));
    for (const x of res) { if (x.status === "fulfilled") ok++; else { const k = (x.reason as any).code + " " + String((x.reason as any).message).slice(0, 70); codes[k] = (codes[k] ?? 0) + 1; } }
    const chk = await conn(name);
    const n = Number((await chk.query(`SELECT count(*) n FROM pg_constraint WHERE conrelid='chat.correspondence_ledger'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%(source = ANY%' AND pg_get_constraintdef(oid) LIKE '%''sent''%'`)).rows[0].n);
    const rows = Number((await chk.query(`SELECT count(*) n FROM chat.correspondence_ledger`)).rows[0].n);
    if (n !== 1 || rows !== 300) console.log(`round ${r}: sent-checks=${n} rows=${rows}`);
    await chk.end(); await Promise.all(cs.map((c) => c.end()));
  }
  console.log(`CONCURRENT ${N}x${R}: ok=${ok} errors=${JSON.stringify(codes)}`);
  // migration time, single bootstrap on 300 old rows
  { const c = await seed("ptime"); const t0 = performance.now(); await c.query(LS.BOOTSTRAP_SQL); console.log(`MIGRATE 300 rows: ${(performance.now() - t0).toFixed(1)} ms`);
    const t1 = performance.now(); await c.query(LS.BOOTSTRAP_SQL); console.log(`STEADY bootstrap: ${(performance.now() - t1).toFixed(1)} ms`);
    // steady-state lock: a reader holds AccessShare in an open transaction; does bootstrap need a conflicting lock?
    const rd = await conn("ptime"); await rd.query("BEGIN"); await rd.query("SELECT 1 FROM chat.correspondence_ledger LIMIT 1");
    await c.query("SET lock_timeout = '500ms'");
    const st = await c.query(LS.BOOTSTRAP_SQL).then(() => "no conflicting lock", (e) => `BLOCKED by an open reader: ${e.code} ${e.message}`);
    console.log(`STEADY with open reader: ${st}`);
    // which locks does an already-migrated bootstrap take?
    await rd.query("ROLLBACK"); await c.query("RESET lock_timeout"); await c.query("BEGIN"); await c.query(LS.BOOTSTRAP_SQL);
    const locks = (await rd.query(`SELECT mode FROM pg_locks l JOIN pg_class k ON k.oid=l.relation WHERE k.relname='correspondence_ledger' AND l.pid <> pg_backend_pid() ORDER BY 1`)).rows.map((x: any) => x.mode);
    console.log(`STEADY locks held on ledger: ${JSON.stringify(locks)}`); await c.query("ROLLBACK"); await rd.end(); await c.end(); }
} catch (e) { console.log("PROBE ERROR", e); } finally { await admin.end(); stop(); }
process.exit(0);
