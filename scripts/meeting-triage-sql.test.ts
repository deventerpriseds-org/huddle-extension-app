// WHAT:       Runs the REAL meeting-triage store SQL (lib/proposals/proposals-store.server.ts) against a throwaway
//             local PostgreSQL that starts with the OLD `chat.task_proposals` state CHECK: the idempotent
//             migration, untriaged rows, the Mine / For someone / Skip compare-and-set under concurrency, Mine
//             merging into an already-active proposal, Skip memory, the active list, the meeting queue read, and
//             the rule that a Skipped meeting item never suppresses the same to-do from email.
// WHY:        AC docs/qc-evidence/AC-correspondence-redesign.md AC-R5.11, R5.13, R5.14, R5.17 (Tier 1). An
//             in-memory twin mirrors what the author THINKS the SQL does; this runs the SQL itself.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-meeting-triage.md.
//
// Run: bun scripts/meeting-triage-sql.test.ts   (needs PostgreSQL 16/17 binaries; SKIPS cleanly without)
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposalId, type NewProposal } from "../src/features/huddle/lib/proposals/proposals";
import { triageRowsFor } from "../src/features/huddle/lib/proposals/meeting-triage";

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin"].find((d) => existsSync(join(d, "initdb")));
if (!BIN) {
  console.log("SKIP: no PostgreSQL binaries found");
  process.exit(0);
}
const PORT = 55000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), "triage-"));
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
const OTHER = "someone-else@eds.example";
const AT = "2026-11-10T14:00:00.000Z";
const emailCand = (title: string, sid: string): NewProposal => {
  const norm = title.toLowerCase();
  return { id: proposalId(O, { source: "email", sourceItemId: sid }, norm), owner: O, title, normTitle: norm, evidence: `please ${norm} soon`, assignee: null, dueText: null, dueDate: null, ref: { source: "email", sourceItemId: sid, at: AT, context: "Test-context" } };
};
// triageRowsFor uses titleKey for the dedup key; email candidates above use lower-case. Keep titles where both agree.
const meeting = (id: string, items: string[]) => triageRowsFor(O, { meetingId: id, title: "Test-Planning", meetingAt: AT }, items);

