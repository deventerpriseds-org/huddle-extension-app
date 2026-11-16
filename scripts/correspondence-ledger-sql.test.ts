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
  t("AC-3.8 (2026-11-16: content lives ONLY in the single JSONB content column) no body / subject / sender / text / name column", cols.filter((c) => /body|subject|sender|text|name|preview|address/.test(c)), []);

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
  t("AC-3.5 an unchanged re-read of a PROCESSED item keeps it processed (no reprocessing)", [await L.observe(O, [item("c2:m1")]), (await row("c2:m1")).status], [{ inserted: 0, changed: 0, unchanged: 1 }, "processed"]);

  // Actions view (2026-11-16, AC-I-9): a stored result_ids.action verdict survives (re)processing; the owner_correction
  // column exists and is nullable.
  await L.observe(O, [item("c9:m1")]);
  await pool.query(`UPDATE chat.correspondence_ledger SET result_ids = result_ids || jsonb_build_object('action', '{"v":1,"key":"k|1","status":"open"}'::jsonb) WHERE source_item_id='c9:m1'`);
  const c9 = await claim("c9:m1");
  t("AI-9 markProcessed keeps result_ids.action and writes the processor's ids", [c9 ? await L.markProcessed(c9, { bell: ["b9"] }) : "no-claim", (await row("c9:m1")).r], [true, { bell: ["b9"], action: { v: 1, key: "k|1", status: "open" } }]);
  t("AI-9b a row with no verdict gets exactly the processor's ids", (await row("c2:m1")).r, { bell: ["b1"] });
  t("AI-9c owner_correction column present", cols.includes("owner_correction") || (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='chat' AND table_name='correspondence_ledger' AND column_name='owner_correction'`)).rowCount === 1, true);

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

  // ---- Section 4: the bell rows in the EXISTING chat.email_replies (real SQL) ----
  const R = await import("../src/features/huddle/lib/email/email-replies.server");
  const W = "owner@eds.example";
  await R.recordOwedEmail({ id: "e-1", ownerEmail: W, mailbox: "owner@work.example", graphMessageId: "feed:owner@work.example:A1", conversationId: "conv-1", fromAddress: "pat@partner.example", subject: "HUDDLE-PA-SBX- review?", receivedAt: "2026-11-10T11:00:00Z" });
  await R.recordOwedEmail({ id: "e-2", ownerEmail: W, mailbox: "owner@work.example", graphMessageId: "feed:owner@work.example:A2", conversationId: "conv-2", fromAddress: "pat@partner.example", subject: "HUDDLE-PA-SBX- later?", receivedAt: "2026-11-10T16:00:00Z" });
  const countsBefore = await R.getEmailReplyCounts(W);
  const owedBefore = (await R.listOwedEmailReplies(W)).map((r) => r.id);
  const byFromBefore = (await R.findOwedEmailReplyByFrom(W, "pat@partner.example"))?.id;
  const chat = (o: Record<string, unknown> = {}) => ({ id: "attn-chat-0000000000000001", ownerEmail: W, chatId: "19:c@thread.example", askSourceId: "19:c@thread.example:m1", askAt: "2026-11-10T10:00:00Z", senderName: "Pat", chatName: "HUDDLE-PA-SBX- C", link: "https://teams.example/l/m/1", needsContext: null as string | null, huddleId: "dm-iris-chase", ...o });
  t("AC-4.1 a chat ask writes ONE kind='chat' owed row in chat.email_replies", [await R.upsertChatAttention(chat()), (await pool.query(`SELECT kind, status, needs_context, source_link FROM chat.email_replies WHERE id=$1`, ["attn-chat-0000000000000001"])).rows[0]], [true, { kind: "chat", status: "owed", needs_context: null, source_link: "https://teams.example/l/m/1" }]);
  t("AC-4.9 a newer ask in the same chat updates the SAME row", [await R.upsertChatAttention(chat({ askSourceId: "19:c@thread.example:m2", askAt: "2026-11-10T10:30:00Z" })), Number((await pool.query(`SELECT count(*) n FROM chat.email_replies WHERE kind='chat'`)).rows[0].n)], [true, 1]);
  t("AC-4.4 email-only queries are unchanged by chat rows (counts, owed list, by-sender lookup)", [await R.getEmailReplyCounts(W), (await R.listOwedEmailReplies(W)).map((r) => r.id), (await R.findOwedEmailReplyByFrom(W, "pat@partner.example"))?.id], [countsBefore, owedBefore, byFromBefore]);
  t("AC-4.2 listOpenAttention returns the chat row with needs_context + source_link", (await R.listOpenAttention(W)).filter((r) => r.kind === "chat").map((r) => [r.id, r.needs_context, r.source_link]), [["attn-chat-0000000000000001", null, "https://teams.example/l/m/1"]]);
  t("talking to Iris does NOT settle a Teams chat row (settleAttentionForHuddle skips chat)", [await R.settleAttentionForHuddle(W, "dm-iris-chase"), (await pool.query(`SELECT status FROM chat.email_replies WHERE id='attn-chat-0000000000000001'`)).rows[0].status], [0, "owed"]);
  t("AC-4.5 an owner message OLDER than the ask does not settle", await R.settleChatAttention("attn-chat-0000000000000001", W, "2026-11-10T10:15:00Z"), false);
  t("AC-4.5 / 4.13 an owner message after the ask settles 'replied'", [await R.settleChatAttention("attn-chat-0000000000000001", W, "2026-11-10T11:00:00Z"), (await pool.query(`SELECT status FROM chat.email_replies WHERE id='attn-chat-0000000000000001'`)).rows[0].status], [true, "replied"]);
  t("the SAME ask re-read after settling does not reopen", await R.upsertChatAttention(chat({ askSourceId: "19:c@thread.example:m2", askAt: "2026-11-10T10:30:00Z" })), false);
  t("a NEWER ask after the reply reopens the chat row", [await R.upsertChatAttention(chat({ askSourceId: "19:c@thread.example:m3", askAt: "2026-11-10T12:00:00Z" })), (await pool.query(`SELECT status FROM chat.email_replies WHERE id='attn-chat-0000000000000001'`)).rows[0].status], [true, "owed"]);
  t("AC-4.10 Dismiss settles it through the existing ownership check", [!!(await R.getOwnedEmailReply("attn-chat-0000000000000001", W)), await R.getOwnedEmailReply("attn-chat-0000000000000001", "other@eds.example"), await R.settleEmailReply("attn-chat-0000000000000001", "dismissed")], [true, null, true]);
  t("AC-4.10 the next pass re-reading the dismissed ask does not reopen it", [await R.upsertChatAttention(chat({ askSourceId: "19:c@thread.example:m3", askAt: "2026-11-10T12:00:00Z" })), (await pool.query(`SELECT status FROM chat.email_replies WHERE id='attn-chat-0000000000000001'`)).rows[0].status], [false, "dismissed"]);
  t("AC-4.6 an uncertain chat row stores needs_context", [await R.upsertChatAttention(chat({ id: "attn-chat-0000000000000002", chatId: "19:d@thread.example", askSourceId: "19:d@thread.example:m1", needsContext: "owner_messages" })), (await pool.query(`SELECT needs_context FROM chat.email_replies WHERE id='attn-chat-0000000000000002'`)).rows[0].needs_context], [true, "owner_messages"]);
  t("an upsert never touches a non-chat row with the same id", [await R.upsertChatAttention(chat({ id: "e-1" })), (await pool.query(`SELECT kind, status FROM chat.email_replies WHERE id='e-1'`)).rows[0]], [false, { kind: "email", status: "owed" }]);

  // Owner decision 2 (option A): feed work emails settle from the Sent Items snapshot
  t("no Sent Items file (null) -> feed emails unchanged (owed until dismissed, as today)", [await R.reconcileRepliedFromSentItems(W, { feedSent: async () => null }), (await R.listOwedEmailReplies(W)).map((r) => r.id)], [0, ["e-1", "e-2"]]);
  const sentMap = new Map([["conv-1", Date.parse("2026-11-10T15:00:00Z")], ["conv-2", Date.parse("2026-11-10T15:00:00Z")]]);
  t("a later sent message settles e-1 'replied'; e-2 (received after the sent one) stays owed", [await R.reconcileRepliedFromSentItems(W, { feedSent: async () => sentMap }), (await pool.query(`SELECT id, status FROM chat.email_replies WHERE id IN ('e-1','e-2') ORDER BY id`)).rows], [1, [{ id: "e-1", status: "replied" }, { id: "e-2", status: "owed" }]]);
  t("a failing Sent Items read changes nothing", await R.reconcileRepliedFromSentItems(W, { feedSent: async () => { throw new Error("graph_500"); } }), 0);

  // ---- Section 5 (owner decision 2026-11-16): content stored in Azure; Sent Items store-only; purge ----
  const LS = await import("../src/features/huddle/lib/correspondence/ledger.server");
  const { Client } = await import("pg");
  const db = async (name: string) => {
    await pool.query(`CREATE DATABASE ${name}`);
    const c = new Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/${name}` });
    await c.connect();
    return c;
  };
  // CT-1: the LIVE table was created by the OLD DDL (a byte copy of origin/main fe495ec6 below). The new bootstrap must
  // keep its rows, add the content columns, and replace the auto-named source CHECK so 'sent' is accepted.
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
  const ins = (c: InstanceType<typeof Client>, src: string, id: string) =>
    c.query(`INSERT INTO chat.correspondence_ledger (source, source_item_id, owner_email, identity_basis, content_hash, status) VALUES ($1,$2,'o','provider_id','h','processed')`, [src, id]).then(() => "accepted", () => "rejected");
  {
    const old = await db("ledger_old");
    await old.query(OLD_DDL);
    await ins(old, "email", "old-1");
    await ins(old, "teams", "old-2");
    t("CT-1 old DDL: 'sent' is REJECTED before the migration (the test really starts from the old constraint)", await ins(old, "sent", "pre"), "rejected");
    await old.query(LS.BOOTSTRAP_SQL);
    await old.query(LS.BOOTSTRAP_SQL); // idempotent: a second bootstrap is a no-op
    t("CT-1 migration keeps the existing rows and their status", (await old.query(`SELECT source_item_id, status FROM chat.correspondence_ledger ORDER BY 1`)).rows, [{ source_item_id: "old-1", status: "processed" }, { source_item_id: "old-2", status: "processed" }]);
    t("CT-1 after the migration 'sent' is accepted and an unknown source still rejected", [await ins(old, "sent", "s-1"), await ins(old, "fax", "f-1")], ["accepted", "rejected"]);
    t("CT-1 exactly ONE source CHECK remains (the old one was dropped, not stacked)", Number((await old.query(`SELECT count(*) n FROM pg_constraint WHERE conrelid='chat.correspondence_ledger'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%(source = ANY%'`)).rows[0].n), 1);
    t("CT-1 content (jsonb) and content_purged_at columns added", (await old.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='chat' AND table_name='correspondence_ledger' AND column_name LIKE 'content%' ORDER BY 1`)).rows, [{ column_name: "content", data_type: "jsonb" }, { column_name: "content_hash", data_type: "text" }, { column_name: "content_purged_at", data_type: "timestamp with time zone" }]);
    t("CT-1 the status CHECK is untouched", await old.query(`INSERT INTO chat.correspondence_ledger (source, source_item_id, owner_email, identity_basis, content_hash, status) VALUES ('email','x','o','provider_id','h','bogus')`).then(() => "accepted", () => "rejected"), "rejected");
    await old.end();
    const fresh = await db("ledger_fresh");
    await fresh.query(LS.BOOTSTRAP_SQL);
    await fresh.query(LS.BOOTSTRAP_SQL);
    t("CT-2 fresh install: 'sent' accepted, one source CHECK, 'fax' rejected", [await ins(fresh, "sent", "s"), await ins(fresh, "fax", "f"), Number((await fresh.query(`SELECT count(*) n FROM pg_constraint WHERE conrelid='chat.correspondence_ledger'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%(source = ANY%'`)).rows[0].n)], ["accepted", "rejected", 1]);
    await fresh.end();
  }

  // CM-1 (live-DB risk, 2026-11-16): several app instances start at once and each runs the bootstrap against the
  // OLD-DDL table. Measured on an earlier version of the migration: 90 of 120 such bootstraps died with 40P01
  // (each held the due_idx ShareLock, then asked for ACCESS EXCLUSIVE). Every bootstrap must succeed, the rows must
  // survive, and exactly one source CHECK (accepting 'sent') must remain.
  {
    const errs: string[] = [];
    let survived = 0;
    for (let round = 0; round < 4; round++) {
      const seedC = await db(`ledger_conc${round}`);
      await seedC.query(OLD_DDL);
      await seedC.query(`INSERT INTO chat.correspondence_ledger (source, source_item_id, owner_email, identity_basis, content_hash, status)
                         SELECT (ARRAY['email','teams','transcript'])[1 + g % 3], 'id-'||g, 'o', 'provider_id', 'h'||g, 'processed' FROM generate_series(1,300) g`);
      const cs = await Promise.all(Array.from({ length: 8 }, async () => {
        const c = new Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/ledger_conc${round}` });
        await c.connect();
        return c;
      }));
      for (const r of await Promise.allSettled(cs.map((c) => c.query(LS.BOOTSTRAP_SQL)))) if (r.status === "rejected") errs.push(String((r.reason as { code?: string }).code));
      const rows = Number((await seedC.query(`SELECT count(*) n FROM chat.correspondence_ledger`)).rows[0].n);
      const checks = (await seedC.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='chat.correspondence_ledger'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%(source = ANY%'`)).rows;
      if (rows === 300 && checks.length === 1 && String(checks[0].d).includes("'sent'")) survived++;
      await Promise.all(cs.map((c) => c.end()));
      await seedC.end();
    }
    t("CM-1 8 CONCURRENT bootstraps on the old-DDL table (x4 rounds): none fails (no deadlock), rows kept, one 'sent' CHECK", [errs, survived], [[], 4]);
  }
  // CM-2: once migrated, a bootstrap (every process start) takes no lock an open reader blocks -- the lock footprint
  // of main's bootstrap (the due_idx ShareLock), not an ACCESS EXCLUSIVE that queues behind any open transaction.
  {
    const a = await db("ledger_steady");
    await a.query(OLD_DDL);
    await a.query(LS.BOOTSTRAP_SQL);
    const reader = new Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/ledger_steady` });
    await reader.connect();
    await reader.query("BEGIN");
    await reader.query("SELECT 1 FROM chat.correspondence_ledger LIMIT 1");
    await a.query("SET lock_timeout = '500ms'");
    t("CM-2 an already-migrated bootstrap is not blocked by an open reader", await a.query(LS.BOOTSTRAP_SQL).then(() => "ok", (e: { code?: string }) => `blocked ${e.code}`), "ok");
    await reader.query("ROLLBACK");
    await reader.end();
    await a.end();
  }
  // CM-3: the MIGRATION behind a long open transaction gives up after its 5s lock cap (55P03) instead of queueing an
  // ACCESS EXCLUSIVE request that every later ledger query would wait behind; once that transaction ends, it succeeds.
  {
    const a = await db("ledger_capped");
    await a.query(OLD_DDL);
    const holder = new Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/ledger_capped` });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM chat.correspondence_ledger LIMIT 1");
    const t0 = Date.now();
    // Raced against 15s so a missing cap reports "hung" instead of hanging the suite (the holder never lets go first).
    const first = await Promise.race([
      a.query(LS.BOOTSTRAP_SQL).then(() => "ok", (e: { code?: string }) => String(e.code)),
      new Promise<string>((r) => setTimeout(() => r("hung"), 15_000)),
    ]);
    const waited = Date.now() - t0;
    await holder.query("ROLLBACK");
    await holder.end();
    if (first === "hung") await new Promise((r) => setTimeout(r, 500)); // let the released bootstrap finish
    const second = await a.query(LS.BOOTSTRAP_SQL).then(() => "ok", (e: { code?: string }) => String(e.code));
    const sentOk = await a.query(`INSERT INTO chat.correspondence_ledger (source, source_item_id, owner_email, identity_basis, content_hash) VALUES ('sent','s','o','provider_id','h')`).then(() => "accepted", () => "rejected");
    t("CM-3 migration behind an open transaction: fails 55P03 within the 5s cap, then succeeds once it ends", [first, waited >= 4000 && waited < 9000, second, sentOk], ["55P03", true, "ok", "accepted"]);
    await a.end();
  }

  // JSONB stores object keys in its own order: compare content canonically (keys sorted, recursively).
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  const content = (n: string) => canon({ kind: "teams" as const, chatId: "chat-1", chatName: `SYNTH chat ${n}`, messageId: n, at: "2026-11-11T10:00:00.000Z", sender: { id: "u1", name: "Synth Sender", isApp: false }, fromOwner: false, text: `SYNTH body ${n}`, webUrl: null }) as never;
  const canonRow = (r: { rows: Record<string, unknown>[] }) => (r.rows[0] ? { ...r.rows[0], content: canon(r.rows[0].content) } : r.rows[0]) as Record<string, any>;
  const crow = async (id: string, source = "teams") => canonRow(await pool.query(`SELECT content, content_purged_at IS NOT NULL purged, status, content_hash h, updated_at::text u FROM chat.correspondence_ledger WHERE source=$1 AND source_item_id=$2`, [source, id]));
  t("CC-1 a new item's content is stored with it", [await L.observe(O, [{ ...item("k1:m1"), content: content("1") }]), (await crow("k1:m1")).content], [{ inserted: 1, changed: 0, unchanged: 0 }, content("1")]);
  // CC-2: rows stored before content existed (content NULL) are filled by a re-read with the SAME hash, and nothing
  // else on the row moves (status, hash, updated_at).
  await L.observe(O, [item("k1:m2")]);
  const k2row = await crow("k1:m2");
  t("CC-2 unchanged hash + NULL content -> filled, counted contentFilled, row otherwise untouched", [await L.observe(O, [{ ...item("k1:m2"), content: content("2") }]), (await crow("k1:m2")).content, (await crow("k1:m2")).status, (await crow("k1:m2")).u === k2row.u], [{ inserted: 0, changed: 0, unchanged: 1, contentFilled: 1 }, content("2"), "pending", true]);
  t("CC-3 an unchanged re-read never overwrites stored content", [await L.observe(O, [{ ...item("k1:m2"), content: content("other") }]), (await crow("k1:m2")).content], [{ inserted: 0, changed: 0, unchanged: 1 }, content("2")]);
  t("CC-4 a hash change writes the new content", [await L.observe(O, [{ ...item("k1:m2", "h2"), content: content("2b") }]), (await crow("k1:m2")).content], [{ inserted: 0, changed: 1, unchanged: 0 }, content("2b")]);
  t("CC-5 a hash change with NO content keeps the stored content", [await L.observe(O, [item("k1:m2", "h3")]), (await crow("k1:m2")).content], [{ inserted: 0, changed: 1, unchanged: 0 }, content("2b")]);

  // CS: Sent Items are store-only -- inserted processed, never pending again, never claimed even if forced pending.
  const sentItem = (id: string, hash = "s1"): SourceItem => ({ ...item(id, hash, "sent"), storeOnly: true, content: { kind: "sent", subject: "SYNTH", from: { name: null, address: "owner@work.example" }, to: ["pat@partner.example"], cc: [], receivedAt: null, conversationId: "conv-1", internetMessageId: null, bodyText: "SYNTH sent body", isForward: false, sentAt: "2026-11-11T10:00:00.000Z" } });
  t("CS-1 a sent item is inserted 'processed' with its content", [await L.observe(O, [sentItem("mb:S1")]), (await crow("mb:S1", "sent")).status, (await crow("mb:S1", "sent")).content?.kind], [{ inserted: 1, changed: 0, unchanged: 0 }, "processed", "sent"]);
  t("CS-2 an edited sent item keeps status 'processed' (never reset to pending)", [await L.observe(O, [sentItem("mb:S1", "s2")]), (await crow("mb:S1", "sent")).status], [{ inserted: 0, changed: 1, unchanged: 0 }, "processed"]);
  await pool.query(`UPDATE chat.correspondence_ledger SET status='pending', next_attempt_at = now() - interval '1 s' WHERE source='sent'`); // forced, to prove the claim guard itself
  t("CS-3 a sent row is never claimed or due, even if it were pending and its source were asked for", [(await L.claimDue(O, ["sent", "teams", "email"], 500, 5)).filter((c) => c.source === "sent").length, await L.hasDue(O, ["sent"], 5)], [0, false]);
  await pool.query(`UPDATE chat.correspondence_ledger SET status='processed' WHERE source='sent'`);

  // CT: Fireflies transcripts -- storeContent writes content only; meeting triage keeps owning hash + status.
  const tc = { kind: "transcript" as const, title: "SYNTH meeting", meetingAt: "2026-11-11T15:00:00.000Z", sentences: [{ speaker: "Synth A", text: "SYNTH line", start: 1, end: 2 }], summary: { overview: "SYNTH overview", extended_sections: [{ title: "Decisions", content: "SYNTH" }] } };
  const tcC = canon(tc);
  const tItem = (c = tc): SourceItem => ({ ...item("MEET-1", "ff-1", "transcript"), identityBasis: "meeting_id", threadId: null, storeOnly: true, content: c });
  t("CT-3 a new transcript row is inserted 'processed' with sentences + full summary", [await L.storeContent(O, [tItem()]), (await crow("MEET-1", "transcript")).status, (await crow("MEET-1", "transcript")).content], [{ inserted: 1, updated: 0 }, "processed", tcC]);
  // meeting triage then observes the SAME row with ITS hash and no content: exactly today's triage behaviour (pending)
  t("CT-4 meeting triage's own observe still reopens the row for triage and keeps the stored content", [await L.observe(O, [{ ...item("MEET-1", "triage-h", "transcript"), identityBasis: "meeting_id" }]), (await crow("MEET-1", "transcript")).status, (await crow("MEET-1", "transcript")).content], [{ inserted: 0, changed: 1, unchanged: 0 }, "pending", tcC]);
  const tc2 = { ...tc, summary: { overview: "SYNTH overview v2" } };
  t("CT-5 a re-stored transcript updates content ONLY (triage's hash + status untouched)", [await L.storeContent(O, [tItem(tc2)]), (await crow("MEET-1", "transcript")).h, (await crow("MEET-1", "transcript")).status, (await crow("MEET-1", "transcript")).content], [{ inserted: 0, updated: 1 }, "triage-h", "pending", canon(tc2)]);

  // CP: purge -- content older than the retention (by item time) -> NULL, row kept, never refilled.
  await pool.query(`UPDATE chat.correspondence_ledger SET item_at = now() - interval '100 days' WHERE source_item_id IN ('k1:m1','MEET-1')`);
  t("CP-1 retention is the argument: 365 days purges nothing here", await L.purgeContent(365), 0);
  t("CP-2 a 90-day purge clears exactly the old rows' content and keeps the rows", [await L.purgeContent(90), (await crow("k1:m1")).content, (await crow("k1:m1")).purged, (await crow("MEET-1", "transcript")).content, await count("k1:m1")], [2, null, true, null, 1]);
  t("CP-3 recent content is untouched", (await crow("k1:m2")).content, content("2b"));
  t("CP-4 a purged row is never refilled: not by an unchanged re-read, not by a hash change, not by storeContent", [
    (await L.observe(O, [{ ...item("k1:m1"), content: content("1") }])).contentFilled ?? 0,
    (await L.observe(O, [{ ...item("k1:m1", "hX"), content: content("1x") }]), (await crow("k1:m1")).content),
    (await L.storeContent(O, [tItem()]), (await crow("MEET-1", "transcript")).content),
  ], [0, null, null]);
  t("CP-5 a second purge finds nothing to do", await L.purgeContent(90), 0);

  await pool.end();
} catch (e) {
  fail++;
  console.log("FAIL harness:", e instanceof Error ? e.message : e);
} finally {
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
