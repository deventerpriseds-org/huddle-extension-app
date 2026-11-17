// WHAT:       Runs the Actions view's REAL server SQL (lib/actions/actions.server.ts, the ledger and the proposal store,
//             unmodified) against a throwaway local PostgreSQL, synthetic data only: Wrong? / Undo per item version
//             (loop-2 D4) including a concurrent write, the itemKey-backs-the-proposal check (D6), the from:"actions"
//             flag-bypass check (D5), and the per-attempt daily call count (D2).
// WHY:        docs/qc-evidence/VERIFY-actions-view-2.md D2 / D4 / D5 / D6. The offline suite (actions-view.test.ts)
//             proves the pure rules; this proves the SQL that applies them.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-actions-view.md "Loop-2 fixes".
//
// Run: bun scripts/actions-view-server.test.ts   (needs PostgreSQL 16/17 binaries; SKIPS cleanly without)
import { mock } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceItem } from "../src/features/huddle/lib/correspondence/source-item";
import type { NewProposal } from "../src/features/huddle/lib/proposals/proposals";

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin"].find((d) => existsSync(join(d, "initdb")));
if (!BIN) {
  console.log("SKIP: no PostgreSQL binaries found");
  process.exit(0);
}
const PORT = 55000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), "actions-"));
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

// Synthetic identities only (this repo is public).
const O = "owner@eds.example";
const OTHER = "someone-else@eds.example";
const LIB = join(import.meta.dir, "../src/features/huddle/lib");
// The caller resolves to O (no journey / identity service in a test).
mock.module(join(LIB, "journey/identity.ts"), () => ({ resolveTaskEmail: async (c: { entra_email?: string }) => c?.entra_email }));
mock.module(join(LIB, "identity/identity.server.ts"), () => ({ resolveScopeByEmail: async (e: string) => ({ emails: [e] }) }));
mock.module(join(LIB, "identity/scheduling-config.server.ts"), () => ({ DEFAULT_TZ: "America/New_York" }));
// The model: every call counted, every call FAILS (a 429 / a timeout that still bills).
const modelCalls = { n: 0 };
mock.module(join(LIB, "openai-responses.server.ts"), () => ({
  callOpenAIRouter: async () => {
    modelCalls.n++;
    throw new Error("429");
  },
}));