/** The table exactly as the ORIGINAL bootstrap (b7ddbdca) created it: the OLD four-state CHECK. */
const OLD_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE chat.task_proposals (
  id TEXT PRIMARY KEY CHECK (id LIKE 'prop-%'),
  owner_email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','approved','completed','dismissed')),
  title TEXT NOT NULL, original_title TEXT NOT NULL, norm_title TEXT NOT NULL, edited BOOLEAN NOT NULL DEFAULT false,
  evidence TEXT NOT NULL, assignee TEXT, due_text TEXT, due_date DATE, sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  task_id TEXT, approve_lease_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ
);`;

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const pool = getSharedPool();
  const stateChecks = async () =>
    (await pool.query(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='chat.task_proposals'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%state%'`)).rows as Array<{ conname: string; d: string }>;

  // ── AC-R5.13: start from the OLD constraint ─────────────────────────────────────────────────────
  await pool.query(OLD_SCHEMA);
  const old = emailCand("Test-Pay the invoice", "mbx:OLD1");
  await pool.query(`INSERT INTO chat.task_proposals (id, owner_email, title, original_title, norm_title, evidence, sources) VALUES ($1,$2,$3,$3,$4,$5,'[]'::jsonb)`, [old.id, O, old.title, old.normTitle, old.evidence]);
  let oldRefuses = false;
  try {
    await pool.query(`INSERT INTO chat.task_proposals (id, owner_email, state, title, original_title, norm_title, evidence) VALUES ('prop-ffff01',$1,'untriaged','t','t','t','e')`, [O]);
  } catch {
    oldRefuses = true;
  }
  t("AC-R5.13 precondition: the OLD table refuses 'untriaged'", oldRefuses, true);

  const { pgProposalStore: S } = await import("../src/features/huddle/lib/proposals/proposals-store.server");
  const m1 = meeting("ff-1", ["Test-Draft the plan", "Test-Order the chairs", "Test-Clean the board", "Test-Pay the invoice"]);
  // First store call: bootstrap + migration run here. A failure is reported under the named check below.
  const added = await S.addTriageRows(m1).catch(() => ({ created: [] as string[], existing: [] as string[] }));
  t("AC-R5.13 after bootstrap the OLD table accepts untriaged rows (migration ran)", [added.created.length, added.existing.length], [4, 0]);
  t("AC-R5.13 exactly ONE state CHECK, now allowing untriaged + delegated", (await stateChecks()).map((c) => [c.conname, /untriaged/.test(c.d) && /delegated/.test(c.d)]), [["task_proposals_state_check", true]]);
  t("AC-R5.13 the pre-existing row survived the migration untouched", (await S.getMany([O], [old.id])).map((r) => [r.state, r.title]), [["proposed", "Test-Pay the invoice"]]);
  t("AC-R5.13 NO new table (still exactly the two proposal tables)", (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='chat' ORDER BY 1`)).rows.map((r) => r.table_name), ["task_proposal_refs", "task_proposals"]);
  {
    // Idempotent: the SHIPPED bootstrap text, run twice more, changes nothing and does not error.
    const src = readFileSync(join(import.meta.dir, "../src/features/huddle/lib/proposals/proposals-store.server.ts"), "utf8");
    const sql = src.slice(src.indexOf("const BOOTSTRAP_SQL = `") + "const BOOTSTRAP_SQL = `".length, src.indexOf("`;", src.indexOf("const BOOTSTRAP_SQL = `")));
    let err = "";
    try {
      await pool.query(sql);
      await Promise.all([pool.query(sql), pool.query(sql)]);
    } catch (e) {
      err = e instanceof Error ? e.message : "error";
    }
    t("AC-R5.13 the bootstrap re-runs (also two at once) without error", err, "");
    t("AC-R5.13 still exactly one state CHECK after re-runs", (await stateChecks()).length, 1);
    let bad = false;
    try {
      await pool.query(`INSERT INTO chat.task_proposals (id, owner_email, state, title, original_title, norm_title, evidence) VALUES ('prop-ffff02',$1,'bogus','t','t','t','e')`, [O]);
    } catch {
      bad = true;
    }
    t("AC-R5.13 the new CHECK still refuses an unknown state", bad, true);
  }

  // ── AC-R5.6/R5.11 the refs are the memory ───────────────────────────────────────────────────────
  t("AC-R5.6 the same meeting's items again -> all existing, nothing created", await S.addTriageRows(m1).then((r) => [r.created.length, r.existing.length]), [0, 4]);
  t("AC-R5.14 untriaged rows are NOT in the active list (only the old proposed row)", (await S.listActive([O])).map((r) => r.id), [old.id]);
  t("listUntriaged returns the 4 rows, oldest first", (await S.listUntriaged([O])).length, 4);
  t("owner scoping: another owner sees none", [(await S.listUntriaged([OTHER])).length, (await S.getMany([OTHER], added.created)).length], [0, 0]);

  const [plan, chairs, board, invoice] = added.created;
  // AC-R5.17: two taps at once on one row -> exactly one applies.
  const both = await Promise.all([S.triage([O], plan, "proposed", null), S.triage([O], plan, "dismissed", null)]);
  t("AC-R5.17 concurrent Mine + Skip -> exactly ONE applied", both.filter((x) => x.applied).length, 1);
  const planState = (await S.getMany([O], [plan]))[0].state;
  t("AC-R5.17 the row holds the winner's state", ["proposed", "dismissed"].includes(planState), true);
  t("AC-R5.17 a third tap is not applied (CAS on untriaged)", (await S.triage([O], plan, "delegated", "Pat")).applied, false);
  t("another owner cannot triage", (await S.triage([OTHER], chairs, "proposed", null)).applied, false);

  const d = await S.triage([O], chairs, "delegated", "Pat");
  t("AC-R5.10 For someone -> delegated, assignee text kept, decided_at set", [d.applied, d.row?.state, d.row?.assignee, !!d.row?.decidedAt], [true, "delegated", "Pat", true]);
  const k = await S.triage([O], board, "dismissed", null);
  t("AC-R5.11 Skip -> dismissed", [k.applied, k.row?.state], [true, "dismissed"]);
  t("AC-R5.11 the Skip is kept in task_proposal_refs (dedup memory)", Number((await pool.query(`SELECT count(*) n FROM chat.task_proposal_refs WHERE proposal_id=$1 AND source='transcript'`, [board])).rows[0].n), 1);
  const resend = await S.addTriageRows(meeting("ff-1", ["Test-Clean the board", "Test-Order the chairs", "Test-Book the van"]));
  t("AC-R5.11 / R5.7 re-sent minutes: skipped + delegated not re-created; only the NEW item is", [resend.created.length, resend.existing.length, (await S.getMany([O], [board]))[0].state], [1, 2, "dismissed"]);
  t("AC-R5.14 delegated / dismissed / untriaged never in the active list", (await S.listActive([O])).every((r) => r.state === "proposed"), true);

  // ── OQ-9: Mine on a to-do already active from email -> merged, ONE active row ─────────────────
  const m = await S.triage([O], invoice, "proposed", null);
  t("OQ-9 Mine on an active to-do -> applied, merged into the existing proposal", [m.applied, m.mergedInto?.id, m.row?.state], [true, old.id, "dismissed"]);
  t("OQ-9 still ONE active row for that to-do, now with the meeting source", [Number((await pool.query(`SELECT count(*) n FROM chat.task_proposals WHERE norm_title=$1 AND state='proposed'`, [old.normTitle])).rows[0].n), (await S.getMany([O], [old.id]))[0].sources.map((s) => s.source)], [1, ["transcript"]]);
  t("OQ-9 the meeting's ref now points at the active proposal", (await pool.query(`SELECT proposal_id FROM chat.task_proposal_refs WHERE source='transcript' AND source_item_id='ff-1' AND norm_title=$1`, [old.normTitle])).rows.map((r) => r.proposal_id), [old.id]);

  // ── AC-R5.9 Mine -> a normal proposal in the evening list ───────────────────────────────────────
  const [van] = resend.created;
  const mv = await S.triage([O], van, "proposed", null);
  t("AC-R5.9 Mine -> state proposed, decided_at empty, in the active list", [mv.row?.state, mv.row?.decidedAt, (await S.listActive([O])).some((r) => r.id === van)], ["proposed", null, true]);
  const again = await S.triage([O], van, "proposed", null);
  t("AC-R5.17 Mine tapped again on a row already Mine -> not applied, no self-merge", [again.applied, again.mergedInto ?? null, (await S.getMany([O], [van]))[0].state], [false, null, "proposed"]);
  t("AC-R5.9 an email of the SAME to-do now attaches to the Mine row (one proposal)", await S.upsert(emailCand("Test-Book the van", "mbx:VAN")).then((r) => [r.kind, r.id]), ["attached", van]);

  // ── A Skipped meeting item never suppresses the same to-do from email (F15 + AC-R5.11) ──────────
  const boardNorm = (await S.getMany([O], [board]))[0].normTitle;
  t("Skip of a meeting item does NOT appear as a cross-source dismissal", (await S.priorRelated([O], { source: "email", sourceItemId: "mbx:NEW" }, boardNorm)).length, 0);
  const e2 = emailCand("Test-Water the plants", "mbx:W1");
  await S.upsert(e2);
  await S.decide([O], e2.id, "dismissed");
  t("F15 unchanged: an EMAIL dismissal still suppresses the same to-do elsewhere", (await S.priorRelated([O], { source: "teams", sourceItemId: "c:1" }, e2.normTitle)).map((p) => p.state), ["dismissed"]);

  // ── The report read (exposure for "Meeting action items for you") ──────────────────────────────
  const q = await S.listMeetingQueue([O]);
  const byState = (s: string) => q.filter((r) => r.meetingId === "ff-1" && r.state === s).map((r) => r.title).sort();
  t("listMeetingQueue: every row reached through the meeting's refs, with its meeting id", [q.every((r) => r.meetingId === "ff-1"), byState("delegated"), byState("dismissed").includes("Test-Clean the board")], [true, ["Test-Order the chairs"], true]);
  t("listMeetingQueue: the merged Mine shows as the active email proposal under the meeting", q.some((r) => r.id === old.id && r.state === "proposed"), true);
  t("listMeetingQueue: another owner sees nothing", (await S.listMeetingQueue([OTHER])).length, 0);

  // Cleanup: nothing remains.
  await pool.query(`DELETE FROM chat.task_proposal_refs`);
  await pool.query(`DELETE FROM chat.task_proposals`);
  t("cleanup leaves zero rows", Number((await pool.query(`SELECT count(*) n FROM chat.task_proposals`)).rows[0].n), 0);
  await pool.end();
} catch (e) {
  fail++;
  console.log("FAIL harness:", e instanceof Error ? e.message : e);
} finally {
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
