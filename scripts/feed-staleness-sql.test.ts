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
  const store = { raise: R.raiseFeedAttention, clear: R.clearFeedAttention, notePending: R.notePendingFeedAttention };
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
  const r9a = await S.applyFeedStaleness(O, missing, U("2026-11-19T20:50:00Z"), 6, store);
  const s9a = (await rowOf()).status;
  const r9 = await S.applyFeedStaleness(O, missing, U("2026-11-19T21:00:00Z"), 6, store);
  t("S9 dismissed: a NEW hard reason (missing on 2 consecutive checks) reopens it; the first sighting does not",
    [r9a.raised, s9a, r9.raised, (await rowOf()).status, (await rowOf()).episode, (await rowOf()).subject], [0, "dismissed", 1, "owed", "missing", "Work email file is missing from OneDrive"]);
  await R.settleEmailReply(id, "dismissed");
  const r10 = await S.applyFeedStaleness(O, fresh("2026-11-19T21:30:00Z"), U("2026-11-19T21:40:00Z"), 6, store);
  await S.applyFeedStaleness(O, missing, U("2026-11-20T14:50:00Z"), 6, store);
  const r11 = await S.applyFeedStaleness(O, missing, U("2026-11-20T15:00:00Z"), 6, store);
  t("S10 dismissed + file restored ends the episode -> missing AGAIN later (2 checks) raises again", [r10.cleared, r11.raised, (await rowOf()).status], [1, 1, "owed"]);

  // Verifier loop 4, 4c (V1/V2), on the REAL SQL: a transient read changes nothing; hard reasons need 2 checks.
  {
    const vid = S.feedAttentionId(O, "sent");
    const vrow = async () => (await pool.query(`SELECT status, graph_message_id AS episode, feed_pending FROM chat.email_replies WHERE id=$1`, [vid])).rows[0] ?? null;
    const sentStale = [{ file: "sent" as const, meta: okMeta("2026-11-11T14:02:00Z") }];
    const sentTransient = [{ file: "sent" as const, meta: { kind: "transient" as const } }];
    const sentFresh = [{ file: "sent" as const, meta: okMeta("2026-11-13T14:30:00Z") }];
    const sent403 = [{ file: "sent" as const, meta: { kind: "unreadable" as const } }];
    await S.applyFeedStaleness(O, sentStale, NOW, 6, store);
    await R.settleEmailReply(vid, "dismissed");
    const a = await S.applyFeedStaleness(O, sentTransient, NOW + 600_000, 6, store);
    const afterTransient = await vrow();
    const b = await S.applyFeedStaleness(O, sentStale, NOW + 1_200_000, 6, store);
    t("S14 (V1) dismissed stale alert + ONE transient read + same stale file: stays dismissed, same episode",
      [a.raised, afterTransient, b.raised, await vrow()],
      [0, { status: "dismissed", episode: "stale:2026-11-11T14:02:00.000Z", feed_pending: null }, 0, { status: "dismissed", episode: "stale:2026-11-11T14:02:00.000Z", feed_pending: null }]);
    const tid = S.feedAttentionId(O, "teams");
    const tFresh = [{ file: "teams" as const, meta: okMeta("2026-11-12T23:30:00Z") }];
    await S.applyFeedStaleness(O, tFresh, NOW, 6, store);
    const c = await S.applyFeedStaleness(O, [{ file: "teams", meta: { kind: "transient" } }], NOW + 600_000, 6, store);
    t("S15 (V2) fresh file + one transient read: no row at all, nothing listed", [c.raised, (await pool.query(`SELECT count(*)::int n FROM chat.email_replies WHERE id=$1`, [tid])).rows[0].n, (await R.listOpenAttention(O)).map((r) => r.id).includes(tid)], [0, 0, false]);
    const d1 = await S.applyFeedStaleness(O, [{ file: "teams", meta: { kind: "unreadable" } }], NOW + 1_200_000, 6, store);
    const listedAfterFirst = (await R.listOpenAttention(O)).map((r) => r.id).includes(tid);
    const d2 = await S.applyFeedStaleness(O, [{ file: "teams", meta: { kind: "unreadable" } }], NOW + 1_800_000, 6, store);
    t("S16 a 403 on a fresh file: hidden pending row on the first check (not listed), alert on the 2nd",
      [d1.raised, listedAfterFirst, d2.raised, (await R.listOpenAttention(O)).map((r) => r.id).includes(tid)], [0, false, 1, true]);
    await S.applyFeedStaleness(O, sentFresh, NOW + 2_400_000, 6, store);
    await S.applyFeedStaleness(O, sent403, NOW + 3_000_000, 6, store);
    await S.applyFeedStaleness(O, sentFresh, NOW + 3_600_000, 6, store);
    const e = await S.applyFeedStaleness(O, sent403, NOW + 4_200_000, 6, store);
    t("S17 403 / fresh / 403 is NOT two consecutive: no alert, pending reset by the fresh check", [e.raised, (await vrow()).status, (await vrow()).feed_pending], [0, "replied", "unreadable"]);
    await S.applyFeedStaleness(O, sentTransient, NOW + 4_800_000, 6, store);
    const f = await S.applyFeedStaleness(O, sent403, NOW + 5_400_000, 6, store);
    t("S18 403 / transient / 403 IS two consecutive (transient neither confirms nor resets)", [f.raised, (await vrow()).status, (await vrow()).episode], [1, "owed", "unreadable"]);
    await R.settleEmailReply(vid, "dismissed");
    const g = await S.applyFeedStaleness(O, sentStale, NOW + 6_000_000, 6, store);
    t("S19 dismissed 'unreadable', then the SAME old last-modified again: stays dismissed (not new)", [g.raised, (await vrow()).status], [0, "dismissed"]);
    const h = await S.applyFeedStaleness(O, [{ file: "sent", meta: okMeta("2026-11-12T14:02:00Z") }], U("2026-11-16T15:00:00Z"), 6, store);
    t("S20 dismissed, then a LATER last-modified (still stale): reopens", [h.raised, (await vrow()).status, (await vrow()).episode], [1, "owed", "stale:2026-11-12T14:02:00.000Z"]);
  }
  // Verifier loop 4, 4d (V3): 50 newer open items must not push the feed alert out of the list.
  {
    const P = "busy@eds.example";
    for (let i = 0; i < 60; i++) {
      await pool.query(
        `INSERT INTO chat.email_replies (id, owner_email, mailbox, graph_message_id, kind, status, subject, received_at)
         VALUES ($1, $2, 'busy@eds.example', $1, 'email', 'owed', 'Synthetic', $3)`,
        [`busy-${i}`, P, new Date(U("2026-11-13T12:00:00Z") + i * 60_000).toISOString()],
      );
    }
    await S.applyFeedStaleness(P, stale, NOW, 6, store);
    const list = await R.listOpenAttention(P);
    const fid = S.feedAttentionId(P, "email");
    t("S21 (V3) a stale feed row is listed (first) even behind 60 newer open items; the list stays capped at 50",
      [list.length, list[0]?.id === fid, list.filter((r) => r.kind === "feed").length], [50, true, 1]);
    t("S22 without a feed row the order is unchanged: newest first", (await R.listOpenAttention(O.replace("owner", "nobody"))).length, 0);
    const emailsOnly = (await R.listOpenAttention(P)).filter((r) => r.kind === "email").map((r) => r.id);
    t("S23 the email rows after the feed row are still newest first", emailsOnly.slice(0, 3), ["busy-59", "busy-58", "busy-57"]);
  }
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
