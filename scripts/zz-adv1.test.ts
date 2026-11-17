// Verifier adversarial tests (synthetic data only). Run from the worktree: bun <this file>
const W = "/home/user/huddle-extension-app/.claude/worktrees/agent-aa6e34f1787419246";
const { assembleLedgerPlan } = await import(`${W}/src/features/huddle/lib/correspondence/report-from-ledger`);
const { parseFeedsConfig } = await import(`${W}/src/features/huddle/lib/external-feeds/onedrive-feed`);
const { teamsSourceItemId } = await import(`${W}/src/features/huddle/lib/correspondence/source-item`);
const { ACTIONS_SETTINGS_DEFAULT } = await import(`${W}/src/features/huddle/lib/actions/actions`);
const P = await import(`${W}/src/features/huddle/lib/actions/pipeline`);
const H = await import(`${W}/scripts/action-report-html`);

let fail = 0, pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const MAILBOX = "owner@work.example";
const OWNER_ID = "owner-guid-0001";
const NOW = "2026-11-12T15:00:00Z";
const SINCE = Date.parse("2026-11-09T05:00:00Z");
const HAY = "Hi, could you confirm the venue hold by Thursday? Thanks.";
const CHAT_TEXT = "Are you OK with me sending the draft to legal today?";
const cfg = parseFeedsConfig(JSON.stringify({ enabled: true, synthetic: false, driveUser: MAILBOX, mailbox: MAILBOX, ownerLogins: ["owner@huddle.example"], teams: { ownerSenderIds: [OWNER_ID] }, correspondence: { ownerNames: ["Owen Example"] } }))!;
const trow = (chatId: string, id: string, at: string, o: any = {}) => ({ source: "teams", sourceItemId: teamsSourceItemId(chatId, id), threadId: chatId, at, content: { kind: "teams", chatId, chatName: "Synthetic chat", messageId: id, at, sender: { id: "other-guid", name: "Pat Example", isApp: false }, fromOwner: false, text: CHAT_TEXT, webUrl: null, mentionedUserIds: [], ownerUserId: OWNER_ID, ...o } });
const erow = (id: string, conv: string, at: string, o: any = {}) => ({ source: "email", sourceItemId: `${MAILBOX}:${id}`, threadId: conv, at, content: { kind: "email", subject: "Synthetic subject", from: { name: "Pat Example", address: "pat@partner.example" }, to: [MAILBOX], cc: [], receivedAt: at, conversationId: conv, internetMessageId: null, bodyText: HAY, isForward: false, ...o } });
const S = (o: any = {}) => ({ ...ACTIONS_SETTINGS_DEFAULT, sources: { email: true, teams: true, meeting: false }, ...o });

const open = (quote: string, todo: string, kind = "reply") => ({ open_item: true, kind, todo, due: null, quote, confidence: "high", reason: "Asked directly.", category: "person_request" });
function fake(answer: (sys: string, inp: string) => unknown, o: { recordFailAt?: number; delayMs?: number } = {}) {
  const store = new Map<string, any>();
  const log = { model: 0, record: 0, propose: 0, meeting: 0, inflight: 0, maxInflight: 0 };
  const deps: any = {
    recordCall: async () => { log.record++; if (o.recordFailAt && log.record === o.recordFailAt) throw new Error("x"); },
    model: async (s: string, i: string) => { log.model++; log.inflight++; log.maxInflight = Math.max(log.maxInflight, log.inflight); await new Promise((r) => setTimeout(r, o.delayMs ?? 5)); log.inflight--; return answer(s, i); },
    propose: async (u: any) => (log.propose++, { id: `prop-${log.propose}`, onBoard: false }),
    storeVerdict: async (at: any, v: any) => void store.set(`${at.source}\u0000${at.sourceItemId}`, v),
    addMeetingRows: async () => (log.meeting++, 1),
    nowIso: () => NOW,
  };
  return { store, log, deps, loadVerdicts: async () => new Map(store) };
}

