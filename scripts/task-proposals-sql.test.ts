// WHAT:       Runs the REAL task-proposal store SQL (lib/proposals/proposals-store.server.ts, unmodified) against
//             a throwaway local PostgreSQL: create / seen / cross-source attach, decided rows never re-proposed,
//             edits never overwritten, the Approve compare-and-set lease under concurrency, Dismiss vs Approve,
//             owner scoping, concurrent upserts, and a schema check that no body/sender column exists.
// WHY:        AC docs/ac/AC-correspondence-checklist.md AC-5.4/5.5/5.8/5.11-5.13/5.21 (Tier 1). An in-memory
//             twin mirrors what the author THINKS the SQL does; this exercises the SQL itself (the lesson of
//             scripts/fireflies-queue-sql.test.ts).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-task-proposals.md.
//
// Run: bun scripts/task-proposals-sql.test.ts   (needs PostgreSQL 16/17 binaries; SKIPS cleanly without)
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposalId, type NewProposal } from "../src/features/huddle/lib/proposals/proposals";

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin"].find((d) => existsSync(join(d, "initdb")));
if (!BIN) {
  console.log("SKIP: no PostgreSQL binaries found");
  process.exit(0);
}
const PORT = 55000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), "prop-"));
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
const cand = (title: string, norm: string, source: "email" | "teams" | "transcript", sid: string, owner = O): NewProposal => ({
  id: proposalId(owner, { source, sourceItemId: sid }, norm),
  owner,
  title,
  normTitle: norm,
  evidence: `please ${norm} soon`,
  assignee: null,
  dueText: null,
  dueDate: null,
  ref: { source, sourceItemId: sid, at: "2026-11-10T14:00:00.000Z", context: "Test-context" },
});

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { pgProposalStore: S } = await import("../src/features/huddle/lib/proposals/proposals-store.server");
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const pool = getSharedPool();
  const refs = async (id: string) => Number((await pool.query(`SELECT count(*) n FROM chat.task_proposal_refs WHERE proposal_id=$1`, [id])).rows[0].n);
  const nProps = async (norm: string) => Number((await pool.query(`SELECT count(*) n FROM chat.task_proposals WHERE norm_title=$1`, [norm])).rows[0].n);

  // ── create / seen / attach ──────────────────────────────────────────────────────────────────────
  const a = cand("Test-Send the Q3 deck", "test-send the q3 deck", "teams", "c1:m1");
  const r1 = await S.upsert(a);
  t("AC-5.4 first candidate -> created (bootstrap ran)", r1, { kind: "created", id: a.id });
  t("AC-5.21 same source item + same to-do again -> seen, no new row", await S.upsert(a), { kind: "seen", id: a.id });
  const b = cand("Test-send the Q3 deck.", "test-send the q3 deck", "email", "mbx:AAA1");
  t("OQ-9 same to-do from ANOTHER source -> attached to the active proposal", await S.upsert(b), { kind: "attached", id: a.id });
  {
    const [row] = await S.getMany([O], [a.id]);
    t("OQ-9 one proposal, both source refs kept", [row.sources.map((s) => s.source), await refs(a.id), await nProps(a.normTitle)], [["teams", "email"], 2, 1]);
    t("AC-5.19 source refs carry kind + provider id + time", row.sources[1], { source: "email", sourceItemId: "mbx:AAA1", at: "2026-11-10T14:00:00.000Z", context: "Test-context" });
    t("AC-5.5 new row is proposed with no decision time", [row.state, row.decidedAt, row.taskId], ["proposed", null, null]);
  }
  t("AC-5.4 bootstrap is idempotent (second store import re-runs nothing harmful)", (await S.listActive([O])).length, 1);

  // ── edit (AC-5.11) ──────────────────────────────────────────────────────────────────────────────
  const e1 = await S.edit([O], a.id, "Test-Send the Q3 deck to Pat");
  t("AC-5.11 edit on a proposed row is stored", [e1.applied, e1.row?.title, e1.row?.edited, e1.row?.originalTitle], [true, "Test-Send the Q3 deck to Pat", true, "Test-Send the Q3 deck"]);
  await S.upsert(a);
  t("AC-5.11 a re-read of the source does NOT overwrite the edit", (await S.getMany([O], [a.id]))[0].title, "Test-Send the Q3 deck to Pat");

  // ── owner scoping (AC-5.4) ──────────────────────────────────────────────────────────────────────
  t("AC-5.4 another owner cannot read it", await S.getMany([OTHER], [a.id]), []);
  t("AC-5.4 another owner cannot approve it", await S.claimApprove([OTHER], a.id, 60), { claimed: false, row: null });
  t("AC-5.4 another owner cannot dismiss it", await S.decide([OTHER], a.id, "dismissed"), { applied: false, row: null });
  t("AC-5.4 another owner cannot edit it", (await S.edit([OTHER], a.id, "x")).applied, false);
  t("AC-5.4 owner matched case-insensitively", (await S.getMany(["OWNER@EDS.example"], [a.id])).length, 1);

  // ── approve CAS (AC-5.8) ────────────────────────────────────────────────────────────────────────
  const [c1, c2] = await Promise.all([S.claimApprove([O], a.id, 60), S.claimApprove([O], a.id, 60)]);
  t("AC-5.8 two concurrent Approve claims -> exactly one wins", [c1.claimed, c2.claimed].filter(Boolean).length, 1);
  t("AC-5.8 Dismiss while Approve holds the lease -> not applied", (await S.decide([O], a.id, "dismissed")).applied, false);
  t("AC-5.11 Edit while Approve holds the lease -> not applied", (await S.edit([O], a.id, "x")).applied, false);
  const fin = await S.finishApprove(a.id, "11111111-2222-4333-8444-555555555555");
  t("AC-5.9 finish stores the journey task id, state approved", [fin?.state, fin?.taskId, !!fin?.decidedAt], ["approved", "11111111-2222-4333-8444-555555555555", true]);
  t("AC-5.8 a second finish is a no-op", await S.finishApprove(a.id, "other"), null);
  t("AC-5.8 claim on an approved row -> not claimed, row returned", [(await S.claimApprove([O], a.id, 60)).claimed, (await S.claimApprove([O], a.id, 60)).row?.state], [false, "approved"]);
  t("AC-5.5 decided row leaves the active queue", (await S.listActive([O])).map((r) => r.id), []);
  t("AC-5.5 decided row kept for audit (evidence, refs)", [(await S.getMany([O], [a.id]))[0].evidence, await refs(a.id)], ["please test-send the q3 deck soon", 2]);

  // ── release (crashed / failed approve) ──────────────────────────────────────────────────────────
  const d = cand("Test-Update the budget", "test-update the budget", "transcript", "ff-meeting-1");
  await S.upsert(d);
  t("AC-5.8 lease claimed", (await S.claimApprove([O], d.id, 60)).claimed, true);
  await S.releaseApprove(d.id);
  t("AC-5.3 a failed approve releases the row: claimable again", (await S.claimApprove([O], d.id, 60)).claimed, true);
  await pool.query(`UPDATE chat.task_proposals SET approve_lease_until = now() - interval '1 s' WHERE id=$1`, [d.id]);
  t("AC-5.8 an EXPIRED lease (killed pass) is claimable again", (await S.claimApprove([O], d.id, 60)).claimed, true);
  await S.releaseApprove(d.id);

  // ── mark done / dismiss (AC-5.12, 5.13) ─────────────────────────────────────────────────────────
  const done = await S.decide([O], d.id, "completed");
  t("AC-5.13 Mark done -> completed, no task id", [done.applied, done.row?.state, done.row?.taskId], [true, "completed", null]);
  t("AC-5.13 decide twice -> second not applied, current state returned", [(await S.decide([O], d.id, "dismissed")).applied, (await S.decide([O], d.id, "dismissed")).row?.state], [false, "completed"]);
  const f = cand("Test-Call the vendor", "test-call the vendor", "email", "mbx:BBB2");
  await S.upsert(f);
  t("AC-5.12 Dismiss -> dismissed", (await S.decide([O], f.id, "dismissed")).row?.state, "dismissed");
  t("AC-5.12 the same to-do from the same source is never proposed again", await S.upsert(f), { kind: "seen", id: f.id });
  t("AC-5.12 ...and the row stays dismissed", (await S.getMany([O], [f.id]))[0].state, "dismissed");
  t("AC-5.11 edit on a decided row -> not applied", (await S.edit([O], f.id, "x")).applied, false);
  const g = cand("Test-Call the vendor", "test-call the vendor", "teams", "c9:m9");
  const rg = await S.upsert(g);
  t("AC-5.21 same text from a NEW source item after a dismissal -> a new proposal (key is source item + text)", [rg.kind, rg.id !== f.id], ["created", true]);
  // Red-team F14/F15 (2026-11-12): the STORE still records the row above; the ENGINE now reads priorRelated
  // first and suppresses it (scripts/redteam-correspondence.test.ts RT-24/24b). These check the SQL it reads.
  t(
    "F14 priorRelated: the rows referencing this source item, any state (dismissed f), sameItem=true",
    (await S.priorRelated([O], { source: "email", sourceItemId: "mbx:BBB2" }, "test-call the vendr")).map((p) => [p.id === f.id, p.state, p.sameItem]),
    [[true, "dismissed", true]],
  );
  t(
    "F15 priorRelated: a DISMISSED row with this exact key from another source, sameItem=false; the active g is not returned",
    (await S.priorRelated([O], { source: "teams", sourceItemId: "c-new:m1" }, "test-call the vendor")).map((p) => [p.id === f.id, p.state, p.sameItem]),
    [[true, "dismissed", false]],
  );
  t("F14/F15 priorRelated is owner-scoped", await S.priorRelated([OTHER], { source: "email", sourceItemId: "mbx:BBB2" }, "test-call the vendor"), []);
  t("F14 priorRelated: an unrelated item + key -> nothing", await S.priorRelated([O], { source: "email", sourceItemId: "mbx:ZZZ9" }, "test-nothing here"), []);

  // ── concurrency on upsert (two overlapping passes) ──────────────────────────────────────────────
  const h = cand("Test-Renew the permit", "test-renew the permit", "email", "mbx:CCC3");
  const both = await Promise.all([S.upsert(h), S.upsert(h)]);
  t("AC-3.9 two passes upserting the same candidate -> one created, one seen", both.map((x) => x.kind).sort(), ["created", "seen"]);
  t("AC-3.9 ...one proposal, one ref", [await nProps(h.normTitle), await refs(h.id)], [1, 1]);
  const i1 = cand("Test-Book the room", "test-book the room", "email", "mbx:DDD4");
  const i2 = cand("Test-Book the room", "test-book the room", "teams", "c4:m4");
  const raced = await Promise.all([S.upsert(i1), S.upsert(i2)]);
  t("OQ-9 the same to-do from two sources at once -> one created + one attached", raced.map((x) => x.kind).sort(), ["attached", "created"]);
  t("OQ-9 ...one active proposal with 2 refs", [await nProps("test-book the room"), (await S.listActive([O])).find((r) => r.normTitle === "test-book the room")?.sources.length], [1, 2]);

  // ── list order / due date shape ─────────────────────────────────────────────────────────────────
  const j = { ...cand("Test-Pay the invoice", "test-pay the invoice", "email", "mbx:EEE5"), dueDate: "2026-11-13", dueText: "by Friday", assignee: "Dana" };
  await S.upsert(j);
  const lj = (await S.listActive([O])).find((r) => r.id === j.id);
  t("AC-5.20 due date and assignee round-trip as plain strings", [lj?.dueDate, lj?.dueText, lj?.assignee], ["2026-11-13", "by Friday", "Dana"]);
  t("AC-5.15 active list = every proposed row, oldest first", (await S.listActive([O])).map((r) => r.title), ["Test-Call the vendor", "Test-Renew the permit", "Test-Book the room", "Test-Pay the invoice"]);

  // ── schema: no content columns (AC-3.8 spirit) and the id namespace is enforced ─────────────────
  const cols = (await pool.query(`SELECT column_name c FROM information_schema.columns WHERE table_schema='chat' AND table_name IN ('task_proposals','task_proposal_refs')`)).rows.map((r) => r.c as string);
  t("AC-3.8 no body / sender / address column", cols.filter((c) => /body|sender|from_|address|^text$|content$/.test(c)), []);
  let refused = false;
  try {
    await pool.query(`INSERT INTO chat.task_proposals (id, owner_email, title, original_title, norm_title, evidence) VALUES ('3f2a9c1e-8d7b-4c2a-9e1f-0a1b2c3d4e5f','x','t','t','t','e')`);
  } catch {
    refused = true;
  }
  t("AC-5.2 the table refuses an id outside the prop- namespace", refused, true);

  // Cleanup (AC-5.23 spirit): nothing remains.
  await pool.query(`DELETE FROM chat.task_proposal_refs WHERE norm_title LIKE 'test-%'`);
  await pool.query(`DELETE FROM chat.task_proposals WHERE title LIKE 'Test-%'`);
  t("AC-5.23 cleanup leaves zero Test- proposals", Number((await pool.query(`SELECT count(*) n FROM chat.task_proposals`)).rows[0].n), 0);
  await pool.end();
} catch (e) {
  fail++;
  console.log("FAIL harness:", e instanceof Error ? e.message : e);
} finally {
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
