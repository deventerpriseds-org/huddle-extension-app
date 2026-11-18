// WHAT:       Offline tests (synthetic data only, fake model + fake store) for the action-scan REPORT saving its verdicts
//             into the Actions view's store: (a) report-path verdicts go through the SAME admission guard (a quote that
//             is not verbatim is never stored as open), (b) a second run over unchanged threads makes 0 model calls,
//             the cap and the attempt record are the app's, and save OFF writes no verdict, proposal or meeting row (attempts are still
//             recorded toward the daily limit), (c) the HTML is rendered FROM
//             the stored verdicts (an item stored open appears; one stored none does not appear as open; a stale or
//             not-admitted verdict is listed as not checked).
// WHY:        Owner-approved 2026-11-17 (report saves verdicts). Tier 1: this path admits model output into stored
//             claims. Build notes: docs/qc-evidence/BUILD-report-saves-verdicts.md.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-report-saves-verdicts.md.
// Run: bun scripts/report-saves-verdicts.test.ts
import type { ActionVerdict } from "../src/features/huddle/lib/correspondence/action-classify";
import { assembleLedgerPlan, type LedgerReportRow } from "../src/features/huddle/lib/correspondence/report-from-ledger";
import { parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import type { EmailContent, TeamsContent } from "../src/features/huddle/lib/correspondence/source-item";
import { teamsSourceItemId } from "../src/features/huddle/lib/correspondence/source-item";
import { ACTIONS_SETTINGS_DEFAULT, resolveActionsSettings, type ActionsSettings } from "../src/features/huddle/lib/actions/actions";
import { ownerFullNames } from "../src/features/huddle/lib/correspondence/needs-you";
import { inMemoryWrites, runClassify, runReportClassify, threadUnits, type ClassifyDeps } from "../src/features/huddle/lib/actions/pipeline";
import { renderActionReportHtml, rowsFromStoredVerdicts, type ReportRows } from "./action-report-html";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

// ── Synthetic ledger (same shapes as scripts/actions-view.test.ts) ────────────────────────────────────
const MAILBOX = "owner@work.example";
const OWNER_ID = "owner-guid-0001";
const NOW = "2026-11-12T15:00:00Z";
const SINCE = Date.parse("2026-11-09T05:00:00Z");
const AT = "@";
const HAY = "Hi, could you confirm the venue hold by Thursday? Thanks.";
const LIST_TEXT = "Reminder: all staff please submit the synthetic survey by Friday.";
const CHAT_TEXT = "Are you OK with me sending the draft to legal today?";
const cfg = parseFeedsConfig(JSON.stringify({ enabled: true, synthetic: false, driveUser: MAILBOX, mailbox: MAILBOX, ownerLogins: ["owner@huddle.example"], teams: { ownerSenderIds: [OWNER_ID] }, correspondence: { ownerNames: ["Owen Example"] } }))!;
const msg = (o: Partial<TeamsContent> = {}): TeamsContent => ({ kind: "teams", chatId: "c", chatName: "Synthetic chat", messageId: "1", at: "2026-11-10T15:00:00Z", sender: { id: "other-guid", name: "Pat Example", isApp: false }, fromOwner: false, text: CHAT_TEXT, webUrl: null, mentionedUserIds: [], ownerUserId: OWNER_ID, ...o });
const trow = (chatId: string, id: string, at: string, o: Partial<TeamsContent> = {}): LedgerReportRow => ({ source: "teams", sourceItemId: teamsSourceItemId(chatId, id), threadId: chatId, at, content: { ...msg({ chatId, messageId: id, at }), ...o } });
const erow = (id: string, conv: string, at: string, o: Partial<EmailContent> = {}): LedgerReportRow => ({
  source: "email",
  sourceItemId: `${MAILBOX}:${id}`,
  threadId: conv,
  at,
  content: { kind: "email", subject: "Synthetic subject", from: { name: "Pat Example", address: "pat@partner.example" }, to: [MAILBOX], cc: [], receivedAt: at, conversationId: conv, internetMessageId: null, bodyText: HAY, isForward: false, ...o },
});
const ONE = `19:x_y${AT}unq.gbl.spaces`;
const rows: LedgerReportRow[] = [
  erow("m1", "conv-1", "2026-11-10T14:00:00Z"),
  erow("m2", "conv-2", "2026-11-11T14:00:00Z", { to: ["list@work.example"], from: { name: "Ops List", address: "ops-list@work.example" }, bodyText: LIST_TEXT }),
  trow(ONE, "1", "2026-11-10T17:00:00Z"),
];
const asm = assembleLedgerPlan({ rows, proposals: [], bell: [] }, cfg, SINCE);
const S = (o: Partial<ActionsSettings> = {}): ActionsSettings => ({ ...ACTIONS_SETTINGS_DEFAULT, sources: { email: true, teams: true, meeting: false }, ...o });
const UNITS = threadUnits(asm, S()).units;
t("F-0 fixture: 3 units (email on To, email via a list, Teams 1:1)", UNITS.map((u) => u.source), ["email", "email", "teams"]);
const directKey = UNITS[0].itemKey;

// ── The fake model + the fake store ────────────────────────────────────────────────────────────────
const open = (quote: string, todo: string) => ({ open_item: true, kind: "reply", todo, due: null, quote, confidence: "high", reason: "Asked directly.", category: "person_request" });
const none = (reason: string) => ({ open_item: false, kind: "none", todo: "SHOULD-NOT-SHOW-AS-OPEN", due: null, quote: null, confidence: "high", reason, category: "announcement" });
type Answer = (system: string, input: string) => unknown;
/** Email on To -> open (verbatim quote); list email -> none; Teams -> open (verbatim quote). */
const honest: Answer = (system, input) =>
  input.includes("CHAT (oldest first)") ? open("Are you OK with me sending the draft to legal today?", "Answer about sending the draft") : system.includes("NOT on the To line") ? none("Just an FYI to the whole list.") : open("could you confirm the venue hold by Thursday?", "Confirm the venue hold");
/** Like honest, but the email on To comes back with a quote that is NOT in the message (paraphrased). */
const paraphrase: Answer = (system, input) => (input.includes("conv-1") || (!input.includes("CHAT (oldest first)") && !system.includes("NOT on the To line")) ? open("please confirm the venue by Friday", "Confirm the venue hold") : honest(system, input));

function fakeStore(answer: Answer) {
  const store = new Map<string, ActionVerdict>();
  const log = { model: 0, record: 0, propose: 0 };
  const deps: ClassifyDeps = {
    recordCall: async () => void log.record++,
    model: async (system, input) => (log.model++, answer(system, input)),
    propose: async (u) => (log.propose++, { id: `prop-${u.source}-${log.propose}`, onBoard: false }),
    storeVerdict: async (at, v) => void store.set(`${at.source}\u0000${at.sourceItemId}`, v),
    addMeetingRows: async () => 0,
    nowIso: () => NOW,
  };
  return { store, log, deps, loadVerdicts: async () => new Map(store) };
}
const pass1 = (f: ReturnType<typeof fakeStore>, o: { usedToday?: number; maxCalls?: number; settings?: ActionsSettings } = {}) =>
  runReportClassify({ assembled: asm, settings: o.settings ?? S(), sortingOn: true, usedToday: o.usedToday ?? 0, maxCalls: o.maxCalls ?? 250, loadVerdicts: f.loadVerdicts, deps: f.deps });
const storedAt = (store: ReadonlyMap<string, ActionVerdict>, i: number) => store.get(`${UNITS[i].storeAt.source}\u0000${UNITS[i].storeAt.sourceItemId}`);

// ── (a) ONE ADMISSION GUARD on the report path ────────────────────────────────────────────────────────
{
  const f = fakeStore(paraphrase);
  const r = await pass1(f);
  const v = storedAt(f.store, 0);
  t("RA-1 GUARD: a non-verbatim quote from the report's pass is stored NOT open (not_checked, quote_not_found)", [v?.status, v?.notCheckedReason], ["not_checked", "quote_not_found"]);
  t("RA-2 GUARD: no proposal backs the not-admitted item; the two admitted / none items still store", [r.res.open, r.res.none, r.res.notChecked, f.log.propose], [1, 1, 1, 1]);
  const g = fakeStore(honest);
  await pass1(g);
  t("RA-3 the same thread with a verbatim quote IS stored open, backed by a proposal", [storedAt(g.store, 0)?.status, storedAt(g.store, 0)?.proposalId], ["open", "prop-email-1"]);
  t("RA-4 the stored key is the Actions view's own item key (one key scheme)", storedAt(g.store, 0)?.key, directKey);
}

// ── (b) A SECOND RUN OVER UNCHANGED THREADS COSTS 0 MODEL CALLS; same cap, same attempt record ──────────
{
  const f = fakeStore(honest);
  const r1 = await pass1(f);
  t("RB-1 first run: one call per unit, every call recorded first (spend counts toward the daily cap)", [r1.res.calls, f.log.model, f.log.record], [3, 3, 3]);
  const r2 = await pass1(f);
  t("RB-2 GUARD: second run over the same store -> 0 model calls, 0 attempts, all 3 already judged", [r2.res.calls, f.log.model, f.log.record, r2.res.alreadyJudged], [0, 3, 3, 3]);
  // A verdict judged at an older classifier-input version is NOT current: it is judged again (the app's rule).
  const k = `${UNITS[2].storeAt.source}\u0000${UNITS[2].storeAt.sourceItemId}`;
  f.store.set(k, { ...f.store.get(k)!, inputVersion: 1 });
  const r3 = await pass1(f);
  t("RB-3 an out-of-date verdict (Teams at input version 1) is re-judged: exactly 1 call", [r3.res.calls, r3.res.alreadyJudged], [1, 2]);
  // X-2 (AC-actions-safety-and-invites.md): the PREVIOUS versions (email 2, teams 3) are out of date after the bump.
  const ke = `${UNITS[0].storeAt.source}\u0000${UNITS[0].storeAt.sourceItemId}`;
  f.store.set(ke, { ...f.store.get(ke)!, inputVersion: 2 });
  f.store.set(k, { ...f.store.get(k)!, inputVersion: 3 });
  const calls0 = f.log.model;
  const r4 = await pass1(f);
  t("X-2 GUARD: an email verdict at input version 2 and a Teams verdict at 3 are each judged again (2 calls, counted), stored at the new version", [r4.res.calls, f.log.model - calls0, r4.res.alreadyJudged, f.store.get(ke)?.inputVersion, f.store.get(k)?.inputVersion], [2, 2, 1, 3, 4]);
  const c = fakeStore(honest);
  const rc = await pass1(c, { usedToday: ACTIONS_SETTINGS_DEFAULT.dailyCap - 1 });
  t("RB-4 GUARD: the report is bounded by what the owner's daily cap has left (1 left -> 1 call, 2 over cap)", [rc.callsLeft, rc.res.calls, rc.res.overCap], [1, 1, 2]);
  const m = fakeStore(honest);
  const rm = await pass1(m, { maxCalls: 2 });
  t("RB-5 and by max_sources (2 -> 2 calls)", [rm.callsLeft, rm.res.calls, rm.res.overCap], [2, 2, 1]);
  // save OFF: the same pass, nothing written to the store; attempts still recorded; already-judged still costs 0.
  const off = fakeStore(honest);
  const io = inMemoryWrites(off.deps, off.loadVerdicts);
  const ro = await runReportClassify({ assembled: asm, settings: S(), sortingOn: true, usedToday: 0, maxCalls: 250, loadVerdicts: io.loadVerdicts, deps: io.deps });
  t("RB-6 save OFF: nothing stored, no proposal written, but every attempt recorded and the report still has 3 verdicts", [off.store.size, off.log.propose, off.log.record, ro.verdicts.size], [0, 0, 3, 3]);
  const off2 = fakeStore(honest);
  await pass1(off2);
  const io2 = inMemoryWrites(off2.deps, off2.loadVerdicts);
  const before = off2.log.model;
  const ro2 = await runReportClassify({ assembled: asm, settings: S(), sortingOn: true, usedToday: 0, maxCalls: 250, loadVerdicts: io2.loadVerdicts, deps: io2.deps });
  t("RB-7 save OFF still reads the store: threads already judged cost 0 calls", [ro2.res.calls, off2.log.model - before], [0, 0]);
}

// ── (c) THE HTML IS RENDERED FROM THE STORED VERDICTS ────────────────────────────────────────────────
const render = (r: ReportRows) =>
  renderActionReportHtml({ ...r, conversations: 2, calls: 0, failures: 0, overCap: 0, maxCalls: 250, settledIndirect: 0, sinceMs: SINCE, forwardsRead: 0, model: "test-model", hide: new Set(), notCheckedTitle: "Not checked yet", notCheckedNote: "note" }).html;
const between = (html: string, from: string, to: string) => {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a + from.length);
  return a < 0 || b < 0 ? "" : html.slice(a, b);
};
const step2Open = (html: string) => between(html, "you are on the To line: open items", "Step 2 &mdash; answered by your reply");
const step3NoAction = (html: string) => between(html, "Step 3 &mdash; AI says no action for you", "</table>");
{
  const f = fakeStore(honest);
  await pass1(f);
  const rows1 = rowsFromStoredVerdicts(asm, S(), f.store);
  const html = render(rows1);
  t("RC-1 an item stored OPEN appears in the open section, with its stored to-do", [step2Open(html).includes("open items (1)"), step2Open(html).includes("Confirm the venue hold")], [true, true]);
  t("RC-2 GUARD: an item stored NONE is not shown as open (its to-do never appears; its reason is under 'no action')", [html.includes("SHOULD-NOT-SHOW-AS-OPEN"), step3NoAction(html).includes("Just an FYI to the whole list."), html.includes("actions for you (0)")], [false, true, true]);
  t("RC-3 rows come from the store: open 2 (email + Teams), none 1, not checked 0", [rows1.step2.filter((x) => x.yes).length + rows1.teamsRows.filter((x) => x.yes).length, rows1.step3.filter((x) => !x.yes).length, rows1.notCheckedEmail.length + rows1.notCheckedTeams.length], [2, 1, 0]);
  // The same store with the open verdict changed to none: the HTML follows the STORE, not any model answer.
  const k0 = `${UNITS[0].storeAt.source}\u0000${UNITS[0].storeAt.sourceItemId}`;
  const flipped = new Map(f.store);
  flipped.set(k0, { ...flipped.get(k0)!, status: "none", todo: "FLIPPED-NOT-OPEN" });
  const html2 = render(rowsFromStoredVerdicts(asm, S(), flipped));
  t("RC-4 GUARD: change the stored verdict to none -> it leaves the open section", [step2Open(html2).includes("open items (0)"), html2.includes("FLIPPED-NOT-OPEN")], [true, false]);
  // A stale verdict (different key = an older version of the thread) is not used: listed as not checked.
  const stale = new Map(f.store);
  stale.set(k0, { ...stale.get(k0)!, key: `${directKey}-older` });
  const rs = rowsFromStoredVerdicts(asm, S(), stale);
  const html3 = render(rs);
  t("RC-5 GUARD: a stored verdict for an older version of the thread is not shown as open; it is listed as not checked", [step2Open(html3).includes("open items (0)"), rs.notCheckedEmail.length, html3.includes("Not checked yet (1)")], [true, 1, true]);
  // A not-admitted answer (quote not found) is never shown as open, and counted.
  const g = fakeStore(paraphrase);
  await pass1(g);
  const rn = rowsFromStoredVerdicts(asm, S(), g.store);
  const html4 = render(rn);
  t("RC-6 GUARD: a stored not_checked (quote not found) is not in the open section; it is listed as not checked and counted", [step2Open(html4).includes("open items (0)"), rn.notCheckedEmail.length, rn.notAdmitted], [true, 1, 1]);
  t("RC-7 an empty store -> every unit listed as not checked, nothing open", [rowsFromStoredVerdicts(asm, S(), new Map()).notCheckedEmail.length, rowsFromStoredVerdicts(asm, S(), new Map()).notCheckedTeams.length], [2, 1]);
}

