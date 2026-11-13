// WHAT:       Verifier loop-4 SQL probes of the feed-staleness bell rows against a throwaway local PostgreSQL:
//             transient-failure flicker, dismiss across an unreadable blip, LIMIT-50 ordering, text refresh.
// WHY:        The bell SQL (raiseFeedAttention / clearFeedAttention) decides what the owner sees.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-4.md
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
const dir = mkdtempSync(join(tmpdir(), "v4stale-"));
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

const O = "owner@eds.example";
const U = (iso: string) => Date.parse(iso);

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const R = await import("../src/features/huddle/lib/email/email-replies.server");
  const S = await import("../src/features/huddle/lib/correspondence/feed-staleness");
  const pool = getSharedPool();
  const store = { raise: R.raiseFeedAttention, clear: R.clearFeedAttention };
  const id = S.feedAttentionId(O, "email");
  const rowOf = async (rid = id) =>
    (await pool.query(`SELECT kind, status, graph_message_id AS episode, subject, received_at FROM chat.email_replies WHERE id=$1`, [rid])).rows[0];
  const chk = (m: S.FeedMeta, now: string) => S.applyFeedStaleness(O, [{ file: "email", meta: m }], U(now), 6, store);
  const OLD: S.FeedMeta = { kind: "ok", lastModifiedMs: U("2026-11-11T14:02:00Z") };
  const UNR: S.FeedMeta = { kind: "unreadable" };
  const NEW: S.FeedMeta = { kind: "ok", lastModifiedMs: U("2026-11-13T14:50:00Z") };

  // V1: stale raised, owner dismisses, ONE transient unreadable check, then the same stale file again
  await chk(OLD, "2026-11-13T15:00:00Z");
  console.log("PROBE V1a after stale raise", JSON.stringify(await rowOf()));
  await R.settleEmailReply(id, "dismissed");
  console.log("PROBE V1b after dismiss", (await rowOf()).status);
  const b = await chk(UNR, "2026-11-13T15:10:00Z");
  console.log("PROBE V1c after ONE unreadable check", JSON.stringify({ rep: b, status: (await rowOf()).status, episode: (await rowOf()).episode }));
  const c = await chk(OLD, "2026-11-13T15:20:00Z");
  console.log("PROBE V1d same stale file again", JSON.stringify({ rep: c, status: (await rowOf()).status, episode: (await rowOf()).episode }));

  // V2: fresh file, one transient unreadable check -> bell row; next fresh check clears
  await pool.query(`DELETE FROM chat.email_replies`);
  await chk(NEW, "2026-11-13T15:00:00Z");
  const d = await chk(UNR, "2026-11-13T15:10:00Z");
  console.log("PROBE V2a fresh file, one unreadable blip", JSON.stringify({ rep: d, row: await rowOf() }));
  const e2 = await chk(NEW, "2026-11-13T15:20:00Z");
  console.log("PROBE V2b next fresh check", JSON.stringify({ rep: e2, status: (await rowOf()).status }));

  // V3: LIMIT 50 -- 50 open emails newer than the stale file's lastModified
  await pool.query(`DELETE FROM chat.email_replies`);
  await chk(OLD, "2026-11-13T15:00:00Z");
  for (let i = 0; i < 50; i++)
    await pool.query(
      `INSERT INTO chat.email_replies (id, owner_email, mailbox, graph_message_id, kind, status, subject, received_at) VALUES ($1, $2, 'm', $1, 'email', 'owed', 's', $3)`,
      [`e${i}`, O, new Date(U("2026-11-12T12:00:00Z") + i * 60_000).toISOString()],
    );
  const open = await R.listOpenAttention(O);
  console.log("PROBE V3 50 newer open emails: feed row listed?", JSON.stringify({ n: open.length, feedListed: open.some((r) => r.kind === "feed") }));

  // V4: open row text refresh as hours pass (same episode)
  await pool.query(`DELETE FROM chat.email_replies`);
  const w: number[] = [];
  for (const now of ["2026-11-13T15:00:00Z", "2026-11-13T15:10:00Z", "2026-11-13T16:05:00Z"]) w.push((await chk(OLD, now)).raised);
  console.log("PROBE V4 raised per check", JSON.stringify(w), JSON.stringify((await rowOf()).subject), (await rowOf()).status);

  // V5: settleAttentionForHuddle (owner talks to Iris) does not clear the feed row
  console.log("PROBE V5 talk to Iris settles", await R.settleAttentionForHuddle(O, "dm-iris-chase"), (await rowOf()).status);
  await pool.end();
} catch (e) {
  console.log("HARNESS FAIL", e instanceof Error ? e.message : e);
} finally {
  stop();
}
