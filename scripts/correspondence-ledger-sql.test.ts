// WHAT:       Runs the REAL correspondence ledger SQL (lib/correspondence/ledger.server.ts, unmodified) against a
//             throwaway local PostgreSQL: first-seen insert, re-reads, an edited item, concurrent claims, a
//             failed write, bounded retries, a killed pass, needs_context reopening, the cursor, and a
//             schema check that no body/subject/sender column exists.
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

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const O = "owner@eds.example";
const item = (id: string, hash = "h1", source: SourceItem["source"] = "teams"): SourceItem => ({
  source,
  sourceItemId: id,
  identityBasis: "provider_id",
  threadId: "chat-1",
  at: "2026-11-11T10:00:00.000Z",
  contentHash: hash,
  drivePath: "/automation/huddle-source-log.jsonl",
  driveItemId: "drive-item-1",
  fileEtag: '"{e1},1"',
  internetMessageId: null,
});

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { pgLedger: L, pgCursor: C } = await import("../src/features/huddle/lib/correspondence/ledger.server");
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const pool = getSharedPool();
  const row = async (id: string, source = "teams") =>
    (await pool.query(
      `SELECT status, attempts a, content_hash h, last_error_category cat, missing_field mf, result_ids r,
              updated_at::text u, last_seen_at::text s, claim_version::int v
         FROM chat.correspondence_ledger WHERE source=$1 AND source_item_id=$2`,
      [source, id],
    )).rows[0];
  const count = async (id: string) => Number((await pool.query(`SELECT count(*) n FROM chat.correspondence_ledger WHERE source_item_id=$1`, [id])).rows[0].n);
  const due = (id: string) => pool.query(`UPDATE chat.correspondence_ledger SET next_attempt_at = now() - interval '1 s' WHERE source_item_id=$1`, [id]);
  const claim = async (id: string, max = 5) => (await L.claimDue(O, ["teams", "email"], 50, max)).find((c) => c.sourceItemId === id);

  // AC-3.1 unique key + first insert
  t("AC-3.1 first observe inserts", await L.observe(O, [item("c1:m1")]), { inserted: 1, changed: 0, unchanged: 0 });
  const pk = (await pool.query(
    `SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey::int2[], a.attnum)) cols FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'chat.correspondence_ledger'::regclass AND i.indisprimary`,
  )).rows[0].cols;
  t("AC-3.1 PRIMARY KEY is (source, source_item_id)", pk, "source,source_item_id");
  t("AC-1.5 the same item observed twice in one batch -> one row", [await L.observe(O, [item("c1:m2"), item("c1:m2")]), await count("c1:m2")], [
    { inserted: 1, changed: 0, unchanged: 0 },
    1,
  ]);

  // AC-3.2 columns; AC-3.8 nothing that could hold content
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='chat' AND table_name='correspondence_ledger'`)).rows.map((r) => r.column_name as string);
  t("AC-3.2 ledger carries every handoff field", ["thread_id", "item_at", "drive_path", "drive_item_id", "file_etag", "first_seen_at", "status", "result_ids", "last_error_category", "content_hash", "internet_message_id", "identity_basis", "missing_field", "attempts"].filter((c) => !cols.includes(c)), []);
  t("AC-3.8 no body / subject / sender / text / name column", cols.filter((c) => /body|subject|sender|text|name|preview|address/.test(c)), []);

  // AC-3.5 unchanged re-read: only last_seen_at moves
  const before = await row("c1:m1");
  await new Promise((r) => setTimeout(r, 15));
  t("AC-3.5 unchanged re-read counted unchanged", await L.observe(O, [item("c1:m1")]), { inserted: 0, changed: 0, unchanged: 1 });
  const after = await row("c1:m1");
  t("AC-3.5 unchanged re-read: updated_at/status/version untouched, last_seen_at touched", [after.u === before.u, after.status, after.v === before.v, after.s !== before.s], [true, "pending", true, true]);

  // AC-3.9 concurrent claims
  await L.observe(O, [item("c2:m1")]);
  const [a, b] = await Promise.all([L.claimDue(O, ["teams"], 50, 5), L.claimDue(O, ["teams"], 50, 5)]);
  t("AC-3.9 two concurrent passes: each item claimed exactly once", [...a, ...b].filter((x) => x.sourceItemId === "c2:m1").length, 1);
  const cl = [...a, ...b].find((x) => x.sourceItemId === "c2:m1")!;
  t("AC-3.9 a leased item is not re-claimed", !!(await claim("c2:m1")), false);

  // AC-3.3 processed only by the current claim; result ids stored
  t("markProcessed with the current claim applies", await L.markProcessed(cl, { bell: ["b1"] }), true);
  t("AC-3.2 result ids stored", (await row("c2:m1")).r, { bell: ["b1"] });
  t("a processed item is not claimable", !!(await claim("c2:m1")), false);

  // AC-3.4 edited content: SAME row back to pending, stale claim cannot mark it
  await L.observe(O, [item("c3:m1")]);
  const c3 = (await claim("c3:m1"))!;
  t("AC-3.4 edit -> counted changed", await L.observe(O, [item("c3:m1", "h2")]), { inserted: 0, changed: 1, unchanged: 0 });
  t("AC-3.4 edit keeps ONE row, resets to pending with fresh attempts", [await count("c3:m1"), (await row("c3:m1")).status, (await row("c3:m1")).a, (await row("c3:m1")).h], [1, "pending", 0, "h2"]);
  t("AC-3.4 a mark from the claim on the OLD content no longer applies", await L.markProcessed(c3, {}), false);
  t("AC-3.4 ...the row stays pending for the new content", (await row("c3:m1")).status, "pending");
  t("AC-3.4 an edited PROCESSED item is reopened (same row)", await (async () => {
    await L.observe(O, [item("c2:m1", "h9")]);
    return [(await row("c2:m1")).status, await count("c2:m1")];
  })(), ["pending", 1]);

  // AC-3.3 / AC-3.6 failure -> retryable with backoff, then terminal
  await L.observe(O, [item("c4:m1")]);
  let c4 = (await claim("c4:m1", 3))!;
  t("AC-3.3 failed write -> failed_retryable, attempts 1, NOT processed", [await L.markFailed(c4, "graph_429", 3), (await row("c4:m1")).status, (await row("c4:m1")).a, (await row("c4:m1")).cat], [true, "failed_retryable", 1, "graph_429"]);
  t("AC-3.6 no hot loop: a failed item is not due again at once", !!(await claim("c4:m1", 3)), false);
  const nextIn = Number((await pool.query(`SELECT extract(epoch FROM next_attempt_at - now())::int s FROM chat.correspondence_ledger WHERE source_item_id='c4:m1'`)).rows[0].s);
  t("AC-3.6 first backoff is ~5 minutes", nextIn > 250 && nextIn <= 300, true);
  await due("c4:m1");
  c4 = (await claim("c4:m1", 3))!;
  await L.markFailed(c4, "graph_429", 3);
  await due("c4:m1");
  c4 = (await claim("c4:m1", 3))!;
  await L.markFailed(c4, "journey:timeout", 3);
  t("AC-3.6 after maxAttempts failures: terminal failed, category kept", [(await row("c4:m1")).status, (await row("c4:m1")).a, (await row("c4:m1")).cat], ["failed", 3, "journey:timeout"]);
  await due("c4:m1");
  t("AC-3.6 a terminal failed item is never claimed again", !!(await claim("c4:m1", 3)), false);

  // D9 shape: passes killed before marking still use up attempts, then a visible failure
  await L.observe(O, [item("c5:m1")]);
  let claims = 0;
  for (let i = 0; i < 20; i++) {
    if (!(await claim("c5:m1", 4))) break;
    claims++;
    await pool.query(`UPDATE chat.correspondence_ledger SET lease_until = now() - interval '1 s' WHERE source_item_id='c5:m1'`); // killed
  }
  await L.claimDue(O, ["teams"], 50, 4); // the give-up sweep runs on the next claim
  t("AC-3.6 killed passes: 4 claims then terminal 'gave_up:pass_did_not_finish'", [claims, (await row("c5:m1")).status, (await row("c5:m1")).cat], [4, "failed", "gave_up:pass_did_not_finish"]);

  // AC-3.7 needs_context, reopened by a later file
  await L.observe(O, [item("c6:m1")]);
  const c6 = (await claim("c6:m1"))!;
  t("AC-3.7 needs_context with missing_field", [await L.markNeedsContext(c6, "owner_teams_id"), (await row("c6:m1")).status, (await row("c6:m1")).mf], [true, "needs_context", "owner_teams_id"]);
  t("AC-3.7 needs_context is not claimable", !!(await claim("c6:m1")), false);
  t("AC-3.7 a new file reopens needs_context rows of that source only, with a fresh attempt budget", [await L.reopenNeedsContext(O, "email"), await L.reopenNeedsContext(O, "teams"), (await row("c6:m1")).status, (await row("c6:m1")).mf, (await row("c6:m1")).a], [0, 1, "pending", null, 0]);

  // hasDue / owner scope
  t("hasDue true while something is pending", await L.hasDue(O, ["teams"], 5), true);
  t("hasDue is owner-scoped", await L.hasDue("other@eds.example", ["teams"], 5), false);
  t("claimDue is owner-scoped", (await L.claimDue("other@eds.example", ["teams"], 50, 5)).length, 0);
  t("AC-3.1 source CHECK rejects an unknown source", await pool.query(`INSERT INTO chat.correspondence_ledger (source, source_item_id, owner_email, identity_basis, content_hash) VALUES ('fax','x','o','provider_id','h')`).then(() => "accepted", () => "rejected"), "rejected");

  // health
  const h = await L.health(O);
  t("AC-6.6 seam: health counts per source + status", [h.teams?.failed, typeof h.teams?.pending], [2, "number"]);

  // cursor
  t("cursor absent at first", await C.get(O, "teams"), null);
  await C.set(O, "teams", '"{e1},1"');
  const k1 = await C.get(O, "teams");
  await C.set(O, "teams");
  const k2 = await C.get(O, "teams");
  t("cursor keeps the ingested eTag when only the check time moves", [k1?.etag, k2?.etag, (k2?.checkedAtMs ?? 0) >= (k1?.checkedAtMs ?? 0)], ['"{e1},1"', '"{e1},1"', true]);

  await pool.end();
} catch (e) {
  fail++;
  console.log("FAIL harness:", e instanceof Error ? e.message : e);
} finally {
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