// ── Verifier loop 1, finding 1: the owner's "AI sorting off" switch stops the report's pass ───────────────────
{
  const f = fakeStore(honest);
  await pass1(f); // three verdicts already stored
  const k0 = `${UNITS[0].storeAt.source}\u0000${UNITS[0].storeAt.sourceItemId}`;
  f.store.delete(k0); // one thread NOT judged yet: with sorting on it would cost a call
  const before = { ...f.log };
  const r = await runReportClassify({ assembled: asm, settings: S({ classify: false }), sortingOn: false, usedToday: 0, maxCalls: 250, loadVerdicts: f.loadVerdicts, deps: f.deps });
  t("RS-1 GUARD: sorting OFF -> 0 model calls, 0 attempts, 0 proposals, nothing stored, even with an unjudged thread", [f.log.model - before.model, f.log.record - before.record, f.log.propose - before.propose, f.store.size, r.res.calls, r.callsLeft, r.sortingOff], [0, 0, 0, 2, 0, 0, true]);
  const rows = rowsFromStoredVerdicts(asm, S(), r.verdicts);
  t("RS-2 sorting OFF -> the report renders only the stored verdicts (2 rows, the unjudged thread listed not checked)", [rows.step3.length + rows.teamsRows.length, rows.notCheckedEmail.length], [2, 1]);
  const on = await runReportClassify({ assembled: asm, settings: S(), sortingOn: true, usedToday: 0, maxCalls: 250, loadVerdicts: f.loadVerdicts, deps: f.deps });
  t("RS-3 control: sorting ON over the same store -> exactly the 1 unjudged thread costs a call", [on.res.calls, on.sortingOff], [1, false]);
}

