// WHAT:       Verifier loop 5: the URGENT incomplete-file alert (claims 15/16) and staleness 4c/4d (claims 5/6) driven
//             through the real applyFeedStaleness against the REAL bell SQL (raise/clear/notePending/listOpenAttention
//             in email-replies.server.ts) on a throwaway local PostgreSQL. Prints observations; asserts nothing.
// WHY:        The implementer's SQL suite (scripts/feed-staleness-sql.test.ts) has no incomplete case; the 22 new
//             incomplete tests run only against the in-memory twin.
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
const dir = mkdtempSync(join(tmpdir(), "verify5-"));
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
const P = (id: string, v: unknown) => console.log(`${id.padEnd(78)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const R = await import("../src/features/huddle/lib/email/email-replies.server");
  const S = await import("../src/features/huddle/lib/correspondence/feed-staleness");
  const pool = getSharedPool();
  const store = { raise: R.raiseFeedAttention, clear: R.clearFeedAttention, notePending: R.notePendingFeedAttention };
  let announced: string[] = [];
  const notify = async (r: { file: string; nowMs: number }) => {
    announced.push(`${r.file}@${new Date(r.nowMs).toISOString()}`);
    return true;
  };
  const row = async (rid: string) => (await pool.query(`SELECT status, graph_message_id ep, received_at FROM chat.email_replies WHERE id=$1`, [rid])).rows[0] ?? null;
  const chkFor = (owner: string) => async (nowIso: string, lmIso: string, readIso: string | null, file: "email" | "sent" = "email") => {
    const read = readIso ? { status: S.INCOMPLETE_STATUS, checkedMs: U(readIso) } : null;
    const rep = await S.applyFeedStaleness(owner, [{ file, meta: { kind: "ok", lastModifiedMs: U(lmIso) }, read }], U(nowIso), 6, store, notify);
    const r = await row(S.feedAttentionId(owner, file));
    return `${rep.states[file]} raised=${rep.raised} urgent=${rep.urgent} row=${r ? `${r.status}/${r.ep}/rcv=${r.received_at ? new Date(r.received_at).toISOString() : null}` : "none"}`;
  };
  const chk = chkFor(O);
  const id = S.feedAttentionId(O, "email");

  // U1: ONE ongoing incident (every copy the flow publishes is complete:false); the reader does not run overnight.
  P("U1a Thu 22:10 ET: reader saw lm1 (21:30) incomplete at 22:00", await chk("2026-11-13T03:10:00Z", "2026-11-13T02:30:00Z", "2026-11-13T03:00:00Z"));
  P("U1b Thu 22:20: re-check", await chk("2026-11-13T03:20:00Z", "2026-11-13T02:30:00Z", "2026-11-13T03:00:00Z"));
  P("U1c Thu 23:10: flow republished (incomplete) at 23:00, not read yet", await chk("2026-11-13T04:10:00Z", "2026-11-13T04:00:00Z", "2026-11-13T03:00:00Z"));
  P("U1d Fri 00:10: last read 2h10m ago", await chk("2026-11-13T05:10:00Z", "2026-11-13T04:00:00Z", "2026-11-13T03:00:00Z"));
  P("U1e Fri 07:10: hourly reader read the 23:00 copy -> still incomplete", await chk("2026-11-13T12:10:00Z", "2026-11-13T04:00:00Z", "2026-11-13T12:00:00Z"));
  P("U1  announcements for ONE incident (no complete file ever read)", announced);

  // U2: dismissed incomplete row, same incident.
  await pool.query(`UPDATE chat.email_replies SET status='dismissed' WHERE id=$1`, [id]);
  announced = [];
  P("U2a dismissed; reader re-reads same incomplete copy", await chk("2026-11-13T13:10:00Z", "2026-11-13T04:00:00Z", "2026-11-13T13:00:00Z"));
  P("U2b dismissed; flow republishes (incomplete), reader reads it within 2h", await chk("2026-11-13T14:10:00Z", "2026-11-13T13:30:00Z", "2026-11-13T14:00:00Z"));
  P("U2  announcements", announced);

  // U3: an OPEN stale row (sent) turns incomplete; then the reader lags.
  announced = [];
  P("U3a sent: stale (lm Wed 9:02 ET)", await chk("2026-11-13T15:00:00Z", "2026-11-11T14:02:00Z", null, "sent"));
  P("U3b sent: reader records incomplete for that copy", await chk("2026-11-13T15:10:00Z", "2026-11-11T14:02:00Z", "2026-11-13T15:05:00Z", "sent"));
  P("U3c sent: re-check", await chk("2026-11-13T15:20:00Z", "2026-11-11T14:02:00Z", "2026-11-13T15:15:00Z", "sent"));
  P("U3d sent: republished (incomplete) Fri 9:00 ET, unread 2h+", await chk("2026-11-13T17:30:00Z", "2026-11-13T14:00:00Z", "2026-11-13T15:15:00Z", "sent"));
  P("U3e sent: Fri 3pm ET reader reads sent again", await chk("2026-11-13T20:10:00Z", "2026-11-13T14:00:00Z", "2026-11-13T20:00:00Z", "sent"));
  P("U3  announcements", announced);

  // U4: row CREATED as incomplete -> received_at NULL; dismissed; then stale; then incomplete again.
  const O2 = "o2@eds.example";
  const chk2 = chkFor(O2);
  const tid = S.feedAttentionId(O2, "email");
  announced = [];
  P("U4a Mon: incomplete (new row)", await chk2("2026-11-16T15:10:00Z", "2026-11-16T14:00:00Z", "2026-11-16T15:00:00Z"));
  await pool.query(`UPDATE chat.email_replies SET status='dismissed' WHERE id=$1`, [tid]);
  P("U4b dismissed; republished incomplete 10:30 ET, unread 2h+, now Tue 12:10 ET", await chk2("2026-11-17T17:10:00Z", "2026-11-16T15:30:00Z", "2026-11-16T15:00:00Z"));
  P("U4c reader reads that copy -> incomplete", await chk2("2026-11-17T17:20:00Z", "2026-11-16T15:30:00Z", "2026-11-17T17:15:00Z"));
  P("U4  announcements", announced);

  // 4c (V1/V2): transient never moves a dismissed row; one 403 on a fresh file raises nothing.
  const O3 = "o3@eds.example";
  const vid = S.feedAttentionId(O3, "email");
  const ap = (meta: any, nowIso: string) => S.applyFeedStaleness(O3, [{ file: "email", meta }], U(nowIso), 6, store, notify);
  await ap({ kind: "ok", lastModifiedMs: U("2026-11-11T14:02:00Z") }, "2026-11-13T15:00:00Z");
  await pool.query(`UPDATE chat.email_replies SET status='dismissed' WHERE id=$1`, [vid]);
  await ap({ kind: "transient" }, "2026-11-13T15:10:00Z");
  P("V1 dismissed stale + transient", (await row(vid)).status);
  await ap({ kind: "unreadable" }, "2026-11-13T15:20:00Z");
  P("V1 dismissed stale + ONE 403", (await row(vid)).status);
  await ap({ kind: "transient" }, "2026-11-13T15:30:00Z");
  await ap({ kind: "unreadable" }, "2026-11-13T15:40:00Z");
  P("V1 dismissed stale + 403, transient, 403", `${(await row(vid)).status}/${(await row(vid)).ep}`);
  await ap({ kind: "ok", lastModifiedMs: U("2026-11-11T14:02:00Z") }, "2026-11-13T15:50:00Z");
  P("V1 then the SAME old stale file again", `${(await row(vid)).status}/${(await row(vid)).ep}`);
  const O4 = "o4@eds.example";
  await S.applyFeedStaleness(O4, [{ file: "email", meta: { kind: "unreadable" } }], U("2026-11-13T15:00:00Z"), 6, store, notify);
  P("V2 fresh owner, ONE 403: listed", (await R.listOpenAttention(O4)).length);
  await S.applyFeedStaleness(O4, [{ file: "email", meta: { kind: "ok", lastModifiedMs: U("2026-11-13T14:50:00Z") } }], U("2026-11-13T15:10:00Z"), 6, store, notify);
  await S.applyFeedStaleness(O4, [{ file: "email", meta: { kind: "unreadable" } }], U("2026-11-13T15:20:00Z"), 6, store, notify);
  P("V2 403, fresh, 403: listed", (await R.listOpenAttention(O4)).length);
  await S.applyFeedStaleness(O4, [{ file: "email", meta: { kind: "unreadable" } }], U("2026-11-13T15:30:00Z"), 6, store, notify);
  P("V2 ... then a 2nd consecutive 403: listed", (await R.listOpenAttention(O4)).length);

  // 4d (V3): 60 newer open email rows; the feed row's received_at is 12 days older.
  const O5 = "o5@eds.example";
  const lid = S.feedAttentionId(O5, "email");
  await S.applyFeedStaleness(O5, [{ file: "email", meta: { kind: "ok", lastModifiedMs: U("2026-11-01T14:02:00Z") } }], U("2026-11-13T15:00:00Z"), 6, store, notify);
  for (let i = 0; i < 60; i++)
    await pool.query(
      `INSERT INTO chat.email_replies (id, owner_email, mailbox, graph_message_id, kind, status, received_at) VALUES ($1,$2,'',$1,'email','owed', now() - ($3 || ' minutes')::interval)`,
      [`e${i}`, O5, String(i)],
    );
  const L = await R.listOpenAttention(O5);
  P("V3 listOpenAttention: n, feed row first, present", [L.length, L[0].id === lid, L.some((r) => r.id === lid)]);
  P("V3 non-feed rows still newest-first", L.slice(1).every((r, i, a) => i === 0 || Date.parse(String(a[i - 1].received_at)) >= Date.parse(String(r.received_at))));
  const O6 = "o6@eds.example";
  for (let i = 0; i < 5; i++)
    await pool.query(
      `INSERT INTO chat.email_replies (id, owner_email, mailbox, graph_message_id, kind, status, received_at) VALUES ($1,$2,'',$1,$3,'owed', now() - ($4 || ' minutes')::interval)`,
      [`n${i}`, O6, i % 2 ? "meeting" : "email", String(i * 7)],
    );
  P("V3 no feed rows: order == main's ORDER BY", (await R.listOpenAttention(O6)).map((r) => r.id));
  await pool.end();
} catch (e) {
  console.log("HARNESS ERROR:", e instanceof Error ? e.stack : e);
} finally {
  stop();
}