// ── AC1: Teams non-verbatim, settled guard ──
{
  const asm = assembleLedgerPlan({ rows: [trow("19:a_b@unq.gbl.spaces", "1", "2026-11-10T17:00:00Z")], proposals: [], bell: [] }, cfg, SINCE);
  const f = fake(() => open("Are you fine sending the draft to legal?", "Answer"));
  const r = await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S(), usedToday: 0, maxCalls: 50, loadVerdicts: f.loadVerdicts, deps: f.deps });
  const v = [...f.store.values()][0];
  t("V1-1 Teams paraphrased quote -> stored not_checked/quote_not_found, no proposal", [v?.status, v?.notCheckedReason, f.log.propose, r.res.open], ["not_checked", "quote_not_found", 0, 0]);
  const rows = H.rowsFromStoredVerdicts(asm, S(), f.store);
  t("V1-2 ... and it is not a report row (listed not checked, counted not admitted)", [rows.teamsRows.length, rows.notCheckedTeams.length, rows.notAdmitted], [0, 1, 1]);
}
{
  // settled email: other writes, owner replies afterwards
  const rows = [erow("s1", "conv-s", "2026-11-10T10:00:00Z"), erow("s2", "conv-s", "2026-11-10T11:00:00Z", { from: { name: "Owen Example", address: MAILBOX }, to: ["pat@partner.example"], bodyText: "Confirmed." })];
  const asm = assembleLedgerPlan({ rows, proposals: [], bell: [] }, cfg, SINCE);
  const units = P.threadUnits(asm, S()).units;
  t("V1-3 fixture: settled email unit exists and is settled", [units.length, units[0]?.email?.settled], [1, true]);
  const f = fake(() => open("could you confirm the venue hold by Thursday?", "Reply to Pat", "reply"));
  await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S(), usedToday: 0, maxCalls: 50, loadVerdicts: f.loadVerdicts, deps: f.deps });
  const v = [...f.store.values()][0];
  t("V1-4 settled guard on report path: kind=reply on a settled thread -> not open, no proposal", [v?.status === "open", f.log.propose], [false, 0]);
}

// ── AC2 + AC3: heartbeat after the report makes 0 calls; stale inputVersion not shown open ──
{
  const rows = [erow("m1", "conv-1", "2026-11-10T14:00:00Z"), trow("19:c_d@unq.gbl.spaces", "1", "2026-11-10T17:00:00Z")];
  const asm = assembleLedgerPlan({ rows, proposals: [], bell: [] }, cfg, SINCE);
  const ans = (s: string, i: string) => (i.includes("CHAT (oldest first)") ? open(CHAT_TEXT, "Answer about the draft") : open("could you confirm the venue hold by Thursday?", "Confirm"));
  const f = fake(ans);
  const rep = await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S(), usedToday: 0, maxCalls: 50, loadVerdicts: f.loadVerdicts, deps: f.deps });
  t("V2-1 report judged both units", [rep.res.calls, rep.res.open], [2, 2]);
  const hb = await P.runClassify(asm, S(), P.currentlyJudgedKeys(await f.loadVerdicts()), P.classifyCallsLeft(rep.res.calls, S().dailyCap), f.deps);
  t("V2-2 heartbeat (runClassify, judged from the same store) after the report -> 0 calls, 2 already judged", [hb.calls, hb.alreadyJudged, f.log.model], [0, 2, 2]);
  // stale version: Teams verdict at inputVersion 1 (current is 2), and email at inputVersion 99
  const stale = new Map(f.store);
  for (const [k, v] of stale) stale.set(k, { ...v, inputVersion: k.startsWith("teams") ? 1 : 99 });
  const rs = H.rowsFromStoredVerdicts(asm, S(), stale);
  t("V3-1 stale-version verdicts (teams v1, email v99) are NOT rows (not open); listed not checked", [rs.step2.length + rs.step3.length + rs.teamsRows.length, rs.notCheckedEmail.length, rs.notCheckedTeams.length], [0, 1, 1]);
  const html = H.renderActionReportHtml({ ...rs, conversations: 1, calls: 0, failures: 0, overCap: 0, maxCalls: 1, settledIndirect: 0, sinceMs: SINCE, forwardsRead: 0, model: "m", hide: new Set(), notCheckedTitle: "NC", notCheckedNote: "n" }).html;
  t("V3-2 stale verdict's to-do text never appears in the HTML", [html.includes("Answer about the draft"), html.includes(">Confirm<")], [false, false]);
  // and a stale verdict is re-judged by the report (costs a call), never skipped
  const g = fake(ans); for (const [k, v] of stale) g.store.set(k, v);
  const r2 = await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S(), usedToday: 0, maxCalls: 50, loadVerdicts: g.loadVerdicts, deps: g.deps });
  t("V3-3 stale verdicts are re-judged by the report pass", [r2.res.calls, r2.res.alreadyJudged], [2, 0]);
}