// ── Verifier loop 1, finding 3: max_sources that is not a finite positive number -> 0 calls, never a hang ─────
const within = <T,>(p: Promise<T>, ms = 2000) => Promise.race([p, new Promise<"HUNG">((res) => setTimeout(() => res("HUNG"), ms))]);
for (const bad of [Number.NaN, -3, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  const f = fakeStore(honest);
  const r = await within(runReportClassify({ assembled: asm, settings: S(), sortingOn: true, usedToday: 0, maxCalls: bad, loadVerdicts: f.loadVerdicts, deps: f.deps }));
  t(`RM-1 GUARD: maxCalls ${bad} -> callsLeft 0, 0 model calls, all 3 over cap, returns`, r === "HUNG" ? "HUNG" : [r.callsLeft, f.log.model, r.res.overCap], [0, 0, 3]);
}
{
  const f = fakeStore(honest);
  const r = await within(runClassify(asm, S(), new Set(), Number.NaN, { ...f.deps, concurrency: 5 }));
  t("RM-2 GUARD: runClassify given a NaN allowance returns (0 calls, all over cap) instead of looping forever", r === "HUNG" ? "HUNG" : [r.calls, r.overCap, f.log.model], [0, 3, 0]);
}

// ── AC8 (verifier loop 1), offline half: the thread lock's "already judged while I waited" check, and save OFF ──
{
  const f = fakeStore(honest);
  let chain = Promise.resolve();
  let lockCalls = 0;
  const locked: ClassifyDeps = {
    ...f.deps,
    lockThread: async (u, fn) => {
      lockCalls++;
      const prev = chain;
      let done: () => void = () => {};
      chain = new Promise<void>((r) => (done = r));
      await prev;
      try {
        return await fn({ current: async () => f.store.get(`${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`) ?? null, store: async (v) => void f.store.set(`${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`, v) });
      } finally {
        done();
      }
    },
  };
  const S1 = S({ sources: { email: true, teams: false, meeting: false } });
  const judged = new Set([UNITS[1].itemKey]); // only the email on To is pending
  const [a1, a2] = await Promise.all([runClassify(asm, S1, judged, 5, locked), runClassify(asm, S1, judged, 5, locked)]);
  t("RL-1 GUARD: two passes on one thread through the lock -> 1 proposal; the second adopts the stored verdict", [f.log.model, f.log.propose, a1.open + a2.open, a1.alreadyJudged + a2.alreadyJudged, lockCalls], [2, 1, 1, 3, 2]);
  const off = fakeStore(honest);
  let offLock = 0;
  const io = inMemoryWrites({ ...off.deps, lockThread: async (_u, fn) => (offLock++, fn({ current: async () => null, store: async () => {} })) }, off.loadVerdicts);
  await runReportClassify({ assembled: asm, settings: S(), sortingOn: true, usedToday: 0, maxCalls: 250, loadVerdicts: io.loadVerdicts, deps: io.deps });
  t("RL-2 GUARD: save OFF never enters the thread lock (its tx.store writes the real store)", [offLock, off.store.size], [0, 0]);
}

// ── Verifier VERIFY-actions-app-invite-2 B3/B4: a re-judge after a classifier-version bump keeps the item's proposal ──
{
  const withLock = (f: ReturnType<typeof fakeStore>): ClassifyDeps => ({
    ...f.deps,
    lockThread: async (u, fn) => fn({ current: async () => f.store.get(`${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`) ?? null, store: async (v) => void f.store.set(`${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`, v) }),
  });
  const S1 = S({ sources: { email: true, teams: false, meeting: false } });
  const judged = new Set([UNITS[1].itemKey]); // only the email on To is re-judged
  const k0 = `${UNITS[0].storeAt.source}\u0000${UNITS[0].storeAt.sourceItemId}`;
  const stale = (key: string): ActionVerdict => ({ ...(open("x", "Older wording of the ask") as never), status: "open", key, at: NOW, inputVersion: 1, proposalId: "prop-decided-earlier" } as ActionVerdict);
  const same = fakeStore(honest);
  same.store.set(k0, stale(directKey));
  await runClassify(asm, S1, judged, 5, withLock(same));
  const v0 = same.store.get(k0);
  t("RK-1 GUARD: re-judge of the SAME item version (old classifier) keeps its proposal -> no new proposal, decision stays attached", [same.log.model, same.log.propose, v0?.proposalId, v0?.status, v0?.inputVersion !== 1], [1, 0, "prop-decided-earlier", "open", true]);
  const moved = fakeStore(honest);
  moved.store.set(k0, stale(`${directKey}|an-older-message-version`));
  await runClassify(asm, S1, judged, 5, withLock(moved));
  t("RK-2 a NEW message (different item key) is proposed afresh, not glued to the old proposal", [moved.log.propose, moved.store.get(k0)?.proposalId === "prop-decided-earlier"], [1, false]);
  // X-5 (AC-actions-safety-and-invites.md): the re-judge keeps P also when it comes back not_checked or none.
  const held = fakeStore(paraphrase); // the email on To comes back with a non-verbatim quote -> not_checked
  held.store.set(k0, { ...stale(directKey), status: "not_checked", notCheckedReason: "quote_not_found", proposalId: "prop-rescued-earlier" } as ActionVerdict);
  await runClassify(asm, S1, judged, 5, withLock(held));
  const vh = held.store.get(k0);
  t("X-5 GUARD: prior {not_checked, proposalId P}, re-judge -> quote_not_found: P stays attached, 0 proposals made", [held.log.model, held.log.propose, vh?.status, vh?.notCheckedReason, vh?.proposalId], [1, 0, "not_checked", "quote_not_found", "prop-rescued-earlier"]);
  const momentary: Answer = (system, input) => (!input.includes("CHAT (oldest first)") && !system.includes("NOT on the To line") ? open("Thanks!", "Reply with thanks") : honest(system, input));
  const gone = fakeStore(momentary);
  gone.store.set(k0, stale(directKey));
  await runClassify(asm, S1, judged, 5, withLock(gone));
  const vg = gone.store.get(k0);
  // 2026-11-18 red-team RT-7: the F3 backstop FAILS OPEN. This email holds a real ask besides "Thanks!", so the quote
  // is no longer dropped to none; it is held (not_checked, the quote is under 8 chars). The X-5 invariants are unchanged:
  // P stays attached and 0 proposals are made.
  t("X-5b prior {open, proposalId P}, re-judge -> not open (a 'Thanks!' quote on a message with a real ask is held, RT-7): P stays attached, 0 proposals made", [gone.log.propose, vg?.status, vg?.notCheckedReason, vg?.proposalId], [0, "not_checked", "quote_not_found", "prop-decided-earlier"]);
  // RED-TEAM RT-31 (REDTEAM-actions-safety-invites.md, F5-14): a HELD item rescued by the owner (P written back) that
  // the re-judge now ADMITS as open keeps P -- never a second proposal, never listed twice.
  const rescued = fakeStore(honest);
  rescued.store.set(k0, { ...stale(directKey), status: "not_checked", notCheckedReason: "quote_not_found", proposalId: "prop-rescued-earlier" } as ActionVerdict);
  await runClassify(asm, S1, judged, 5, withLock(rescued));
  const vr = rescued.store.get(k0);
  t("RT-31 X-5/F5-14 prior held {not_checked, P}, re-judge -> open: P kept, 0 proposals made", [rescued.log.propose, vr?.status, vr?.proposalId], [0, "open", "prop-rescued-earlier"]);
}

// ── F4 / X-6 (AC-actions-safety-and-invites): the REPORT pass uses the SAME "Names that are you" ───────────────────
// The owner's second Teams account (another id, his configured full name) replies after the ask. With the resolved
// ownNames (here the seed: the configured full name) the report's model input labels it OWNER and the chat settled;
// with a saved EMPTY list it is labelled OTHER, as before F4.
{
  const SECOND = `19:f4_rep${AT}unq.gbl.spaces`;
  const f4rows: LedgerReportRow[] = [
    trow(SECOND, "1", "2026-11-10T17:00:00Z"),
    trow(SECOND, "2", "2026-11-10T17:05:00Z", { sender: { id: "owner-second-guid", name: "Owen Example", isApp: false }, fromOwner: null, ownerUserId: undefined, text: "Synthetic: yes, go ahead." }),
  ];
  const inputsFor = async (ownNames: string[] | undefined) => {
    const a = assembleLedgerPlan({ rows: f4rows, proposals: [], bell: [] }, cfg, SINCE, ownNames);
    const seen: string[] = [];
    const { deps, loadVerdicts } = fakeStore(() => ({ open_item: false, kind: "none", todo: null, due: null, quote: null, confidence: "high", reason: "Answered by your reply", category: "person_request" }));
    await runReportClassify({ assembled: a, settings: S(), sortingOn: true, usedToday: 0, maxCalls: 5, loadVerdicts, deps: { ...deps, model: async (sys, input, name) => (seen.push(input), deps.model(sys, input, name)) } });
    return seen.find((x) => x.includes("CHAT (oldest first)")) ?? "";
  };
  const seeded = await inputsFor(resolveActionsSettings({}, ownerFullNames(cfg)).ownNames);
  const cleared = await inputsFor(resolveActionsSettings({ ownNames: [] }, ownerFullNames(cfg)).ownNames);
  t(
    "F4-R GUARD (X-6): the report pass labels the owner's second account OWNER (chat settled) with the resolved names; a saved empty list keeps it OTHER",
    [seeded.includes("--- [2] OWNER |"), seeded.includes('"owner_already_replied_after_latest_other":true'), cleared.includes("--- [2] OTHER (Owen Example)"), cleared.includes('"owner_already_replied_after_latest_other":false')],
    [true, true, true, true],
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