const item = (id: string, source: SourceItem["source"] = "teams"): SourceItem => ({
  source,
  sourceItemId: id,
  identityBasis: "provider_id",
  threadId: "chat-1",
  at: "2026-11-16T10:00:00.000Z",
  contentHash: "h1",
  drivePath: "/automation/test-log.jsonl",
  driveItemId: "drive-item-1",
  fileEtag: '"{e1},1"',
  internetMessageId: null,
});

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { pgLedger: L } = await import("../src/features/huddle/lib/correspondence/ledger.server");
  const { pgProposalStore: P } = await import("../src/features/huddle/lib/proposals/proposals-store.server");
  const { proposalId } = await import("../src/features/huddle/lib/proposals/proposals");
  const A = await import("../src/features/huddle/lib/actions/actions.server");
  const { correctionFor, correctionHides } = await import("../src/features/huddle/lib/actions/actions");
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const pool = getSharedPool();

  const cand = (title: string, norm: string, source: "email" | "teams" | "transcript", sid: string, owner = O): NewProposal => ({
    id: proposalId(owner, { source, sourceItemId: sid }, norm),
    owner,
    title,
    normTitle: norm,
    evidence: `please ${norm} soon`,
    assignee: null,
    dueText: null,
    dueDate: null,
    ref: { source, sourceItemId: sid, at: "2026-11-16T10:00:00.000Z", context: "Test-context" },
  });
  const verdict = (sid: string, key: string, propId: string | null, source = "teams") =>
    pool.query(`UPDATE chat.correspondence_ledger SET result_ids = result_ids || jsonb_build_object('action', $3::jsonb) WHERE source = $1 AND source_item_id = $2`, [
      source,
      sid,
      // A day well before the D2 day below, so these verdicts never count toward that day's cap.
      JSON.stringify({ v: 1, key, status: "open", proposalId: propId, at: "2026-11-09T10:00:00.000Z" }),
    ]);
  const column = async (id: string) => (await pool.query(`SELECT owner_correction c FROM chat.task_proposals WHERE id = $1`, [id])).rows[0]?.c ?? null;
  const ledgerCorr = async (sid: string) => (await pool.query(`SELECT owner_correction c FROM chat.correspondence_ledger WHERE source_item_id = $1`, [sid])).rows[0]?.c ?? null;
  const hides = (stored: unknown, k: string) => correctionHides(correctionFor(stored, k), k);

  // Two Teams chats ask for the same to-do -> the store attaches the second source to ONE proposal.
  await L.observe(O, [item("chatA:m1"), item("chatB:m1"), item("chatC:m1")]);
  const pa = cand("Test-Complete the training", "test-complete the training", "teams", "chatA:m1");
  const pb = cand("Test-Complete the training", "test-complete the training", "teams", "chatB:m1");
  const ra = await P.upsert(pa);
  const rb = await P.upsert(pb);
  const shared = pa.id;
  const KA = "teams:chatA|chatA:m1";
  const KB = "teams:chatB|chatB:m1";
  await verdict("chatA:m1", KA, shared);
  await verdict("chatB:m1", KB, shared);
  t("S-0 setup: two chats, ONE proposal (attached)", [ra.kind, rb.kind, rb.id === shared], ["created", "attached", true]);

  // ── D4: Wrong? / Undo per item version ──────────────────────────────────────────────────────────
  const owners = [O];
  const lo = [O];
  const w1 = await A.correctItemFor(owners, lo, { proposalId: shared, reason: "not_mine", itemKey: KA }, "2026-11-16T10:00:00.000Z");
  const w2 = await A.correctItemFor(owners, lo, { proposalId: shared, reason: "not_mine", itemKey: KB }, "2026-11-16T10:05:00.000Z");
  const c2 = await column(shared);
  t("D4-S1 GUARD (real SQL): Wrong? on chat A then chat B -> both stay hidden", [w1.ok, w2.ok, hides(c2, KA), hides(c2, KB)], [true, true, true, true]);
  const u = await A.correctItemFor(owners, lo, { proposalId: shared, itemKey: KB, undo: true }, "2026-11-16T10:06:00.000Z");
  const c3 = await column(shared);
  t("D4-S2 GUARD (real SQL): Undo on B shows B and leaves A's stored correction byte-identical", [u.ok, hides(c3, KA), hides(c3, KB), JSON.stringify(correctionFor(c3, KA)) === JSON.stringify(correctionFor(c2, KA))], [true, true, false, true]);
  t("D4-S3 the ledger mirror is written per version (A's row holds A's correction, B's row B's withdrawn one)", [(await ledgerCorr("chatA:m1"))?.itemKey, (await ledgerCorr("chatB:m1"))?.itemKey, !!(await ledgerCorr("chatB:m1"))?.withdrawnAt], [KA, KB, true]);
  t("D4-S4 another owner cannot correct this proposal", await A.correctItemFor([OTHER], [OTHER], { proposalId: shared, reason: "not_mine", itemKey: KA }, "2026-11-16T10:07:00.000Z"), { ok: false, error: "That item isn't in your list." });

  // Concurrency, deterministic: X holds the row lock and commits a correction for C while A's Wrong? waits. With the
  // FOR UPDATE, the waiting write re-reads X's committed value and keeps C; without it, it would overwrite C.
  await verdict("chatC:m1", "teams:chatC|chatC:m1", shared);
  const x = await pool.connect();
  await x.query("BEGIN");
  const held = (await x.query(`SELECT owner_correction FROM chat.task_proposals WHERE id = $1 FOR UPDATE`, [shared])).rows[0].owner_correction;
  const pending = A.correctItemFor(owners, lo, { proposalId: shared, reason: "wrong_section", itemKey: KB }, "2026-11-16T10:09:00.000Z");
  await new Promise((r) => setTimeout(r, 300));
  const { withItemCorrection } = await import("../src/features/huddle/lib/actions/actions");
  const withC = withItemCorrection(held, { reason: "not_mine", itemKey: "teams:chatC|chatC:m1" }, "2026-11-16T10:08:00.000Z");
  await x.query(`UPDATE chat.task_proposals SET owner_correction = $2::jsonb WHERE id = $1`, [shared, JSON.stringify(withC.ok ? withC.stored : null)]);
  await x.query("COMMIT");
  x.release();
  await pending;
  const c4 = await column(shared);
  t("D4-S5 GUARD: two concurrent corrections on two chats both survive (row lock, no lost update)", [hides(c4, "teams:chatC|chatC:m1"), hides(c4, KB), hides(c4, KA)], [true, true, true]);

  // ── D6: the itemKey must back THIS proposal on the server's records; the ledger row comes from that record ──
  await L.observe(O, [item("chatD:m1")]);
  const pd = cand("Test-Book the room", "test-book the room", "teams", "chatD:m1");
  await P.upsert(pd);
  const KD = "teams:chatD|chatD:m1";
  await verdict("chatD:m1", KD, pd.id);
  const before = JSON.stringify([await column(shared), await column(pd.id), await ledgerCorr("chatD:m1")]);
  const notListed = { ok: false, error: "That item isn't in your list." };
  t("D6-S1 GUARD: an itemKey that backs ANOTHER proposal is refused", await A.correctItemFor(owners, lo, { proposalId: shared, reason: "not_mine", itemKey: KD }, "2026-11-16T11:00:00.000Z"), notListed);
  t("D6-S2 GUARD: a made-up itemKey ending in a real ledger id (the verifier's stamp-any-row path) is refused", await A.correctItemFor(owners, lo, { proposalId: shared, reason: "not_mine", itemKey: "teams:anything|chatD:m1" }, "2026-11-16T11:00:00.000Z"), notListed);
  t("D6-S3 Undo with an itemKey that does not back the proposal is refused too", await A.correctItemFor(owners, lo, { proposalId: shared, itemKey: KD, undo: true }, "2026-11-16T11:00:00.000Z"), notListed);
  t("D6-S4 GUARD: nothing was written by the refused calls (both proposals and the ledger row unchanged)", JSON.stringify([await column(shared), await column(pd.id), await ledgerCorr("chatD:m1")]) === before, true);
  t("D6-S5 the item's OWN key still works, and its ledger mirror lands on the verdict's row", [(await A.correctItemFor(owners, lo, { proposalId: pd.id, reason: "not_mine", itemKey: KD }, "2026-11-16T11:01:00.000Z")).ok, (await ledgerCorr("chatD:m1"))?.itemKey], [true, KD]);
  const { triageRowsFor } = await import("../src/features/huddle/lib/proposals/meeting-triage");
  const tri = triageRowsFor(O, { meetingId: "mtg-1", title: "Test-Sync", meetingAt: "2026-11-16T09:00:00.000Z" }, ["Test-Share the wireframes", "Test-Book the hall"]);
  await P.addTriageRows(tri);
  const MK = `meeting:mtg-1|${tri[0].normTitle}`;
  t("D6-S6 meeting item: its own key is accepted; another item's key of the same meeting is refused", [(await A.correctItemFor(owners, lo, { proposalId: tri[0].id, reason: "not_mine", itemKey: MK }, "2026-11-16T11:02:00.000Z")).ok, await A.correctItemFor(owners, lo, { proposalId: tri[0].id, reason: "not_mine", itemKey: `meeting:mtg-1|${tri[1].normTitle}` }, "2026-11-16T11:02:00.000Z")], [true, notListed]);
  t("D6-S7 itemBacking is owner-scoped (another owner's scope sees no backing)", [await A.itemBacking([OTHER], [OTHER], pd.id, KD), await A.itemBacking([OTHER], [OTHER], tri[0].id, MK)], [null, null]);

  // ── D5: the client's from:"actions" is honoured only when the server confirms the proposal backs an Actions row ──
  {
    const { teamsSourceItemId } = await import("../src/features/huddle/lib/correspondence/source-item");
    const { actOnProposal } = await import("../src/features/huddle/lib/proposals/proposals.server");
    const { listEmailRepliesFor } = await import("../src/features/huddle/lib/email/email-replies.server");
    await listEmailRepliesFor([O], ["bootstrap"], []); // creates chat.email_replies
    const feeds = (cc: Record<string, unknown>) =>
      JSON.stringify({ enabled: true, synthetic: true, ownerLogins: [O], driveUser: O, mailbox: "owner@work.example", sourceLogin: "login@work.example", subjectPrefix: "HUDDLE-PA-SBX-", teams: { ownerSenderIds: ["owner-guid-0001"] }, correspondence: cc });
    const caller = { entra_email: O };
    const chat = (n: string) => `19:d5${n}_x${"@"}unq.gbl.spaces`;
    const mk = async (n: string, backed: boolean) => {
      const sid = teamsSourceItemId(chat(n), "1");
      await L.observe(O, [item(sid)]);
      const p = cand(`Test-Item ${n}`, `test-item ${n}`, "teams", sid);
      await P.upsert(p);
      if (backed) await verdict(sid, `teams:${chat(n)}|${sid}`, p.id);
      await pool.query(`INSERT INTO chat.email_replies (id, owner_email, mailbox, graph_message_id, conversation_id, status, kind) VALUES ($1, $2, '', $3, $4, 'owed', 'chat')`, [`bell-${n}`, O, `src-${n}`, chat(n)]);
      return p.id;
    };
    const state = async (id: string) => (await pool.query(`SELECT state FROM chat.task_proposals WHERE id = $1`, [id])).rows[0]?.state;
    const bell = async (n: string) => (await pool.query(`SELECT status FROM chat.email_replies WHERE id = $1`, [`bell-${n}`])).rows[0]?.status;
    const unbacked = await mk("u", false);
    const backed = await mk("b", true);
    const unbacked2 = await mk("u2", false);
    t("D5-S0 proposalBacksActionsRow: verdict-backed yes, unbacked no, meeting triage row yes, other owner no", [await A.proposalBacksActionsRow([O], [O], backed), await A.proposalBacksActionsRow([O], [O], unbacked), await A.proposalBacksActionsRow([O], [O], tri[1].id), await A.proposalBacksActionsRow([OTHER], [OTHER], backed)], [true, false, true, false]);
    // Proposals switched OFF, the ingest ON (the Actions view's own switch).
    process.env.HUDDLE_ONEDRIVE_FEEDS = feeds({ ingest: true });
    const r1 = await actOnProposal(caller, unbacked, "dismiss", undefined, undefined, { from: "actions" });
    t("D5-S1 GUARD: flag OFF + from:actions on a proposal that backs NO Actions row -> refused, nothing changes", [r1.ok, r1.ok ? null : r1.error, await state(unbacked), await bell("u")], [false, "Task proposals are not switched on.", "proposed", "owed"]);
    const r2 = await actOnProposal(caller, backed, "dismiss", undefined, undefined, { from: "actions" });
    t("D5-S2 flag OFF + from:actions on a proposal that backs an Actions row -> applied, its bell row settled", [r2.ok, await state(backed), await bell("b")], [true, "dismissed", "dismissed"]);
    const r3 = await actOnProposal(caller, tri[1].id, "triage", undefined, { choice: "skip" }, { from: "actions" });
    t("D5-S3 a meeting triage row from Actions triages with meetingTriage OFF", [r3.ok, await state(tri[1].id)], [true, "dismissed"]);
    // Proposals ON, meeting triage OFF.
    process.env.HUDDLE_ONEDRIVE_FEEDS = feeds({ ingest: true, proposals: true });
    const r4 = await actOnProposal(caller, unbacked2, "triage", undefined, { choice: "skip" }, { from: "actions" });
    t("D5-S4 GUARD: from:actions does NOT unlock triage for a proposal that backs no Actions row", r4.ok ? "ok" : r4.error, "Meeting triage is not switched on.");
    const r5 = await actOnProposal(caller, unbacked2, "dismiss", undefined, undefined, { from: "actions" });
    t("D5-S5 GUARD: flag ON, unbacked + from:actions -> the normal dismiss applies but the bell row is NOT settled", [r5.ok, await state(unbacked2), await bell("u2")], [true, "dismissed", "owed"]);
  }

  // ── D2: every model call ATTEMPT is recorded before the call and counted by the daily cap ─────────
  // Day used here: 2026-11-10 (New York midnight = 05:00Z).
  const D10 = "2026-11-10T05:00:00.000Z";
  await L.observe(O, [item("d2:m1"), item("d2:m2")]);
  const at1 = { source: "teams" as const, sourceItemId: "d2:m1" };
  for (const ts of ["2026-11-10T15:00:00.000Z", "2026-11-10T15:10:00.000Z", "2026-11-10T15:20:00.000Z"]) await A.recordActionCall([O], at1, ts);
  t("D2-S1 GUARD: three recorded attempts (no verdict stored at all) count 3 for the day", await A.actionCallsToday([O], D10), 3);
  const cl = (await L.claimDue(O, ["teams"], 50, 5)).find((c) => c.sourceItemId === "d2:m1");
  t("D2-S2 GUARD: markProcessed keeps the attempt list (the cap is not handed back)", [cl ? await L.markProcessed(cl, { bell: ["b"] }) : "no-claim", await A.actionCallsToday([O], D10)], [true, 3]);
  let threw = false;
  try {
    await A.recordActionCall([O], { source: "teams", sourceItemId: "no-such-row" }, "2026-11-10T15:30:00.000Z");
  } catch {
    threw = true;
  }
  t("D2-S3 recording on a row that is not there throws (so no model call is made)", threw, true);
  t("D2-S4 another owner's attempts are not counted; attempts before midnight are not counted", [await A.actionCallsToday([OTHER], D10), await A.actionCallsToday([O], "2026-11-11T05:00:00.000Z")], [0, 0]);
  await A.recordActionCall([O], at1, "2026-11-13T15:00:00.000Z");
  const kept = (await pool.query(`SELECT result_ids->'action_calls' c FROM chat.correspondence_ledger WHERE source_item_id = 'd2:m1'`)).rows[0].c;
  t("D2-S5 entries older than 48h are pruned when a new one is added", kept, ["2026-11-13T15:00:00.000Z"]);
  await pool.query(`UPDATE chat.correspondence_ledger SET result_ids = result_ids || jsonb_build_object('action', '{"v":1,"key":"k","status":"none","at":"2026-11-14T15:00:00.000Z"}'::jsonb) WHERE source_item_id = 'd2:m2'`);
  t("D2-S6 a verdict stored with no recorded attempt (deploy day) still counts: max(attempts, verdicts)", await A.actionCallsToday([O], "2026-11-14T05:00:00.000Z"), 1);

  // ── D2 end to end: the REAL heartbeat pass (runActionsClassify), real SQL, model mocked to FAIL ────
  // Cap 5, 10 passes 10 minutes apart on one day, 8 Teams 1:1 chats waiting -> at most 5 model calls.
  const { setSystemTime } = await import("bun:test");
  const { teamsSourceItemId } = await import("../src/features/huddle/lib/correspondence/source-item");
  process.env.HUDDLE_ONEDRIVE_FEEDS = JSON.stringify({ enabled: true, synthetic: true, ownerLogins: [O], driveUser: O, mailbox: "owner@work.example", sourceLogin: "login@work.example", subjectPrefix: "HUDDLE-PA-SBX-", teams: { ownerSenderIds: ["owner-guid-0001"] }, correspondence: { ingest: true, ownerNames: ["Owen Example"] } });
  const { setActionsSettingsRaw } = await import("../src/features/huddle/lib/email/email-replies.server");
  const { resolveActionsSettings } = await import("../src/features/huddle/lib/actions/actions");
  await setActionsSettingsRaw(O, resolveActionsSettings({ dailyCap: 5 }));
  const chats = Array.from({ length: 8 }, (_, i) => `19:e2e${i}_x${"@"}unq.gbl.spaces`);
  await L.storeContent(
    O,
    chats.map((c) => ({
      ...item(teamsSourceItemId(c, "1")),
      threadId: c,
      at: "2026-11-16T14:00:00.000Z",
      content: { kind: "teams", chatId: c, chatName: null, messageId: "1", at: "2026-11-16T14:00:00.000Z", sender: { id: "other-guid", name: "Pat Example", isApp: false }, fromOwner: false, text: "Could you please send the synthetic deck today?", webUrl: null, mentionedUserIds: [], ownerUserId: "owner-guid-0001" },
    })) as never,
  );
  for (let i = 0; i < 10; i++) {
    setSystemTime(new Date(Date.parse("2026-11-16T15:00:00.000Z") + i * 10 * 60_000 + 1000));
    await A.runActionsClassify();
  }
  t("D2-E1 GUARD (real heartbeat + SQL): cap 5, model failing, 10 passes -> at most 5 model calls", [modelCalls.n <= 5, modelCalls.n, await A.actionCallsToday([O], "2026-11-16T05:00:00.000Z")], [true, 5, 5]);

  // ── Owner 2026-11-17: the page's cap notice reads THE SAME count the heartbeat capped on (usedTodayFor), real SQL.
  const capPage = await A.getActionsPage({ entra_email: O });
  const cp = capPage.status === "ok" ? capPage : null;
  t(
    "CAP-S1 GUARD (real page read + SQL): after the heartbeat spent the cap, the page shows used 5 of 5 and the notice",
    [capPage.status, cp?.capUsedToday, cp?.capNotice, await A.usedTodayFor([O], Date.now(), "America/New_York")],
    ["ok", 5, "Daily AI check limit reached (5 of 5 used today). Remaining items wait until tomorrow. To change the limit, open What shows → Sorting → Daily limit on this page.", 5],
  );
  await setActionsSettingsRaw(O, resolveActionsSettings({ dailyCap: 6 }));
  const capPage2 = await A.getActionsPage({ entra_email: O });
  t("CAP-S2 GUARD: the owner raises the limit to 6 -> no notice, used still 5", capPage2.status === "ok" ? [capPage2.capUsedToday, capPage2.capNotice] : capPage2.status, [5, null]);
  setSystemTime();

  // ── AC8 (verifier VERIFY-report-saves-verdicts-1): two passes (heartbeat + report) judge the SAME unjudged thread
  // at the same moment and the model words the to-do differently. Real deps (classifyDepsFor: real attempt record,
  // real proposeFromSource + proposal store, real verdict store, real thread lock), real SQL; only the model is faked,
  // and both answers are released together so both passes reach the propose step at once.
  {
    const { assembleLedgerPlan } = await import("../src/features/huddle/lib/correspondence/report-from-ledger");
    const { loadLedgerReportData } = await import("../src/features/huddle/lib/correspondence/report-from-ledger.server");
    const { parseFeedsConfig } = await import("../src/features/huddle/lib/external-feeds/onedrive-feed");
    const { runClassify, threadUnits } = await import("../src/features/huddle/lib/actions/pipeline");
    const { ACTIONS_SETTINGS_DEFAULT } = await import("../src/features/huddle/lib/actions/actions");
    const ACHAT = `19:ac8_x${"@"}unq.gbl.spaces`;
    const ASK = "Could you please send the synthetic budget sheet by Friday?";
    await L.storeContent(O, [
      {
        ...item(teamsSourceItemId(ACHAT, "1")),
        threadId: ACHAT,
        at: "2026-11-16T16:00:00.000Z",
        content: { kind: "teams", chatId: ACHAT, chatName: null, messageId: "1", at: "2026-11-16T16:00:00.000Z", sender: { id: "other-guid", name: "Pat Example", isApp: false }, fromOwner: false, text: ASK, webUrl: null, mentionedUserIds: [], ownerUserId: "owner-guid-0001" },
      },
    ] as never);
    const asm = assembleLedgerPlan(await loadLedgerReportData([O]), parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS)!, Date.parse("2026-11-09T05:00:00.000Z"));
    const S8 = { ...ACTIONS_SETTINGS_DEFAULT, sources: { email: false, teams: true, meeting: false } };
    const units = threadUnits(asm, S8).units;
    const target = units.find((x) => x.teams?.chatId === ACHAT)!;
    // Every OTHER thread counts as judged, so each pass makes exactly one call: this thread.
    const judged = new Set(units.filter((x) => x !== target).map((x) => x.itemKey));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let arrived = 0;
    const answer = (todo: string) => async () => {
      if (++arrived === 2) release();
      await gate;
      return { open_item: true, kind: "action", todo, due: "Friday", quote: ASK, confidence: "high", reason: "Asked directly.", category: "person_request" };
    };
    const base = await A.classifyDepsFor(O, [O]);
    const [r1, r2] = await Promise.all([
      runClassify(asm, S8, judged, 5, { ...base, model: answer("Test-Send the synthetic budget sheet") }),
      runClassify(asm, S8, judged, 5, { ...base, model: answer("Test-Email Pat the spreadsheet with the numbers") }),
    ]);
    const props = await pool.query<{ proposal_id: string }>(
      `SELECT DISTINCT proposal_id FROM chat.task_proposal_refs WHERE owner_email = $1 AND source = 'teams' AND source_item_id = $2`,
      [O, target.refItemId],
    );
    const stored = await pool.query<{ p: string | null }>(`SELECT result_ids->'action'->>'proposalId' AS p FROM chat.correspondence_ledger WHERE source = 'teams' AND source_item_id = $1`, [target.storeAt.sourceItemId]);
    t(
      "AC8-S1 GUARD (real SQL): two passes at once, same thread, differently worded to-dos -> ONE proposal; the second pass adopts the first's verdict",
      [r1.calls + r2.calls, props.rows.length, r1.open + r2.open, r1.alreadyJudged + r2.alreadyJudged - 2 * judged.size, stored.rows[0]?.p === props.rows[0]?.proposal_id, r1.failures + r2.failures],
      [2, 1, 1, 1, true, 0],
    );
  }
  // ── VERIFIER LOOP 2 (adversarial, synthetic): AC8 under load ──────────────────────────────────────────
  {
    const { assembleLedgerPlan } = await import("../src/features/huddle/lib/correspondence/report-from-ledger");
    const { loadLedgerReportData } = await import("../src/features/huddle/lib/correspondence/report-from-ledger.server");
    const { parseFeedsConfig } = await import("../src/features/huddle/lib/external-feeds/onedrive-feed");
    const { runClassify, threadUnits } = await import("../src/features/huddle/lib/actions/pipeline");
    const { ACTIONS_SETTINGS_DEFAULT } = await import("../src/features/huddle/lib/actions/actions");
    const N = 12;
    const chats = Array.from({ length: N }, (_, i) => `19:v2stress${i}${"@"}unq.gbl.spaces`);
    const askOf = (i: number) => `Could you please send the synthetic report number ${i} by Friday?`;
    await L.storeContent(O, chats.map((ch, i) => ({
      ...item(teamsSourceItemId(ch, "1")), threadId: ch, at: "2026-11-16T17:00:00.000Z",
      content: { kind: "teams", chatId: ch, chatName: null, messageId: "1", at: "2026-11-16T17:00:00.000Z", sender: { id: "other-guid", name: "Pat Example", isApp: false }, fromOwner: false, text: askOf(i), webUrl: null, mentionedUserIds: [], ownerUserId: "owner-guid-0001" },
    })) as never);
    const asm = assembleLedgerPlan(await loadLedgerReportData([O]), parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS)!, Date.parse("2026-11-09T05:00:00.000Z"));
    const S8 = { ...ACTIONS_SETTINGS_DEFAULT, dailyCap: 10000, sources: { email: false, teams: true, meeting: false } };
    const units = threadUnits(asm, S8).units;
    const targets = units.filter((x) => chats.includes(x.teams?.chatId ?? ""));
    const judged = new Set(units.filter((x) => !targets.includes(x)).map((x) => x.itemKey));
    console.log(`INFO V2-AC8 targets=${targets.length}`);
    const PASSES = 3;
    let maxTotal = 0, maxWaiting = 0;
    const sampler = setInterval(() => { maxTotal = Math.max(maxTotal, pool.totalCount); maxWaiting = Math.max(maxWaiting, pool.waitingCount); }, 2);
    const answer = (pass: number) => async (_sys: string, inp: string) => {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 30)));
      let i = -1;
      for (let k = 0; k < N; k++) if (String(inp).includes(`report number ${k} by`)) i = k;
      return { open_item: true, kind: "action", todo: `Test-pass${pass} wording ${["alpha", "bravo", "charlie"][pass]} item ${i}`, due: "Friday", quote: askOf(i), confidence: "high", reason: "Asked directly.", category: "person_request" };
    };
    const base = await A.classifyDepsFor(O, [O]);
    let peakHolders = 0, holders = 0;
    const counted = { ...base, lockThread: async (u: any, fn: any) => base.lockThread!(u, async (tx: any) => { holders++; peakHolders = Math.max(peakHolders, holders); try { return await fn(tx); } finally { holders--; } }) };
    const t0 = Date.now();
    const timeout = new Promise((r) => setTimeout(() => r("TIMEOUT"), 30000));
    const out: any = await Promise.race([Promise.all(Array.from({ length: PASSES }, (_, p) => runClassify(asm, S8, judged, N, { ...counted, concurrency: 5, model: answer(p) } as any))), timeout]);
    clearInterval(sampler);
    const ms = Date.now() - t0;
    if (out === "TIMEOUT") {
      t("V2-AC8-1 3 passes x 12 threads x concurrency 5 complete (no pool deadlock)", "TIMEOUT", "done");
    } else {
      const props = await pool.query<{ sid: string; n: string }>(`SELECT source_item_id sid, count(DISTINCT proposal_id) n FROM chat.task_proposal_refs WHERE owner_email = $1 AND source = 'teams' AND source_item_id = ANY($2) GROUP BY 1`, [O, targets.map((x) => x.refItemId)]);
      const verd = await pool.query<{ ok: number }>(`SELECT count(*)::int ok FROM chat.correspondence_ledger l WHERE source='teams' AND source_item_id = ANY($1) AND result_ids->'action'->>'proposalId' IN (SELECT proposal_id FROM chat.task_proposal_refs r WHERE r.source_item_id = l.source_item_id)`, [targets.map((x) => x.storeAt.sourceItemId)]);
      const sum = (k: string) => out.reduce((a: number, r: any) => a + r[k], 0);
      console.log(`INFO V2-AC8 ms=${ms} peak_pool_total=${maxTotal} peak_pool_waiting=${maxWaiting} peak_lock_holders_inside_fn=${peakHolders} THREAD_LOCK_HOLDERS_MAX=${A.THREAD_LOCK_HOLDERS_MAX}`);
      t("V2-AC8-1 3 passes x 12 threads x concurrency 5: done, 36 calls, 12 stored open, 24 adopted, 0 failures", [sum("calls"), sum("open"), sum("alreadyJudged") - PASSES * judged.size, sum("failures")], [36, 12, 24, 0]);
      t("V2-AC8-2 exactly ONE proposal per thread (12 threads, all count 1)", [props.rows.length, props.rows.every((r) => Number(r.n) === 1)], [12, true]);
      t("V2-AC8-3 each stored verdict points at that thread's proposal", verd.rows[0].ok, 12);
      t("V2-AC8-4 pool never above its max (8)", maxTotal <= 8, true);
    }
    const cnt = async () => Number((await pool.query(`SELECT count(*) n FROM chat.task_proposals WHERE owner_email=$1`, [O])).rows[0].n);
    const before = await cnt();
    const r3 = await runClassify(asm, S8, new Set(judged), N, { ...counted, concurrency: 5, model: answer(0) } as any);
    t("V2-AC8-5 a pass that did not see the store (stale judged set) adds 0 proposals: all adopted inside the lock", [r3.calls, r3.open, (await cnt()) - before], [12, 0, 0]);
  }

} catch (e) {
  fail++;
  console.log(`FAIL harness: ${e instanceof Error ? `${e.name}: ${e.message}` : "error"}`);
} finally {
  try {
    const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
    await getSharedPool().end();
  } catch {
    /* already closed */
  }
  stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
