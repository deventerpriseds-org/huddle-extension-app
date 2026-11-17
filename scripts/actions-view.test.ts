// WHAT:       Offline tests (synthetic data only) for the Actions view's Tier 1 rules: the classifier ADMISSION guard
//             (a quote must be verbatim or nothing is shown), the section mapping, the since-Monday window, the
//             UNINVOLVED-CHAT spelling table S-1..S-15 (through the ONE rule, chatInvolvement, and the Actions units),
//             the heartbeat classify pass (no second call for a judged version, cap, failures store nothing, hidden
//             chats never reach the model, meeting items owner's-or-unassigned), THE SELECTION (resolved exclusion,
//             counts reconcile, What-shows hides are counted), and the Wrong? correction write / undo / new version.
// WHY:        AC docs/qc-evidence/AC-actions-view-modules.md sections C, D, E, E-U, H, I-8.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-actions-view.md.
// Run: bun scripts/actions-view.test.ts
import {
  actionSectionFor,
  admitActionVerdict,
  emailQuoteHaystack,
  quoteIsVerbatim,
  teamsQuoteHaystack,
  type ActionVerdict,
} from "../src/features/huddle/lib/correspondence/action-classify";
import { assembleLedgerPlan, chatInvolvement, type LedgerReportRow } from "../src/features/huddle/lib/correspondence/report-from-ledger";
import { parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import type { EmailContent, TeamsContent, TranscriptContent } from "../src/features/huddle/lib/correspondence/source-item";
import { teamsSourceItemId } from "../src/features/huddle/lib/correspondence/source-item";
import {
  ACTIONS_SETTINGS_DEFAULT,
  bellTargetsFor,
  chatIdOfTeamsItem,
  classifyEnabled,
  localMidnightMs,
  correctionFor,
  correctionHides,
  correctionsOf,
  makeCorrection,
  withItemCorrection,
  withItemUndo,
  resolveActionsSettings,
  selectActionItems,
  sinceMondayMs,
  type ActionCandidate,
  type ActionsSettings,
} from "../src/features/huddle/lib/actions/actions";
import { buildCandidates, classifyCallsLeft, runClassify, threadUnits, type ClassifyDeps } from "../src/features/huddle/lib/actions/pipeline";
import { meetingItemIsOwnersOrUnassigned, splitActionItems } from "../src/features/huddle/lib/proposals/meeting-triage";
import { titleKey } from "../src/features/huddle/lib/proposals/proposals";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const MAILBOX = "owner@work.example";
const OWNER_ID = "owner-guid-0001";
const NOW = "2026-11-12T15:00:00Z"; // a Thursday
const SINCE = Date.parse("2026-11-09T05:00:00Z"); // Monday 00:00 ET

// ── A. ADMISSION GUARD (AC-E-2..E-5) ─────────────────────────────────────────────────────────────────
const HAY = "Hi, could you confirm the venue hold by Thursday? Thanks.";
const good = { open_item: true, kind: "reply", todo: "Confirm the venue hold", due: "Thursday", quote: "could you confirm the venue hold by Thursday?", confidence: "high", reason: "Asked directly.", category: "person_request" };
const adm = (raw: unknown, hay = HAY, settled = false) => admitActionVerdict(raw, hay, { key: "k|1", settled, nowIso: NOW });
t("A-1 GUARD: open + verbatim quote -> open", adm(good).status, "open");
t("A-2 GUARD: quote not in the message -> not_checked (quote_not_found), never open", [adm({ ...good, quote: "please confirm the venue by Friday" }).status, adm({ ...good, quote: "please confirm the venue by Friday" }).notCheckedReason], ["not_checked", "quote_not_found"]);
t("A-3 GUARD: null quote on an open item -> not_checked", adm({ ...good, quote: null }).status, "not_checked");
t("A-4 GUARD: quote under 8 characters -> not_checked", adm({ ...good, quote: "confirm" }).status, "not_checked");
t("A-5 typographic quotes / whitespace fold", quoteIsVerbatim("could  you confirm the  venue hold", "Hi, could you confirm the venue hold"), true);
t("A-6 open_item false -> none; settled -> answeredByReply", [adm({ ...good, open_item: false }).status, adm({ ...good, open_item: false }, HAY, true).answeredByReply], ["none", true]);
t("A-7 bad shapes -> not_checked (bad_shape)", [null, [], "x", { ...good, open_item: "yes" }, { ...good, kind: "maybe" }, { ...good, category: "spam" }].map((r) => adm(r).notCheckedReason), ["bad_shape", "bad_shape", "bad_shape", "bad_shape", "bad_shape", "bad_shape"]);
t("A-8 open_item true with kind none -> not_checked", adm({ ...good, kind: "none" }).status, "not_checked");
// Loop-2 D1 (VERIFY-actions-view-2 Q15 / Q21): a quote stitched across two pieces must NOT pass.
const STITCH_CHAT = { messages: [{ speaker: "OTHER", text: "ok see you there" }, { speaker: "OWNER", text: "x" }, { speaker: "OTHER", text: "please send the deck" }] } as never;
t("A-9 GUARD: teams quote stitched across two OTHER messages -> not_checked", [quoteIsVerbatim("see you there please send the deck", teamsQuoteHaystack(STITCH_CHAT)), adm({ ...good, quote: "see you there please send the deck" }, teamsQuoteHaystack(STITCH_CHAT) as never).status], [false, "not_checked"]);
const FW_FACTS = { latestOther: { id: "feed:m2", text: "Pat here, see below" } } as never;
const FW_MAP = new Map([["feed:m2", "From: someone\n\nplease send the signed form by Friday"]]);
t("A-10 GUARD: email quote stitched across the body and its forwarded part -> not_checked", [quoteIsVerbatim("see below from: someone", emailQuoteHaystack(FW_FACTS, FW_MAP)), adm({ ...good, quote: "see below From: someone" }, emailQuoteHaystack(FW_FACTS, FW_MAP) as never).status], [false, "not_checked"]);
t("A-11 quote inside ONE piece still admits (teams 2nd message; email body; email forwarded part)", [adm({ ...good, quote: "please send the deck" }, teamsQuoteHaystack(STITCH_CHAT) as never).status, adm({ ...good, quote: "Pat here, see below" }, emailQuoteHaystack(FW_FACTS, FW_MAP) as never).status, adm({ ...good, quote: "send the signed form by Friday" }, emailQuoteHaystack(FW_FACTS, FW_MAP) as never).status], ["open", "open", "open"]);

// ── B. SECTIONS (AC-E-6) ─────────────────────────────────────────────────────────────────────────────
t(
  "B-1 sections: email reply/both -> needs_reply; action on To -> todo; action CC/list -> fyi; teams action -> todo",
  [actionSectionFor("email", "reply", "cc_only"), actionSectionFor("email", "both", "direct"), actionSectionFor("email", "action", "group"), actionSectionFor("email", "action", "unknown"), actionSectionFor("email", "action", "cc_only"), actionSectionFor("email", "action", "none"), actionSectionFor("teams", "action"), actionSectionFor("teams", "reply"), actionSectionFor("email", "none", "direct")],
  ["needs_reply", "needs_reply", "todo", "todo", "fyi", "fyi", "todo", "needs_reply", null],
);

// ── C. WINDOW (AC-E-9) ───────────────────────────────────────────────────────────────────────────────
const TZ = "America/New_York";
t("C-1 Thursday -> that week's Monday 00:00 ET", new Date(sinceMondayMs(Date.parse(NOW), TZ)).toISOString(), "2026-11-09T05:00:00.000Z");
t("C-2 on Monday 08:00 ET -> that same day's 00:00", new Date(sinceMondayMs(Date.parse("2026-11-16T13:00:00Z"), TZ)).toISOString(), "2026-11-16T05:00:00.000Z");
t("C-3 Sunday 23:30 ET -> the Monday before", new Date(sinceMondayMs(Date.parse("2026-11-16T04:30:00Z"), TZ)).toISOString(), "2026-11-09T05:00:00.000Z");
t("C-4 across the DST change (Mon 2026-11-02 was EST; Sun 11-01 EDT->EST)", new Date(sinceMondayMs(Date.parse("2026-11-04T12:00:00Z"), TZ)).toISOString(), "2026-11-02T05:00:00.000Z");
t("C-5 a summer week (EDT, -4h)", new Date(sinceMondayMs(Date.parse("2026-07-16T12:00:00Z"), TZ)).toISOString(), "2026-07-13T04:00:00.000Z");

// ── D. UNINVOLVED-CHAT SPELLING TABLE (AC-EU-1) -- the ONE rule ──────────────────────────────────────
const AT = "@";
const msg = (o: Partial<TeamsContent> = {}): TeamsContent => ({ kind: "teams", chatId: "c", chatName: "Synthetic chat", messageId: "1", at: "2026-11-10T15:00:00Z", sender: { id: "other-guid", name: "Pat Example", isApp: false }, fromOwner: false, text: "Can someone look at the synthetic draft?", webUrl: null, mentionedUserIds: [], ownerUserId: OWNER_ID, ...o });
const hide = (id: string, ms: TeamsContent[], cfgIds: string[] = []) => chatInvolvement(id, ms, cfgIds).hide;
const G = `19:abc${AT}thread.v2`;
t("S-1 1:1 shows", hide(`19:a_b${AT}unq.gbl.spaces`, [msg()]), false);
t("S-2 group, owner known, never wrote, mention arrays present and empty -> HIDE", hide(G, [msg(), msg({ messageId: "2" })]), true);
t("S-3 meeting chat -> HIDE", hide(`19:meeting_xyz${AT}thread.v2`, [msg()]), true);
t("S-4 channel (thread.tacv2) -> HIDE like a group", hide(`19:abc${AT}thread.tacv2`, [msg()]), true);
t("S-5 upper-case id -> same as S-2", hide(`19:ABC${AT}THREAD.V2`, [msg()]), true);
t("S-6 owner wrote (fromOwner true) -> show", hide(G, [msg(), msg({ fromOwner: true })]), false);
t("S-7 sender id is the owner's in other case -> show", hide(G, [msg({ sender: { id: OWNER_ID.toUpperCase(), name: "x", isApp: false } })]), false);
t("S-8 owner @mentioned -> show", hide(G, [msg({ mentionedUserIds: [OWNER_ID] })]), false);
t("S-9 only a team/tag mention (no user id) -> HIDE (not the owner)", hide(G, [msg({ mentionedUserIds: [] })]), true);
t("S-10 one message has no mention data -> show (fail open)", hide(G, [msg(), msg({ mentionedUserIds: undefined })]), false);
t("S-11 no owner id anywhere -> show (fail open)", hide(G, [msg({ ownerUserId: undefined })]), false);
t("S-12 fromOwner null -> show (fail open)", hide(G, [msg({ fromOwner: null })]), false);
t("S-13 unknown id suffix -> show", hide(`19:abc${AT}foo`, [msg()]), false);
t("S-14 owner wrote only BEFORE the window -> show (any stored message counts)", hide(G, [msg({ at: "2026-11-01T10:00:00Z", fromOwner: true }), msg()]), false);

// Ledger fixtures for the pipeline.
const cfg = parseFeedsConfig(JSON.stringify({ enabled: true, synthetic: false, driveUser: MAILBOX, mailbox: MAILBOX, ownerLogins: ["owner@huddle.example"], teams: { ownerSenderIds: [OWNER_ID] }, correspondence: { ownerNames: ["Owen Example"] } }))!;
const trow = (chatId: string, id: string, at: string, o: Partial<TeamsContent> = {}): LedgerReportRow => ({ source: "teams", sourceItemId: teamsSourceItemId(chatId, id), threadId: chatId, at, content: { ...msg({ chatId, messageId: id, at }), ...o } });
const erow = (id: string, conv: string, at: string, o: Partial<EmailContent> = {}): LedgerReportRow => ({
  source: "email",
  sourceItemId: `${MAILBOX}:${id}`,
  threadId: conv,
  at,
  content: { kind: "email", subject: "Synthetic subject", from: { name: "Pat Example", address: "pat@partner.example" }, to: [MAILBOX], cc: [], receivedAt: at, conversationId: conv, internetMessageId: null, bodyText: HAY, isForward: false, ...o },
});
const UNINV = `19:grp${AT}thread.v2`;
const ONE = `19:x_y${AT}unq.gbl.spaces`;
const rows: LedgerReportRow[] = [
  erow("m1", "conv-1", "2026-11-10T14:00:00Z"),
  erow("m2", "conv-2", "2026-11-11T14:00:00Z", { to: ["list@work.example"], cc: [], from: { name: "Ops List", address: "ops-list@work.example" } }),
  erow("old", "conv-old", "2026-11-02T14:00:00Z"),
  trow(UNINV, "1", "2026-11-10T16:00:00Z"),
  trow(ONE, "1", "2026-11-10T17:00:00Z", { text: "Are you OK with me sending the draft to legal today?" }),
  { source: "transcript", sourceItemId: "mtg-1", threadId: null, at: "2026-11-10T18:00:00Z", content: { kind: "transcript", title: "Synthetic sync", meetingAt: "2026-11-10T18:00:00Z", summary: { action_items: "**Owen Example**\nShare the updated wireframes (01:00)\n**Pat Example**\nBook the room (02:00)\nUnassigned line with no heading change" } } as unknown as LedgerReportRow["content"] } as LedgerReportRow,
];
const data = { rows, proposals: [], bell: [] };
const asm = assembleLedgerPlan(data, cfg, SINCE);
const S = (o: Partial<ActionsSettings> = {}) => ({ ...ACTIONS_SETTINGS_DEFAULT, ...o });
{
  const on = threadUnits(asm, S());
  const off = threadUnits(asm, S({ hideUninvolvedChats: false }));
  t("S-15 switch OFF: the uninvolved chat becomes a unit (classified like any other); ON: it does not", [on.units.some((u) => u.teams?.chatId === UNINV), off.units.some((u) => u.teams?.chatId === UNINV && u.uninvolved)], [false, true]);
  t("D-1 window: an email conversation before Monday is not a unit", on.units.some((u) => u.email?.key.includes("conv-old")), false);
}

// ── E. CLASSIFY PASS (AC-E-7, E-8, E-5, EU-2, H-3, meetings) ──────────────────────────────────────────
const stub = (answer: (system: string, input: string) => unknown) => {
  const calls: string[] = [];
  const stored = new Map<string, ActionVerdict>();
  const meeting: string[][] = [];
  const deps: ClassifyDeps = {
    recordCall: async () => {},
    model: async (system, input) => {
      calls.push(input);
      const a = answer(system, input);
      if (a instanceof Error) throw a;
      return a;
    },
    propose: async (u) => ({ id: `prop-${u.refItemId.length.toString(16)}${calls.length}`, onBoard: false }),
    storeVerdict: async (at, v) => void stored.set(`${at.source}\u0000${at.sourceItemId}`, v),
    addMeetingRows: async (_m, items) => (meeting.push(items), items.length),
    nowIso: () => NOW,
  };
  return { deps, calls, stored, meeting };
};
const teamsAnswer = { ...good, quote: "Are you OK with me sending the draft to legal today?" };
// Step 3 (CC / list) answers "action"; step 2 and Teams answer "reply".
const answerFor = (system: string, input: string) => (input.includes("CHAT (oldest first)") ? teamsAnswer : system.includes("NOT on the To line") ? { ...good, kind: "action" } : good);
{
  const s1 = stub(answerFor);
  const r1 = await runClassify(asm, S(), new Set(), 10, s1.deps);
  t("E-1 one call per in-window thread; the uninvolved chat never reaches the model (EU-2)", [r1.calls, r1.uninvolvedSkipped, s1.calls.some((c) => c.includes("Can someone look"))], [3, 1, false]);
  t("E-2 three verdicts stored on the latest message rows", s1.stored.size, 3);
  const judged = new Set([...s1.stored.values()].map((v) => v.key));
  const s2 = stub(answerFor);
  const r2 = await runClassify(asm, S(), judged, 10, s2.deps);
  t("E-3 GUARD: a judged version is never sent again (AC-E-7)", [r2.calls, r2.alreadyJudged], [0, 3]);
  const s3 = stub(answerFor);
  const r3 = await runClassify(asm, S(), new Set(), 1, s3.deps);
  t("E-4 GUARD: daily cap -> at most N calls, the rest counted over_cap (AC-E-8)", [r3.calls, r3.overCap], [1, 2]);
  const s4 = stub(() => new Error("boom"));
  const r4 = await runClassify(asm, S(), new Set(), 10, s4.deps);
  t("E-5 GUARD: a model failure stores nothing (retried next pass)", [r4.failures, s4.stored.size], [3, 0]);
  const s5 = stub(answerFor);
  await runClassify(asm, S({ hideUninvolvedChats: false }), new Set(), 10, s5.deps);
  t("E-6 switch OFF: the uninvolved chat IS classified", s5.calls.length, 4);
  // The third line sits under the second heading (Pat), so it is Pat's, not unassigned.
  t("E-7 meetings: only the owner's (and unassigned) items become triage rows", s1.meeting, [["Share the updated wireframes"]]);
  const s6 = stub(answerFor);
  const r6 = await runClassify(asm, S({ sources: { email: false, teams: true, meeting: false } }), new Set(), 10, s6.deps);
  t("E-8 a source switched off is not classified", [r6.calls, s6.meeting.length], [1, 0]);
  const s7 = stub(answerFor);
  await runClassify(asm, S(), new Set(), 10, { ...s7.deps, nowMs: () => 100, deadlineMs: 50 });
  t("E-9 no model call starts after the pass deadline", s7.calls.length, 0);
}

// ── D2 (loop 2): EVERY model call attempt counts toward the daily cap at the moment it is made ────────
// The server's own formula: attempts recorded since local midnight -> classifyCallsLeft(used, cap) per pass.
{
  const day = (iso: string) => new Date(localMidnightMs(Date.parse(iso), "America/New_York")).toISOString();
  const passAt = (i: number) => `2026-11-16T${String(15 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00.000Z`;
  /** 10 passes, 10 minutes apart, one day; the failure mode is injected; attempts live in an in-memory "ledger". */
  const tenPasses = async (failure: "model" | "timeout" | "propose" | "store", cap = 5, recordFails = false) => {
    const attempts: string[] = [];
    let modelCalls = 0;
    for (let i = 0; i < 10; i++) {
      const now = passAt(i);
      const used = attempts.filter((a) => a >= day(now)).length;
      const s = stub(answerFor);
      await runClassify(asm, S(), new Set(), classifyCallsLeft(used, cap), {
        ...s.deps,
        nowIso: () => now,
        recordCall: async () => {
          if (recordFails) throw new Error("db down");
          attempts.push(now);
        },
        model: async (system, input) => {
          modelCalls++;
          if (failure === "model") throw new Error("429");
          if (failure === "timeout") throw new Error("classify_timeout");
          return answerFor(system, input);
        },
        propose: async (u) => {
          if (failure === "propose") throw new Error("propose failed");
          return { id: `prop-${u.refItemId.length}`, onBoard: false };
        },
        storeVerdict: async () => {
          if (failure === "store") throw new Error("write failed");
        },
      });
    }
    return { modelCalls, attempts: attempts.length };
  };
  const failing = await tenPasses("model");
  t("D2-1 GUARD: cap 5, model failing, 10 passes -> at most 5 model calls (verifier probe A gave 50)", [failing.modelCalls <= 5, failing.modelCalls, failing.attempts], [true, 5, 5]);
  t("D2-2 GUARD: timeouts / failed proposal writes / failed verdict writes each count too", [(await tenPasses("timeout")).modelCalls, (await tenPasses("propose")).modelCalls, (await tenPasses("store")).modelCalls], [5, 5, 5]);
  t("D2-3 GUARD: when the attempt cannot be recorded, NO model call is made", (await tenPasses("model", 5, true)).modelCalls, 0);
  t("D2-4 classifyCallsLeft: per-pass 6, cap reached, over cap, junk count fails closed", [classifyCallsLeft(0, 150), classifyCallsLeft(147, 150), classifyCallsLeft(150, 150), classifyCallsLeft(400, 150), classifyCallsLeft(Number.NaN, 150)], [6, 3, 0, 0, 0]);
  // The next local day starts fresh (owner zone): attempts at 23:50 ET do not count after 00:00 ET.
  t("D2-5 the count is per local day", [day("2026-11-17T04:50:00.000Z") === day("2026-11-16T15:00:00.000Z"), day("2026-11-17T05:10:00.000Z") > "2026-11-17T04:50:00.000Z"], [true, true]);
  // D3 (accepted, measured): two instances that start a pass at the same instant both read the same count.
  const shared: string[] = [];
  let concurrent = 0;
  const one = () => {
    const s = stub(answerFor);
    const used = 3; // read by both before either records
    return runClassify(asm, S(), new Set(), classifyCallsLeft(used, 5), { ...s.deps, recordCall: async () => void shared.push("x"), model: async (sy, inp) => (concurrent++, answerFor(sy, inp)) });
  };
  await Promise.all([one(), one()]);
  t("D3-MEASURE two simultaneous instances, cap 5, 3 used: 4 calls -> 7 for the day (overrun = 2 = (instances-1) x left)", [concurrent, 3 + shared.length], [4, 7]);
}

// Meeting headings.
t("M-1 splitter keeps the heading each item sat under", splitActionItems("**Owen Example**\nShare it (01:00)\n**Pat Example**\nBook it").headings, ["Owen Example", "Pat Example"]);
t("M-2 owner's or unassigned", [meetingItemIsOwnersOrUnassigned(null, ["Owen Example"]), meetingItemIsOwnersOrUnassigned("Owen", ["Owen Example"]), meetingItemIsOwnersOrUnassigned("owen example", ["Owen Example"]), meetingItemIsOwnersOrUnassigned("Pat Example", ["Owen Example"]), meetingItemIsOwnersOrUnassigned("Everyone", ["Owen Example"])], [true, true, true, false, true]);

// ── F. SELECTION (Tier 1: resolved exclusion, counts, hides) ─────────────────────────────────────────
const disp = { title: "t", who: "w", sourceLabel: "Email", reasonLine: null, quote: null, due: null, reply: null, replyAsk: null, teamsLink: null, meetingTitle: null, assignee: null };
const cand = (o: Partial<ActionCandidate>): ActionCandidate => ({ proposalId: `prop-${Math.random().toString(16).slice(2, 10)}`, proposalState: "proposed", source: "email", status: "open", answeredByReply: false, onBoard: false, section: "needs_reply", category: "person_request", kind: "reply", itemKey: "k|1", correction: null, listSender: null, uninvolved: false, at: "2026-11-10T10:00:00Z", display: disp, ...o });
{
  const cs: ActionCandidate[] = [
    cand({}),
    cand({ source: "teams", section: "todo", kind: "action" }),
    cand({ source: "meeting", section: "meetings", proposalState: "untriaged", category: null }),
    cand({ section: "fyi", kind: "action", listSender: "ops-list@work.example" }),
    cand({ proposalState: "approved" }), // resolved
    cand({ proposalState: "dismissed" }), // resolved
    cand({ proposalState: "completed" }), // resolved
    cand({ proposalState: "delegated" }), // resolved
    cand({ onBoard: true }), // already on the board
    cand({ status: "not_checked" }),
    cand({ proposalId: null }), // admitted but nothing backs it
    cand({ status: "none", answeredByReply: true }),
    cand({ status: "none" }),
    cand({ category: "meeting_invite" }),
    cand({ category: "timekeeping" }),
    cand({ category: "verification_code" }),
  ];
  const sel = selectActionItems(cs, S());
  t("F-1 GUARD: decided proposals / on-board items are not listed (AC-E-13)", sel.rows.every((r) => r.state === "proposed" || r.state === "untriaged"), true);
  t("F-2 rows / answered / not checked / hidden", [sel.rows.length, sel.answered.length, sel.notChecked, sel.hidden.total], [4, 1, 2, 3]);
  t("F-3 RECONCILE: email + teams + meetings = all = sum of sections (AC-D-2)", [sel.counts.email + sel.counts.teams + sel.counts.meeting === sel.counts.all, Object.values(sel.sectionCounts).reduce((a, b) => a + b, 0) === sel.counts.all], [true, true]);
  t("F-4 section order", sel.rows.map((r) => r.section), ["needs_reply", "todo", "fyi", "meetings"]);
  const shown = selectActionItems(cs, S({ hideCategories: [] }));
  t("F-5 a category switched off shows its items at once (no reclassify, AC-D-6)", [shown.rows.length, shown.hidden.total], [7, 0]);
  const noTeams = selectActionItems(cs, S({ sources: { email: true, teams: false, meeting: true } }));
  t("F-6 source off -> hidden and counted", [noTeams.counts.teams, noTeams.hidden.sources], [0, 1]);
  const stopped = selectActionItems(cs, S({ hiddenSenders: ["ops-list@work.example"] }));
  t("F-7 stopped list -> hidden and counted, never silently dropped", [stopped.rows.some((r) => r.listSender), stopped.hidden.senders], [false, 1]);
}

// ── G. CORRECTIONS (Wrong?) AC-C-17..C-19, E-14 ──────────────────────────────────────────────────────
{
  const made = makeCorrection({ reason: "not_mine", text: "  Pat owns it now  ", itemKey: "k|1" }, null, NOW);
  t("G-1 a correction is validated and its text trimmed", made.ok && [made.correction.reason, made.correction.text, made.correction.itemKey], ["not_mine", "Pat owns it now", "k|1"]);
  t("G-2 unknown reason refused", makeCorrection({ reason: "rude", itemKey: "k|1" }, null, NOW).ok, false);
  t("G-3 text bounded to 500", made.ok && makeCorrection({ reason: "not_mine", text: "x".repeat(900), itemKey: "k|1" }, null, NOW).ok && (makeCorrection({ reason: "not_mine", text: "x".repeat(900), itemKey: "k|1" }, null, NOW) as { correction: { text: string } }).correction.text.length, 500);
  const c = made.ok ? made.correction : null;
  t("G-4 GUARD: hides the SAME version only", [correctionHides(c, "k|1"), correctionHides(c, "k|2"), correctionHides(null, "k|1")], [true, false, false]);
  t("G-5 GUARD: Undo (withdrawn) shows it again", correctionHides(c ? { ...c, withdrawnAt: NOW } : null, "k|1"), false);
  const again = makeCorrection({ reason: "wrong_section", itemKey: "k|2" }, c ? { ...c, withdrawnAt: NOW } : null, NOW);
  t("G-6 history kept on a second correction", again.ok && again.correction.history?.length, 1);
  const sel = selectActionItems([cand({ correction: c }), cand({ correction: c, itemKey: "k|2" })], S());
  t("G-7 selection: corrected version -> Corrected list (not counted); a newer version is listed", [sel.corrected.length, sel.rows.length, sel.counts.all], [1, 1, 1]);
}

// ── H. Bell targets (X-6, AC-I-8) + settings + candidates ────────────────────────────────────────────
t("H-1 bell targets from refs: email -> feed id; teams -> decoded chat id; meetings none", bellTargetsFor([{ source: "email", sourceItemId: `${MAILBOX}:m1` }, { source: "teams", sourceItemId: teamsSourceItemId(ONE, "1") }, { source: "transcript", sourceItemId: "mtg-1" }]), { emailGraphIds: [`feed:${MAILBOX}:m1`], chatIds: [ONE] });
t("H-2 chat id decoded from a ledger id", chatIdOfTeamsItem(teamsSourceItemId(UNINV, "17")), UNINV);
t("H-3 settings defaults: three noise categories, uninvolved ON, all sources, cap 150", [resolveActionsSettings(null).hideCategories, resolveActionsSettings(null).hideUninvolvedChats, resolveActionsSettings(null).dailyCap], [["meeting_invite", "timekeeping", "verification_code"], true, 150]);
t("H-4 settings: junk falls back field by field; cap clamped", [resolveActionsSettings({ hideCategories: ["spam", "timekeeping"], dailyCap: 99999, timeZone: "Mars/Base" }).hideCategories, resolveActionsSettings({ dailyCap: 99999 }).dailyCap, resolveActionsSettings({ timeZone: "Mars/Base" }).timeZone], [["timekeeping"], 2000, "America/New_York"]);
t("H-5 classify ON by default for the configured owner only; explicit wins", [classifyEnabled(S(), true), classifyEnabled(S(), false), classifyEnabled(S({ classify: false }), true)], [true, false, false]);
{
  const s1 = stub(answerFor);
  await runClassify(asm, S(), new Set(), 10, s1.deps);
  const props = new Map([...s1.stored.values()].filter((v) => v.proposalId).map((v) => [v.proposalId!, { id: v.proposalId!, state: "proposed", title: v.todo ?? "", assignee: null, correction: null }]));
  const meetingProposals = [{ id: "prop-aa", state: "untriaged", title: "Share the updated wireframes", assignee: null, correction: null, meetingId: "mtg-1", normTitle: titleKey("Share the updated wireframes") }, { id: "prop-bb", state: "untriaged", title: "Book the room", assignee: null, correction: null, meetingId: "mtg-1", normTitle: titleKey("Book the room") }];
  const b = buildCandidates({ assembled: asm, rows, settings: S(), verdicts: s1.stored, proposals: props, meetingProposals, replies: [], isDraftable: () => false });
  const sel = selectActionItems(b.candidates, S());
  t("H-6 end to end: 2 email + 1 Teams 1:1 + 1 meeting (owner's) listed; the 2 items under another attendee's heading not", [sel.counts.email, sel.counts.teams, sel.counts.meeting, b.meetingOthersHidden], [2, 1, 1, 2]);
  t("H-7 the CC/list email lands in FYI and carries its list sender", sel.rows.filter((r) => r.section === "fyi").map((r) => r.listSender), ["ops-list@work.example"]);
}

// ── D4 (loop 2, Tier 1): corrections are kept PER ITEM VERSION; two threads sharing ONE proposal never affect
//    each other (VERIFY-actions-view-2 D4: Wrong? on B used to overwrite A's single correction and bring A back) ──
{
  const A = "teams:chatA|msgA1";
  const B = "teams:chatB|msgB1";
  const hides = (stored: unknown, k: string) => correctionHides(correctionFor(stored, k), k);
  const w1 = withItemCorrection(null, { reason: "not_mine", itemKey: A }, "2026-11-16T10:00:00Z");
  const w2 = w1.ok ? withItemCorrection(w1.stored, { reason: "not_mine", itemKey: B }, "2026-11-16T10:05:00Z") : null;
  const s2 = w2 && w2.ok ? w2.stored : null;
  t("D4-1 GUARD: verifier repro -- Wrong? on A, then Wrong? on B: A stays hidden AND B is hidden", [hides(s2, A), hides(s2, B)], [true, true]);
  const u = withItemUndo(s2, B, "2026-11-16T10:06:00Z");
  t("D4-2 GUARD: Undo on B shows B again and leaves A's correction byte-identical", [hides(u.stored, A), hides(u.stored, B), JSON.stringify(correctionFor(u.stored, A)) === JSON.stringify(correctionFor(s2, A))], [true, false, true]);
  t("D4-3 Undo on an item with no correction (or already withdrawn) changes nothing", [withItemUndo(w1.ok ? w1.stored : null, B, NOW).changed, withItemUndo(u.stored, B, NOW).changed], [false, false]);
  const legacy = w1.ok ? w1.correction : null; // the pre-D4 single-object column value
  t("D4-4 the pre-D4 single shape is read as its one item (still hides A, not B)", [hides(legacy, A), hides(legacy, B)], [true, false]);
  const fromLegacy = withItemCorrection(legacy, { reason: "wrong_section", itemKey: B }, NOW);
  t("D4-5 a correction on B over a pre-D4 value keeps A", fromLegacy.ok && [hides(fromLegacy.stored, A), hides(fromLegacy.stored, B)], [true, true]);
  t("D4-6 a newer version of A (new key) is judged again", hides(s2, "teams:chatA|msgA2"), false);
  t("D4-7 malformed column values and entries filed under the wrong key are ignored (never hide)", [correctionsOf("junk").size, correctionsOf({ v: 2, items: { X: { ...(legacy ?? {}), itemKey: "Y" } } }).size, correctionsOf({ v: 2, items: null }).size], [0, 0, 0]);
  t("D4-8 history is per item: B's second correction keeps B's history only", (() => {
    const again = s2 ? withItemCorrection(s2, { reason: "wrong_section", itemKey: B }, NOW) : null;
    return again && again.ok ? [again.correction.history?.length ?? 0, correctionFor(again.stored, A)?.history?.length ?? 0] : null;
  })(), [1, 0]);
  // End to end through buildCandidates + the selection: two threads whose verdicts point at ONE shared proposal.
  const s = stub(answerFor);
  await runClassify(asm, S(), new Set(), 10, s.deps);
  const open = [...s.stored.entries()].filter(([, v]) => v.status === "open" && v.proposalId).slice(0, 2);
  const shared = new Map(s.stored);
  for (const [k, v] of open) shared.set(k, { ...v, proposalId: "prop-shared" });
  const [ka, kb] = open.map(([, v]) => v.key);
  const listed = (stored: unknown) => {
    const props = new Map([...shared.values()].filter((v) => v.proposalId).map((v) => [v.proposalId!, { id: v.proposalId!, state: "proposed", title: v.todo ?? "", assignee: null, correction: v.proposalId === "prop-shared" ? stored : null }]));
    const sel = selectActionItems(buildCandidates({ assembled: asm, rows, settings: S(), verdicts: shared, proposals: props, meetingProposals: [], replies: [], isDraftable: () => false }).candidates, S());
    return { rows: sel.rows.map((r) => r.itemKey).filter((k) => k === ka || k === kb).sort(), corrected: sel.corrected.map((r) => r.itemKey).sort() };
  };
  const e1 = withItemCorrection(null, { reason: "not_mine", itemKey: ka }, "2026-11-16T10:00:00Z");
  const e2 = e1.ok ? withItemCorrection(e1.stored, { reason: "not_mine", itemKey: kb }, "2026-11-16T10:05:00Z") : null;
  const st2 = e2 && e2.ok ? e2.stored : null;
  t("D4-E1 two threads share one proposal (setup)", [open.length, !!ka && !!kb && ka !== kb, listed(null).rows.length], [2, true, 2]);
  t("D4-E2 GUARD: Wrong? on thread A then thread B -> BOTH in Corrected, neither listed", listed(st2), { rows: [], corrected: [ka, kb].sort() });
  t("D4-E3 GUARD: Undo on B -> B listed again, A stays in Corrected", listed(withItemUndo(st2, kb, NOW).stored), { rows: [kb], corrected: [ka] });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
