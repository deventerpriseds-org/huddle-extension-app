// WHAT:       Verifier loop 7: the meeting-triage state-CHECK migration, run on a table created by the OLD shipped
//             bootstrap text (ddc7b55d, read from a file passed as argv[2]) with rows in it, then the NEW bootstrap
//             text from the working tree: once, then FOUR at once from the old state (a fresh database each), then again.
// WHY:        AC-R5.13: the migration must be idempotent and safe when several server instances bootstrap together.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-7.md
// Harness copied from scripts/verify6-staleness-stuck.ts. All data synthetic.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin"].find((d) => existsSync(join(d, "initdb")))!;
const PORT = 55000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), "verify7m-"));
const asPg = process.getuid?.() === 0 ? ["runuser", "-u", "postgres", "--"] : [];
const run = (cmd: string[]) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr || r.stdout}`);
};
if (asPg.length) execSync(`chown postgres ${dir}`);
run([...asPg, `${BIN}/initdb`, "-D", `${dir}/data`, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
writeFileSync(`${dir}/data/postgresql.auto.conf`, `port=${PORT}\nunix_socket_directories='${dir}'\nlisten_addresses='127.0.0.1'\n`);
if (asPg.length) execSync(`chown postgres ${dir}/data/postgresql.auto.conf`);
run([...asPg, `${BIN}/pg_ctl`, "-D", `${dir}/data`, "-l", `${dir}/log`, "-w", "start"]);
const stop = () => spawnSync(asPg[0] ?? `${BIN}/pg_ctl`, asPg.length ? [...asPg.slice(1), `${BIN}/pg_ctl`, "-D", `${dir}/data`, "-m", "immediate", "stop"] : ["-D", `${dir}/data`, "-m", "immediate", "stop"]);
const sqlOf = (src: string) => src.slice(src.indexOf("const BOOTSTRAP_SQL = `") + "const BOOTSTRAP_SQL = `".length, src.indexOf("`;", src.indexOf("const BOOTSTRAP_SQL = `")));
const OLD = sqlOf(readFileSync(process.argv[2], "utf8"));
const NEW = sqlOf(readFileSync(join(import.meta.dir, "../src/features/huddle/lib/proposals/proposals-store.server.ts"), "utf8"));
const P = (id: string, v: unknown) => console.log(`${id.padEnd(66)} ${JSON.stringify(v)}`);
try {
  const pg = await import("pg");
  for (const round of [1, 2, 3]) {
    const db = `r${round}`;
    const admin = new pg.default.Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/postgres` });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${db}`);
    await admin.end();
    const pool = new pg.default.Pool({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/${db}`, max: 8 });
    await pool.query(OLD);
    await pool.query(`INSERT INTO chat.task_proposals (id, owner_email, title, original_title, norm_title, evidence, state) VALUES ('prop-aa01','o@x.example','t','t','t','e','proposed'),('prop-aa02','o@x.example','u','u','u','e','dismissed')`);
    const checks = async () => (await pool.query(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='chat.task_proposals'::regclass AND contype='c'`)).rows.map((r) => `${r.conname}: ${/untriaged/.test(r.d) ? "NEW" : /state/.test(r.d) ? "OLD" : "other"}`);
    P(`round ${round} OLD bootstrap -> checks`, await checks());
    const errs: string[] = [];
    const n = round === 1 ? 1 : 4;
    await Promise.all(Array.from({ length: n }, () => pool.query(NEW).catch((e) => errs.push(String(e.message).slice(0, 80)))));
    P(`round ${round} NEW bootstrap x${n} at once -> errors`, errs);
    await pool.query(NEW).catch((e) => errs.push(String(e.message)));
    P(`round ${round} + once more -> checks`, await checks());
    let untriaged = "ok", bogus = "accepted";
    await pool.query(`INSERT INTO chat.task_proposals (id, owner_email, title, original_title, norm_title, evidence, state) VALUES ('prop-aa03','o@x.example','v','v','v','e','untriaged')`).catch((e) => (untriaged = String(e.message).slice(0, 60)));
    await pool.query(`INSERT INTO chat.task_proposals (id, owner_email, title, original_title, norm_title, evidence, state) VALUES ('prop-aa04','o@x.example','w','w','w','e','bogus')`).catch(() => (bogus = "refused"));
    P(`round ${round} insert untriaged / bogus; old rows`, [untriaged, bogus, (await pool.query(`SELECT id, state FROM chat.task_proposals WHERE id IN ('prop-aa01','prop-aa02') ORDER BY id`)).rows.map((r) => r.state)]);
    await pool.end();
  }
} catch (e) {
  console.log("HARNESS ERROR:", e instanceof Error ? e.stack : e);
} finally {
  stop();
}
