// WHAT:       Verifier loop 7 (U5 re-derivation): the loop-6 stuck-sent.json timeline driven through the REAL
//             runFeedStalenessCheck with a refreshRead that simulates readFeed over a fake drive, against the REAL
//             bell SQL (email-replies.server raise/clear/notePending) on a throwaway local PostgreSQL. Prints observations.
// WHY:        loop 6 U5: an incomplete sent.json whose reader never reads again stayed transient forever.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-7.md
// Harness copied from scripts/verify6-staleness-stuck.ts. All data synthetic (.example).
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
const dir = mkdtempSync(join(tmpdir(), "verify7-"));
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
const P = (id: string, v: unknown) => console.log(`${id.padEnd(70)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const R = await import("../src/features/huddle/lib/email/email-replies.server");
  const S = await import("../src/features/huddle/lib/correspondence/feed-staleness");
  const SS = await import("../src/features/huddle/lib/correspondence/feed-staleness.server");
  const { parseFeedsConfig } = await import("../src/features/huddle/lib/external-feeds/onedrive-feed");
  const pool = getSharedPool();
  const store = { raise: R.raiseFeedAttention, clear: R.clearFeedAttention, notePending: R.notePendingFeedAttention };
  const INC = S.INCOMPLETE_STATUS;
  const scenario = (owner: string) => {
    const cfg = parseFeedsConfig(JSON.stringify({ enabled: true, ownerLogins: [owner], driveUser: "drive@eds.example", mailbox: "work@corp.example", synthetic: true, subjectPrefix: "[TEST]", sent: true, correspondence: { staleAlerts: true } }))!;
    const drive = { lm: 0, complete: true, refreshResult: "real" as "real" | "error" | "null" };
    let last: { status: string; checkedMs: number } | null = null;
    let now = 0;
    const announced: string[] = [];
    const refreshes: string[] = [];
    const check = async (nowIso: string) => {
      now = U(nowIso);
      const rep = await SS.runFeedStalenessCheck(cfg, {
        readMeta: async (_c, path) => (path === cfg.sent.path ? { kind: "ok", lastModifiedMs: drive.lm } : { kind: "ok", lastModifiedMs: now }),
        store,
        now: () => now,
        log: () => {},
        readStatus: async (_c, f) => (f === "sent" ? last : { status: "ok", checkedMs: now }),
        notifyUrgent: async (r: { file: string; nowMs: number }) => (announced.push(`${r.file}@${new Date(r.nowMs).toISOString().slice(5, 16)}`), true),
        refreshRead: async (_c, f) => {
          if (f !== "sent") return null;
          refreshes.push(new Date(now).toISOString().slice(5, 16));
          if (drive.refreshResult === "null") return null;
          last = { status: drive.refreshResult === "error" ? "error" : drive.complete ? "ok" : INC, checkedMs: now };
          return last;
        },
      } as never);
      const r = (await pool.query(`SELECT status FROM chat.email_replies WHERE id=$1`, [S.feedAttentionId(owner, "sent")])).rows[0];
      return `${rep?.states.sent} raised=${rep?.raised} cleared=${rep?.cleared} urgent=${rep?.urgent} row=${r ? r.status : "none"} refreshes=${refreshes.length}`;
    };
    const readerReads = (iso: string) => (last = { status: drive.complete ? "ok" : INC, checkedMs: U(iso) });
    return { drive, check, readerReads, announced, dismiss: () => pool.query(`UPDATE chat.email_replies SET status='dismissed' WHERE id=$1`, [S.feedAttentionId(owner, "sent")]) };
  };
  const A = scenario("oa@eds.example");
  A.drive.lm = U("2026-11-16T14:50:00Z"); A.drive.complete = false; A.readerReads("2026-11-16T15:00:00Z");
  P("A1 Mon 10:10 ET reader read incomplete copy", await A.check("2026-11-16T15:10:00Z"));
  A.drive.lm = U("2026-11-16T15:55:00Z"); A.drive.complete = true;
  P("A2 Mon 11:10 flow FIXED (complete copy 10:55), no reader", await A.check("2026-11-16T16:10:00Z"));
  P("A3 Mon 12:10 same copy", await A.check("2026-11-16T17:10:00Z"));
  P("A  urgent announcements", A.announced);
  const B = scenario("ob@eds.example");
  B.drive.lm = U("2026-11-16T14:50:00Z"); B.drive.complete = false; B.readerReads("2026-11-16T15:00:00Z");
  P("B1 Mon 10:10 incomplete", await B.check("2026-11-16T15:10:00Z"));
  await B.dismiss();
  B.drive.lm = U("2026-11-16T15:55:00Z"); B.drive.complete = true;
  P("B2 Mon 11:10 dismissed; flow fixed, unread", await B.check("2026-11-16T16:10:00Z"));
  P("B3 Fri 12:10 flow STOPPED since Mon 10:55 (4 working days)", await B.check("2026-11-20T17:10:00Z"));
  P("B  urgent announcements", B.announced);
  const C = scenario("oc@eds.example");
  C.drive.lm = U("2026-11-16T14:50:00Z"); C.drive.complete = false; C.readerReads("2026-11-16T15:00:00Z");
  P("C1 Mon 10:10 incomplete", await C.check("2026-11-16T15:10:00Z"));
  C.drive.lm = U("2026-11-16T15:55:00Z");
  P("C2 Mon 11:10 newer copy ALSO incomplete", await C.check("2026-11-16T16:10:00Z"));
  C.drive.lm = U("2026-11-16T16:55:00Z");
  P("C3 Mon 12:10 another incomplete copy", await C.check("2026-11-16T17:10:00Z"));
  P("C  urgent announcements", C.announced);
  const D = scenario("od@eds.example");
  D.drive.lm = U("2026-11-16T14:50:00Z"); D.drive.complete = false; D.readerReads("2026-11-16T15:00:00Z");
  P("D1 Mon 10:10 incomplete", await D.check("2026-11-16T15:10:00Z"));
  D.drive.lm = U("2026-11-16T15:55:00Z"); D.drive.refreshResult = "error";
  P("D2 Mon 11:10 newer copy still incomplete; refresh -> 'error'", await D.check("2026-11-16T16:10:00Z"));
  D.drive.refreshResult = "real"; D.readerReads("2026-11-16T16:30:00Z");
  P("D3 Mon 12:10 reader reads it: incomplete", await D.check("2026-11-16T17:10:00Z"));
  P("D  urgent announcements", D.announced);
  const E = scenario("oe@eds.example");
  E.drive.lm = U("2026-11-16T14:50:00Z"); E.drive.complete = false; E.readerReads("2026-11-16T15:00:00Z");
  P("E1 Mon 10:10 incomplete", await E.check("2026-11-16T15:10:00Z"));
  E.drive.lm = U("2026-11-16T15:55:00Z"); E.drive.complete = true; E.drive.refreshResult = "null";
  P("E2 Mon 11:10 fixed copy, refresh returns null", await E.check("2026-11-16T16:10:00Z"));
  await pool.end();
} catch (e) {
  console.log("HARNESS ERROR:", e instanceof Error ? e.stack : e);
} finally {
  stop();
}
