// WHAT:       Runs the REAL bell SQL for the feed file-staleness alert (raiseFeedAttention / clearFeedAttention /
//             settleAttentionForHuddle in lib/email/email-replies.server.ts, unmodified by the test) against a
//             throwaway local PostgreSQL, driven through the real applyFeedStaleness: one row per file, no
//             duplicate across heartbeats, auto-clear, dismiss holds per episode, talking to Iris does not clear it.
// WHY:        The in-memory twin in scripts/feed-staleness.test.ts mirrors what the author THINKS the SQL does;
//             this exercises the SQL itself (the lesson of scripts/correspondence-ledger-sql.test.ts).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-feed-staleness.md.
//
// Run: bun scripts/feed-staleness-sql.test.ts   (needs PostgreSQL 16/17 binaries; SKIPS cleanly without)
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
const dir = mkdtempSync(join(tmpdir(), "feedstale-"));
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
const NOW = U("2026-11-13T15:00:00Z"); // Fri 10:00 ET

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const R = await import("../src/features/huddle/lib/email/email-replies.server");
  const S = await import("../src/features/huddle/lib/correspondence/feed-staleness");
  const pool = getSharedPool();
  const store = { raise: R.raiseFeedAttention, clear: R.clearFeedAttention };
  const id = S.feedAttentionId(O, "email");
  const rowOf = async (rid = id) =>
    (await pool.query(`SELECT kind, status, graph_message_id AS episode, subject, from_name, received_at, huddle_id FROM chat.email_replies WHERE id=$1`, [rid])).rows[0];
  const feedCount = async () => Number((await pool.query(`SELECT count(*) n FROM chat.email_replies WHERE kind='feed'`)).rows[0].n);
  const okMeta = (iso: string) => ({ kind: "ok" as const, lastModifiedMs: U(iso) });
  const stale = [{ file: "email" as const, meta: okMeta("2026-11-11T14:02:00Z") }];
  const fresh = (iso: string) => [{ file: "email" as const, meta: okMeta(iso) }];
  const missing = [{ file: "email" as const, meta: { kind: "missing" as const } }];

  const r1 = await S.applyFeedStaleness(O, stale, NOW, 6, store);
  const row1 = await rowOf();
  t("S1 a stale emails.json writes ONE open kind='feed' row in the EXISTING bell table",
    [r1.raised, row1.kind, row1.status, row1.episode, row1.subject, row1.from_name, row1.huddle_id, new Date(row1.received_at).toISOString()],
    [1, "feed", "owed", "stale:2026-11-11T14:02:00.000Z", "Work email file hasn't updated since Wed 9:02 AM (2 working days)", "Check the Power Automate email flow.", "dm-iris-chase", "2026-11-11T14:02:00.000Z"]);
  const r2 = await S.applyFeedStaleness(O, stale, NOW + 60_000, 6, store);
  const r3 = await S.applyFeedStaleness(O, stale, NOW + 120_000, 6, store);
  t("S2 later heartbeats, same episode + text: zero rows written, still ONE row", [r2.raised, r3.raised, await feedCount()], [0, 0, 1]);
  t("S3 the row is listed as open attention", (await R.listOpenAttention(O)).map((r) => r.id), [id]);
  t("S4 owner messaging Iris does NOT clear it (settleAttentionForHuddle skips 'feed')", [await R.settleAttentionForHuddle(O, "dm-iris-chase"), (await rowOf()).status], [0, "owed"]);
  const r4 = await S.applyFeedStaleness(O, stale, U("2026-11-16T15:00:00Z"), 6, store);
  t("S5 text changes (3 working days) -> the SAME row is refreshed in place", [r4.raised, await feedCount(), (await rowOf()).subject], [1, 1, "Work email file hasn't updated since Wed 9:02 AM (3 working days)"]);
  const r5 = await S.applyFeedStaleness(O, fresh("2026-11-16T16:00:00Z"), U("2026-11-16T16:10:00Z"), 6, store);
  const r6 = await S.applyFeedStaleness(O, fresh("2026-11-16T16:00:00Z"), U("2026-11-16T16:20:00Z"), 6, store);
  t("S6 file updated -> auto-clears ('replied'); clearing again touches nothing", [r5.cleared, r6.cleared, (await rowOf()).status, (await R.listOpenAttention(O)).length], [1, 0, "replied", 0]);
  const stale2 = fresh("2026-11-16T16:00:00Z");
  const r7 = await S.applyFeedStaleness(O, stale2, U("2026-11-17T20:00:00Z"), 6, store);
  t("S7 stale again later -> the SAME row reopens with the new episode", [r7.raised, await feedCount(), (await rowOf()).status, (await rowOf()).episode], [1, 1, "owed", "stale:2026-11-16T16:00:00.000Z"]);
  await R.settleEmailReply(id, "dismissed"); // the bell's Dismiss path (dismissAttentionFn)
  const r8 = await S.applyFeedStaleness(O, stale2, U("2026-11-19T20:00:00Z"), 6, store);
  t("S8 dismissed: the same episode (even with new span text) does NOT reopen", [r8.raised, (await rowOf()).status], [0, "dismissed"]);
  const r9 = await S.applyFeedStaleness(O, missing, U("2026-11-19T21:00:00Z"), 6, store);
  t("S9 dismissed: a NEW episode (file now missing) reopens it", [r9.raised, (await rowOf()).status, (await rowOf()).episode, (await rowOf()).subject], [1, "owed", "missing", "Work email file is missing from OneDrive"]);
  await R.settleEmailReply(id, "dismissed");
  const r10 = await S.applyFeedStaleness(O, fresh("2026-11-19T21:30:00Z"), U("2026-11-19T21:40:00Z"), 6, store);
  const r11 = await S.applyFeedStaleness(O, missing, U("2026-11-20T15:00:00Z"), 6, store);
  t("S10 dismissed + file restored ends the episode -> missing AGAIN later raises again", [r10.cleared, r11.raised, (await rowOf()).status], [1, 1, "owed"]);
  await pool.query(`INSERT INTO chat.email_replies (id, owner_email, mailbox, graph_message_id, kind, status) VALUES ('attn-feed-x', $1, '', 'm', 'chat', 'owed')`, [O]);
  t("S11 a raise never overwrites a non-feed row with the same id",
    [await R.raiseFeedAttention({ id: "attn-feed-x", ownerEmail: O, episode: "missing", title: "t", detail: "d", sinceIso: null, huddleId: "dm-iris-chase" }), (await rowOf("attn-feed-x")).kind], [false, "chat"]);
  t("S12 a clear never settles a non-feed row", [await R.clearFeedAttention("attn-feed-x", O), (await rowOf("attn-feed-x")).status], [false, "owed"]);
  t("S13 another owner cannot clear this owner's row", await R.clearFeedAttention(id, "other@eds.example"), false);
  await pool.end();
} catch (e) {
  fail++;
  console.log("FAIL harness:", e instanceof Error ? e.message : e);
} finally {
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