// ── AC5: cap with concurrency 5 ──
{
  const rows = Array.from({ length: 12 }, (_, i) => erow(`c${i}`, `conv-c${i}`, `2026-11-10T1${i % 10}:0${i % 6}:00Z`));
  const asm = assembleLedgerPlan({ rows, proposals: [], bell: [] }, cfg, SINCE);
  const n = P.threadUnits(asm, S()).units.length;
  t("V5-0 fixture: 12 units", n, 12);
  const ans = () => open("could you confirm the venue hold by Thursday?", "Confirm");
  for (const left of [0, 1, 3, 4, 5, 6, 7, 11]) {
    const f = fake(ans);
    const cap = S().dailyCap;
    const r = await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S(), usedToday: cap - left, maxCalls: 250, concurrency: 5, loadVerdicts: f.loadVerdicts, deps: f.deps });
    t(`V5-1 cap leaves ${left}: recorded attempts, model calls, max in flight <= min(5,left), overCap`, [f.log.record, f.log.model, f.log.maxInflight <= Math.min(5, Math.max(left, 0)), r.res.overCap], [left, left, true, 12 - left]);
  }
  // usedToday above cap
  { const f = fake(ans); const r = await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S(), usedToday: S().dailyCap + 40, maxCalls: 250, concurrency: 5, loadVerdicts: f.loadVerdicts, deps: f.deps }); t("V5-2 over the cap already -> 0 calls", [f.log.record, r.callsLeft], [0, 0]); }
  // recordCall fails on the 2nd attempt within a batch -> no further batch starts, no more than batch size attempted
  { const f = fake(ans, { recordFailAt: 2 }); const r = await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S(), usedToday: 0, maxCalls: 250, concurrency: 5, loadVerdicts: f.loadVerdicts, deps: f.deps }); t("V5-3 a failed attempt record stops further batches (5 attempted, 4 calls)", [f.log.record, f.log.model, r.res.failures], [5, 4, 1]); }
  // maxCalls NaN guard (not reachable from the workflow: Number(x)||200) -- does runReportClassify terminate?
  {
    const f = fake(ans);
    const outcome = await Promise.race([
      P.runReportClassify({ sortingOn: true, assembled: asm, settings: S(), usedToday: 0, maxCalls: Number.NaN, concurrency: 5, loadVerdicts: f.loadVerdicts, deps: f.deps }).then((r: any) => `done calls=${r.res.calls}`),
      new Promise((res) => setTimeout(() => res("HUNG"), 1500)),
    ]);
    console.log(`INFO V5-4 maxCalls=NaN -> ${outcome}`);
  }
}

// ── AC4: save OFF writes nothing except the attempt record ──
{
  const rows = [erow("m1", "conv-1", "2026-11-10T14:00:00Z")];
  const asm = assembleLedgerPlan({ rows, proposals: [], bell: [] }, cfg, SINCE);
  (asm as any).plan.meetings.inWindow.push({ title: "Synthetic meeting", meetingAt: "2026-11-10T15:00:00Z", newestMs: Date.parse("2026-11-10T15:00:00Z"), open: ["Item one"], openHeadings: [null], resolved: [] });
  const f = fake(() => open("could you confirm the venue hold by Thursday?", "Confirm"));
  const io = P.inMemoryWrites(f.deps, f.loadVerdicts);
  const r = await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S({ sources: { email: true, teams: true, meeting: true } }), usedToday: 0, maxCalls: 50, loadVerdicts: io.loadVerdicts, deps: io.deps });
  t("V4-1 save OFF + meetings on: base storeVerdict/propose/addMeetingRows never called; recordCall IS called", [f.store.size, f.log.propose, f.log.meeting, f.log.record, r.res.meetingRows], [0, 0, 0, 1, 0]);
  const g = fake(() => open("could you confirm the venue hold by Thursday?", "Confirm"));
  const r2 = await P.runReportClassify({ sortingOn: true, assembled: asm, settings: S({ sources: { email: true, teams: true, meeting: true } }), usedToday: 0, maxCalls: 50, loadVerdicts: g.loadVerdicts, deps: g.deps });
  t("V4-2 save ON + meetings on: meeting rows ARE added (control)", [g.log.meeting, r2.res.meetingRows], [1, 1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
