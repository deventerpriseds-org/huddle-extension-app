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
  ACTION_SCHEMA,
  CLASSIFIER_INPUT_VERSION,
  STEP2_INSTRUCTIONS,
  STEP3_INSTRUCTIONS,
  TEAMS_INSTRUCTIONS,
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
  ACTIONS_RANGE_LABEL,
  ACTIONS_SETTINGS_DEFAULT,
  actionsWindowStartMs,
  bellTargetsFor,
  capNotice,
  chatIdOfTeamsItem,
  classifyEnabled,
  DAILY_CAP_DEFAULT,
  DAILY_CAP_SETTING_PATH,
  HIDEABLE_CATEGORIES,
  HIDEABLE_CATEGORY_LABEL,
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
  filterRows,
  plainPreview,
  PREVIEW_MAX,
  tabAfterRangeChange,
  tabCounts,
  type ActionCandidate,
  type ActionsSettings,
} from "../src/features/huddle/lib/actions/actions";
import { buildCandidates, classifyCallsLeft, currentlyJudgedKeys, runClassify, threadUnits, type ClassifyDeps } from "../src/features/huddle/lib/actions/pipeline";
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

// ── Owner decision 2026-11-17, through the Actions classifier path (threadUnits reuses chatInvolvement): a group chat
//    whose only mention is a team / tag / channel mention never becomes a unit (so it can never reach the model);
//    @Everyone and an old row without kind flags still do. Spelling table: docs/qc-evidence/BUILD-actions-cap-tag-rule.md.
{
  const TAGC = `19:tagonly${AT}thread.v2`;
  const EVC = `19:everyone${AT}thread.v2`;
  const OLDC = `19:oldrow${AT}thread.v2`;
  const groupOnly = { unresolvedMention: true, groupMentionOnly: true, chatWideMention: false };
  const mkRows: LedgerReportRow[] = [
    trow(TAGC, "1", "2026-11-10T16:00:00Z", groupOnly),
    trow(EVC, "1", "2026-11-10T16:00:00Z", { unresolvedMention: true, groupMentionOnly: false, chatWideMention: true }),
    trow(OLDC, "1", "2026-11-10T16:00:00Z", { unresolvedMention: true }),
    trow(ONE, "1", "2026-11-10T17:00:00Z", groupOnly),
  ];
  const mkAsm = assembleLedgerPlan({ rows: mkRows, proposals: [], bell: [] }, cfg, SINCE);
  const on = threadUnits(mkAsm, S());
  const off = threadUnits(mkAsm, S({ hideUninvolvedChats: false }));
  const has = (u: typeof on, c: string) => u.units.some((x) => x.teams?.chatId === c);
  t("MK-A1 Actions: a tag/team/channel-only group chat is NOT a unit and is counted hidden", [has(on, TAGC), on.uninvolvedHidden], [false, 1]);
  t("MK-A2 Actions: @Everyone and an old row (no kind flags) ARE units; a 1:1 with a tag mention is a unit", [has(on, EVC), has(on, OLDC), has(on, ONE)], [true, true, true]);
  t("MK-A3 Actions: with the switch OFF the tag-only chat is a unit flagged uninvolved", off.units.some((x) => x.teams?.chatId === TAGC && x.uninvolved), true);
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
t("H-3 settings defaults: four noise categories (app_invite added 2026-11-17), uninvolved ON, all sources, cap 500 (owner 2026-11-17, was 150)", [resolveActionsSettings(null).hideCategories, resolveActionsSettings(null).hideUninvolvedChats, resolveActionsSettings(null).dailyCap], [["meeting_invite", "timekeeping", "verification_code", "app_invite"], true, 500]);

// ── Owner 2026-11-17: the daily-cap notice. Same count and same condition as the heartbeat's cap (classifyCallsLeft).
t("CAP-1 default cap is 500; an explicitly stored 150 is the owner's value and is kept", [DAILY_CAP_DEFAULT, resolveActionsSettings({}).dailyCap, resolveActionsSettings({ dailyCap: 150 }).dailyCap], [500, 500, 150]);
t(
  "CAP-2 at the cap: the exact notice, naming where to change it",
  capNotice(500, 500, true),
  "Daily AI check limit reached (500 of 500 used today). Remaining items wait until tomorrow. To change the limit, open What shows → Sorting → Daily limit on this page.",
);
t(
  "CAP-3 below the cap / sorting off / count unreadable -> no notice; over the cap (limit lowered) -> notice with the real count",
  [capNotice(499, 500, true), capNotice(500, 500, false), capNotice(null, 500, true), capNotice(Number.NaN, 500, true), capNotice(undefined, 500, true), capNotice(520, 500, true)?.includes("(520 of 500 used today)")],
  [null, null, null, null, null, true],
);
{
  const pairs: [number, number][] = [];
  for (const cap of [0, 1, 5, 150, 500, 2000]) for (const used of [0, cap - 1, cap, cap + 1, cap + 50]) if (used >= 0) pairs.push([used, cap]);
  t("CAP-4 GUARD: notice shown EXACTLY when the heartbeat has no calls left (classifyCallsLeft = 0)", pairs.filter(([u, c]) => (capNotice(u, c, true) !== null) !== (classifyCallsLeft(u, c) === 0)), []);
}
{
  const { readFileSync } = await import("node:fs");
  const view = readFileSync(new URL("../src/features/huddle/components/ActionsView.tsx", import.meta.url), "utf8");
  const [panel, heading, field] = DAILY_CAP_SETTING_PATH.split(" → ");
  t(
    "CAP-5 GUARD: the place the notice names exists in the Actions view (What shows button, Sorting heading, Daily limit field) and the notice is rendered",
    [view.includes(`\`${panel}\${ok.hidden.total`), view.includes(`>${heading}</p>`), view.includes(`${field}\n`), view.includes("ok?.capNotice") && view.includes('data-testid="actions-cap-notice"')],
    [true, true, true, true],
  );
}
// 2026-11-17: a list saved before knownHideCategories existed also gets app_invite (a category added after he saved
// takes its default, hidden) -- see section AI below.
t("H-4 settings: junk falls back field by field; cap clamped", [resolveActionsSettings({ hideCategories: ["spam", "timekeeping"], dailyCap: 99999, timeZone: "Mars/Base" }).hideCategories, resolveActionsSettings({ dailyCap: 99999 }).dailyCap, resolveActionsSettings({ timeZone: "Mars/Base" }).timeZone], [["timekeeping", "app_invite"], 2000, "America/New_York"]);
// ── RANGE (owner 2026-11-17: "an option for all time vs this week") ─────────────────────────────────
t("RANGE-1 default range is this week; junk falls back to week; 'all' is kept", [ACTIONS_SETTINGS_DEFAULT.range, resolveActionsSettings(null).range, resolveActionsSettings({ range: "forever" }).range, resolveActionsSettings({ range: "all" }).range], ["week", "week", "week", "all"]);
t("RANGE-2 week window = since Monday 00:00 (unchanged behaviour)", actionsWindowStartMs(Date.parse(NOW), S()), SINCE);
{
  const earliest = Math.min(...rows.map((r) => Date.parse(r.at)));
  const allStart = actionsWindowStartMs(Date.parse(NOW), S({ range: "all" }));
  t("RANGE-3 all-time window starts at or before the earliest stored item", allStart <= earliest, true);
  const convs = (start: number) => assembleLedgerPlan(data, cfg, start).plan.email.scan.map((f) => f.conversationId).sort();
  t("RANGE-4 the pre-Monday email is out of the week window and in the all-time window", [convs(actionsWindowStartMs(Date.parse(NOW), S())).includes("conv-old"), convs(allStart).includes("conv-old")], [false, true]);
}
{
  // RANGE-5 GUARD: the page read and the heartbeat classify pass take their window from the SAME function and the SAME
  // settings object, so what is listed and what is judged can never differ (and "All time" reaches the classifier).
  const { readFileSync } = await import("node:fs");
  const srv = readFileSync(new URL("../src/features/huddle/lib/actions/actions.server.ts", import.meta.url), "utf8");
  const body = (start: string) => {
    const i = srv.indexOf(start);
    const j = srv.indexOf("\nexport ", i + start.length);
    return i < 0 ? "" : srv.slice(i, j < 0 ? undefined : j);
  };
  const classify = body("export function runActionsClassify(");
  const pageRead = body("export async function getActionsPage(");
  t(
    "RANGE-5 GUARD: page read and classify pass both window with actionsWindowStartMs(now, s), neither with a bare sinceMondayMs",
    // F4 (2026-11-18): both calls also pass the resolved "Names that are you" (s.ownNames) as the 4th argument.
    [classify.includes("assembleLedgerPlan(data, cfg, actionsWindowStartMs(now, s), s.ownNames)"), pageRead.includes("const sinceMs = actionsWindowStartMs(now, s);") && pageRead.includes("assembleLedgerPlan(data, cfg, sinceMs, s.ownNames)"), /sinceMondayMs\(/.test(srv)],
    [true, true, false],
  );
  const view = readFileSync(new URL("../src/features/huddle/components/ActionsView.tsx", import.meta.url), "utf8");
  t("RANGE-6 the view has the This week / All time toggle and the header follows the range", [view.includes('data-testid="actions-range"'), view.includes("ACTIONS_RANGES.map"), view.includes("sinceLabel(ok.sinceIso, tz, true, ok.settings.range)"), ACTIONS_RANGE_LABEL.week, ACTIONS_RANGE_LABEL.all], [true, true, true, "This week", "All time"]);
}
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

// ── UNCHECKED (owner 2026-11-17: "All time" showed only "120 not checked yet"; tabs/counts did not change) ──────
{
  const at = (d: number) => `2026-11-${String(d).padStart(2, "0")}T10:00:00Z`;
  const nc = (o: Partial<ActionCandidate>) => cand({ status: "not_checked", proposalId: null, proposalState: null, section: null, category: null, kind: null, ...o });
  const cs: ActionCandidate[] = [
    cand({ itemKey: "judged|1" }),
    nc({ itemKey: "u-email-old", at: at(2) }),
    nc({ itemKey: "u-teams-new", source: "teams", at: at(11) }),
    cand({ itemKey: "u-nobacking", proposalId: null, at: at(5) }), // admitted, nothing backs it
    nc({ itemKey: "u-uninv", source: "teams", uninvolved: true, at: at(6) }),
    nc({ itemKey: "u-list", listSender: "ops-list@work.example", at: at(7) }),
  ];
  const listedKeys = (sel: ReturnType<typeof selectActionItems>) => sel.unchecked.map((r) => r.itemKey);
  const allOn = selectActionItems(cs, S({ hideUninvolvedChats: false }));
  t("U-1 GUARD: not-checked items are LISTED, not only counted (notChecked === unchecked.length), newest first", [allOn.notChecked, allOn.unchecked.length, listedKeys(allOn)], [5, 5, ["u-teams-new", "u-list", "u-uninv", "u-nobacking", "u-email-old"]]);
  t("U-2 per-source unchecked counts reconcile with the list", [allOn.uncheckedCounts, allOn.uncheckedCounts.email + allOn.uncheckedCounts.teams + allOn.uncheckedCounts.meeting === allOn.uncheckedCounts.all], [{ all: 5, email: 3, teams: 2, meeting: 0 }, true]);
  const uninvHidden = selectActionItems(cs, S({ hideUninvolvedChats: true }));
  t("U-3 GUARD: hide uninvolved chats hides a not-checked uninvolved chat too (counted in hidden, not listed)", [listedKeys(uninvHidden).includes("u-uninv"), uninvHidden.hidden.uninvolved, uninvHidden.notChecked], [false, 1, 4]);
  const teamsOff = selectActionItems(cs, S({ hideUninvolvedChats: false, sources: { email: true, teams: false, meeting: true } }));
  t("U-4 GUARD: a source switched off hides its not-checked items (counted in hidden.sources)", [teamsOff.unchecked.some((r) => r.source === "teams"), teamsOff.hidden.sources, teamsOff.uncheckedCounts.teams], [false, 2, 0]);
  const senderOff = selectActionItems(cs, S({ hideUninvolvedChats: false, hiddenSenders: ["ops-list@work.example"] }));
  t("U-5 GUARD: a stopped list sender hides its not-checked email (counted in hidden.senders)", [listedKeys(senderOff).includes("u-list"), senderOff.hidden.senders], [false, 1]);
  t("U-6 judged rows are unaffected by the unchecked list (still counted only from rows)", [allOn.rows.map((r) => r.itemKey), allOn.counts.all], [["judged|1"], 1]);
  const tc = tabCounts(allOn.rows, allOn.unchecked);
  t("U-7 GUARD: the type tabs count the not-checked items too (a tab never reads 0 over a listed item)", tc, { all: 6, email: 4, teams: 2, meeting: 0 });
  t("U-8 a tab filter lists only that type's not-checked items", filterRows(allOn.unchecked, "teams").map((r) => r.itemKey), ["u-teams-new", "u-uninv"]);
  t("U-9 GUARD: changing the range resets the tab to All; the same range keeps it", [tabAfterRangeChange("teams", "week", "all"), tabAfterRangeChange("email", "all", "week"), tabAfterRangeChange("teams", "all", "all"), tabAfterRangeChange("all", "week", "all")], ["all", "all", "teams", "all"]);
  t("U-10 the preview is plain text: tags dropped, whitespace collapsed, bounded", [plainPreview("<p>Hi  <b>there</b></p>\n\nthanks"), plainPreview("   "), plainPreview(null), (plainPreview("x".repeat(400)) ?? "").length], ["Hi there thanks", null, null, PREVIEW_MAX]);
  // End to end: nothing judged yet (the All time backlog). Every in-scope thread is LISTED, with a preview.
  const b = buildCandidates({ assembled: asm, rows, settings: S(), verdicts: new Map(), proposals: new Map(), meetingProposals: [], replies: [], isDraftable: () => false });
  const sel = selectActionItems(b.candidates, S());
  const units = threadUnits(asm, S()).units.length;
  t("U-11 PARITY: with no verdicts, every in-scope thread is listed as not checked, each with a preview", [sel.notChecked === units, sel.unchecked.length === units, units > 0, sel.unchecked.every((r) => typeof r.preview === "string" && r.preview.length > 0), sel.rows.length], [true, true, true, true, 0]);
  // runClassify's concurrency option (kept for the daily-report path) still never starts more calls than allowed.
  const sc = stub(answerFor);
  const rc = await runClassify(asm, S({ hideUninvolvedChats: false }), new Set(), 2, { ...sc.deps, concurrency: 5 });
  t("U-12 GUARD: runClassify with concurrency 5 and 2 calls left starts exactly 2 calls", [rc.calls, rc.overCap > 0], [2, true]);
  const { readFileSync } = await import("node:fs");
  const view = readFileSync(new URL("../src/features/huddle/components/ActionsView.tsx", import.meta.url), "utf8");
  t(
    "U-13 the view lists the not-checked items (read-only rows), feeds unchecked into the tab counts, and resets the tab on a range change",
    // F5 (2026-11-18): the tabs also count the held items (3rd argument).
    [view.includes('data-testid="actions-not-checked-row"'), view.includes("tabCounts(openRows, unchecked, held)"), view.includes("setFilter((f) => tabAfterRangeChange(f, ok.settings.range, r))"), (/function UncheckedRowItem\([\s\S]*?\n}\n/.exec(view)?.[0] ?? "act(").match(/act\(|Add as task|Dismiss|Wrong\?|actOnProposalFn|correctActionFn/)?.[0] ?? null],
    [true, true, true, null],
  );
  const pipe = readFileSync(new URL("../src/features/huddle/lib/actions/pipeline.ts", import.meta.url), "utf8");
  t("U-14 the heartbeat backlog sizing is NOT on this branch (another branch owns AI-call volume)", ["heartbeatPassShape", "HEARTBEAT_BACKLOG_PER_PASS", "CATCHUP_", "catchUpStopReason", "catchUpContinue"].filter((n) => pipe.includes(n)), []);
}

// ── AI. APP AND WORKSPACE INVITATIONS (owner-approved option A, 2026-11-17; BUILD-actions-app-invite.md) ──────────
// THE SPELLING TABLE. Synthetic subjects / bodies only. Tests cannot call the model, so each row carries the answer
// the changed instructions ask for (category + open / none + a verbatim quote) and runs it through the REAL
// admission guard (admitActionVerdict) and the REAL selection (selectActionItems) at default settings.
//   expect: "gone"   = never shown (status none: no row, not counted hidden)
//           "hidden" = admitted, hidden by a default What-shows switch, counted in hidden.categories[cat]
//           "listed" = shown as a row
{
  type Spell = { id: string; source: "email" | "teams"; subject: string; body: string; open: boolean; kind: "reply" | "action" | "both" | "none"; category: string; quote: string | null; expect: "gone" | "hidden" | "listed" };
  const P = (id: string, subject: string, body: string, category = "app_invite", source: "email" | "teams" = "email"): Spell => ({ id, source, subject, body, open: false, kind: "none", category, quote: null, expect: "gone" });
  const TEAM_COPY = (n: number) => P(`P3-copy-${n}`, "Pat Example has invited you to join the team Synthetic Squad", `Pat Example has invited you to join the team Synthetic Squad in Example Design. Open the app to accept. (${n})`);
  const TABLE: Spell[] = [
    // ── Positives: the owner's six shapes. Per the new instructions an app_invite has NO open item.
    P("P1-new-org", "Check out your new organization", "Welcome! Check out your new organization, Synthetic Studio, in Example Design."),
    P("P2-access-org", "You can access organization Example Org", "You can now access organization Example Org. Sign in to Example Design to get started."),
    TEAM_COPY(1), TEAM_COPY(2), TEAM_COPY(3), TEAM_COPY(4), TEAM_COPY(5),
    P("P4-devops", "You've been invited to Example DevOps", "You've been invited to Example DevOps by an administrator. Join the project to see its boards."),
    P("P5-sheet", "Pat Example has invited you to edit the following spreadsheet", "Pat Example has invited you to edit the following spreadsheet: Synthetic Budget. Open in Example Docs."),
    P("P5-teams-bot", "Teams", "Example Design bot: you were added to the workspace Synthetic Squad.", "app_invite", "teams"),
    // A workflow mailer's approval request about SOMEONE ELSE's timecard: timekeeping, hidden by the existing switch
    // even when the model calls it an action.
    { id: "P6-timecard", source: "email", subject: "Timecard approval needed", body: "Please click one of the following choices to approve the timecard for Sam Example for the week ending Friday.", open: true, kind: "action", category: "timekeeping", quote: "Please click one of the following choices to approve the timecard for Sam Example", expect: "hidden" },
    // Travel-security poll: governed by the EXISTING "mail from systems has no open item" rule (automated_notice).
    P("P7-poll", "Travel safety check", "Are you safe? Please select from the responses below so the travel desk knows your status.", "automated_notice"),
    // ── Negatives that MUST stay visible.
    { id: "N1-deliverable", source: "email", subject: "Budget deck", body: "Hi, could you send me the synthetic budget deck by Friday? Thanks.", open: true, kind: "both", category: "person_request", quote: "could you send me the synthetic budget deck by Friday?", expect: "listed" },
    { id: "N2-training", source: "email", subject: "Required: annual security training", body: "All staff must complete the annual security awareness training by December 1.", open: true, kind: "action", category: "automated_notice", quote: "All staff must complete the annual security awareness training by December 1.", expect: "listed" },
    { id: "N3-payroll", source: "email", subject: "Register for payroll self-service", body: "Please register for the payroll self-service portal by Friday to receive your pay statements.", open: true, kind: "action", category: "automated_notice", quote: "Please register for the payroll self-service portal by Friday", expect: "listed" },
    { id: "N3b-password-manager", source: "email", subject: "Set up your company password manager", body: "Your employer requires every employee to finish setting up the company password manager account by Monday.", open: true, kind: "action", category: "automated_notice", quote: "finish setting up the company password manager account by Monday", expect: "listed" },
    { id: "N4-manager", source: "email", subject: "Onboarding plan", body: "Please review the synthetic onboarding plan and send me your comments by Wednesday.", open: true, kind: "both", category: "person_request", quote: "Please review the synthetic onboarding plan and send me your comments by Wednesday.", expect: "listed" },
    // ── Over-match negative: a PERSON's own email that mentions an invite in passing stays a person_request.
    { id: "O1-passing", source: "email", subject: "Yesterday", body: "Thanks for joining the call yesterday. I sent the workspace invite to the new hire as well. Can you share your notes from the session?", open: true, kind: "reply", category: "person_request", quote: "Can you share your notes from the session?", expect: "listed" },
    { id: "O2-passing-teams", source: "teams", subject: "Teams", body: "I invited the whole team to the shared folder last week. Could you check the synthetic draft before Thursday?", open: true, kind: "both", category: "person_request", quote: "Could you check the synthetic draft before Thursday?", expect: "listed" },
  ];
  const verdictFor = (r: Spell) => admitActionVerdict({ open_item: r.open, kind: r.kind, todo: r.open ? "Synthetic to-do" : null, due: null, quote: r.quote, confidence: "high", reason: "Synthetic.", category: r.category }, [r.body], { key: `${r.id}|1`, settled: false, nowIso: NOW, inputVersion: CLASSIFIER_INPUT_VERSION[r.source] });
  const candFor = (r: Spell, over: Partial<{ open: boolean; kind: Spell["kind"]; quote: string | null }> = {}): ActionCandidate => {
    const v = verdictFor({ ...r, ...over });
    return cand({ source: r.source, status: v.status, category: v.category, kind: v.kind, section: v.status === "open" ? actionSectionFor(r.source, v.kind, "direct") : null, itemKey: v.key, proposalId: v.status === "open" ? `prop-${r.id}` : null, display: { ...disp, title: r.id } });
  };
  const outcome = (sel: ReturnType<typeof selectActionItems>, id: string, cat: string | null) =>
    sel.rows.some((x) => x.title === id) ? "listed" : sel.unchecked.some((x) => x.title === id) ? "unchecked" : sel.answered.some((x) => x.title === id) ? "answered" : cat && (sel.hidden.categories as Record<string, number>)[cat] ? "hidden" : "gone";
  for (const r of TABLE) {
    const v = verdictFor(r);
    t(`AI-T ${r.id}: model answer ${r.category}/${r.open ? r.kind : "none"} is admitted (never bad_shape) and ends ${r.expect}`, [v.category, v.notCheckedReason ?? null, outcome(selectActionItems([candFor(r)], S()), r.id, r.category)], [r.category, null, r.expect]);
  }
  // Belt and braces: even when the model (wrongly) still calls an app invite an open item, the default switch hides
  // it and counts it. The five near-identical team invites count 5.
  const appRows = TABLE.filter((r) => r.category === "app_invite");
  const driftCands = appRows.map((r) => candFor(r, { open: true, kind: "action", quote: r.body.slice(0, 40) }));
  const drift = selectActionItems(driftCands, S());
  t("AI-1 GUARD: app_invite is a hideable category, labelled for What shows", [HIDEABLE_CATEGORIES.includes("app_invite"), HIDEABLE_CATEGORY_LABEL.app_invite], [true, "App and workspace invitations"]);
  t("AI-2 GUARD: hidden by DEFAULT -- an app invite the model still marked open is never a row, and is counted hidden", [drift.rows.length, drift.counts.all, drift.hidden.categories.app_invite, drift.hidden.total], [0, 0, appRows.length, appRows.length]);
  t("AI-3 the five near-identical team invites are each counted (5), never silently dropped", selectActionItems(driftCands.filter((c) => c.display.title.startsWith("P3-copy")), S()).hidden.categories.app_invite, 5);
  const on = selectActionItems(driftCands, S({ hideCategories: ["meeting_invite", "timekeeping", "verification_code"] }));
  t("AI-4 the switch: turning it off in What shows lists them at once (no re-judge), hidden count 0", [on.rows.length, on.hidden.categories.app_invite ?? 0], [appRows.length, 0]);
  const notChecked = selectActionItems([cand({ status: "not_checked", category: "app_invite", proposalId: null, section: null, itemKey: "nc|1" })], S());
  t("AI-5 a not-checked item already labelled app_invite is hidden by the same switch (counted, not listed)", [notChecked.unchecked.length, notChecked.hidden.categories.app_invite], [0, 1]);
  // Stored settings: a list saved BEFORE app_invite existed takes the new default (hidden); one saved after keeps the
  // owner's choice; a round trip through resolve keeps it.
  const legacy = resolveActionsSettings({ hideCategories: ["meeting_invite", "timekeeping", "verification_code"], dailyCap: 300 });
  const chosen = resolveActionsSettings({ ...legacy, hideCategories: legacy.hideCategories.filter((c) => c !== "app_invite") });
  t("AI-6 GUARD: settings saved before app_invite existed hide it by default (and keep the rest of the saved choice)", [legacy.hideCategories.includes("app_invite"), legacy.dailyCap, legacy.knownHideCategories.length], [true, 300, HIDEABLE_CATEGORIES.length]);
  t("AI-7 GUARD: the owner switching it ON (unhidden) after it existed is kept, also across a second save", [chosen.hideCategories.includes("app_invite"), resolveActionsSettings(chosen).hideCategories.includes("app_invite"), resolveActionsSettings(JSON.parse(JSON.stringify(chosen))).hideCategories], [false, false, ["meeting_invite", "timekeeping", "verification_code"]]);
  t("AI-8 an old saved list that had switched timekeeping OFF stays off; only the NEW category takes its default", resolveActionsSettings({ hideCategories: ["meeting_invite"] }).hideCategories, ["meeting_invite", "app_invite"]);
  // The instruction text: app_invite defined in every block; the step-2 contradiction gone; the courtesy rule kept.
  t("AI-9 GUARD: app_invite is in the strict schema enum (else every app_invite answer is bad_shape)", (ACTION_SCHEMA.properties.category.enum as readonly string[]).includes("app_invite"), true);
  t("AI-10 GUARD: app_invite defined in step 2, step 3 and Teams; employer-required accounts excluded in each", [STEP2_INSTRUCTIONS, STEP3_INSTRUCTIONS, TEAMS_INSTRUCTIONS].map((x) => [x.includes("app_invite (an app or platform notifying him"), x.includes("his EMPLOYER requires is automated_notice, never app_invite")]), [[true, true], [true, true], [true, true]]);
  t("AI-11 GUARD: step 2 no longer makes an invited account an open item; an EMPLOYER-required one still is", [STEP2_INSTRUCTIONS.includes("setting up an account or access he was invited to"), STEP2_INSTRUCTIONS.includes("access his EMPLOYER requires (payroll self-service, the company password manager, required training, a performance review)"), STEP2_INSTRUCTIONS.includes("(category app_invite) has no open item")], [false, true, true]);
  t("AI-15 GUARD: a share notice carrying the person's OWN request is never app_invite (email category, step 2, Teams)", [...[STEP2_INSTRUCTIONS, STEP3_INSTRUCTIONS, TEAMS_INSTRUCTIONS].map((x) => x.includes("sharing person's OWN note asking him to do")), STEP2_INSTRUCTIONS.includes("is shared_with_you or person_request with that open item")], [true, true, true, true]);
  t("AI-12 the PERSON courtesy-reply rule is kept in step 2", [STEP2_INSTRUCTIONS.includes("A REPLY IS AN OPEN ITEM EVEN WITH NO TASK: when a PERSON (not a system) writes to him personally"), STEP2_INSTRUCTIONS.includes("a PERSON writing to him personally is still owed the courteous reply above")], [true, true]);
  t("AI-13 someone else's timecard approval is timekeeping, in the email and the Teams blocks", [STEP2_INSTRUCTIONS.includes("approval requests about someone else's timecard or timesheet"), TEAMS_INSTRUCTIONS.includes("approval requests about someone else's timecard or timesheet")], [true, true]);
  // The version bump forces a re-judge: verdicts stored at the old versions are not "judged", the new ones are.
  const store = new Map<string, ActionVerdict>([
    ["email\u0000old-none", { ...verdictFor(TABLE[0]), key: "e-old|1", inputVersion: undefined }],
    ["email\u0000old-1", { ...verdictFor(TABLE[0]), key: "e-v1|1", inputVersion: 1 }],
    ["teams\u0000old-2", { ...verdictFor(TABLE[0]), key: "t-v2|1", inputVersion: 2 }],
    ["email\u0000cur", { ...verdictFor(TABLE[0]), key: "e-cur|1" }],
    ["teams\u0000cur", { ...verdictFor(TABLE[0]), key: "t-cur|1", inputVersion: CLASSIFIER_INPUT_VERSION.teams }],
  ]);
  t("AI-14 GUARD: the version bump forces a re-judge (email < 2, teams < 3 are not current; the new versions are)", [CLASSIFIER_INPUT_VERSION, [...currentlyJudgedKeys(store)].sort()], [{ email: 2, teams: 3 }, ["e-cur|1", "t-cur|1"]]);
}

// ── F4 (AC-actions-safety-and-invites): "Names that are you" -- the owner's other name / account is the OWNER ─────
// Synthetic owner "Sam Okafor" (configured) whose second Teams account shows "Samuel Okafor". "Sam Rivera" is a
// made-up namesake sharing only the first name.
{
  const { ownerTeamsIdsAcross, teamsChatsFromLedger, foldPersonName } = await import("../src/features/huddle/lib/correspondence/report-from-ledger");
  const { ownerFullNames } = await import("../src/features/huddle/lib/correspondence/needs-you");
  const { cleanOwnNames, OWN_NAMES_MAX, OWN_NAME_CHARS, OWN_NAMES_NOTE } = await import("../src/features/huddle/lib/actions/actions");
  const A = "@";
  const C1 = `19:f4a_one${A}unq.gbl.spaces`;
  const C2 = `19:f4b_two${A}unq.gbl.spaces`;
  const C3 = `19:f4c_three${A}unq.gbl.spaces`;
  const ID_A = "f4-main-account";
  const ID_B = "f4-second-account";
  const tm = (o: Partial<TeamsContent>): LedgerReportRow => {
    const c: TeamsContent = { kind: "teams", chatId: C3, chatName: null, messageId: "1", at: "2026-11-16T15:00:00Z", sender: { id: "f4-pat", name: "Pat Example", isApp: false }, fromOwner: null, text: "Synthetic text", webUrl: null, mentionedUserIds: [], ...o };
    return { source: "teams", sourceItemId: teamsSourceItemId(c.chatId, c.messageId), threadId: c.chatId, at: c.at, content: c };
  };
  // The main account's id is known from 2+ chats (loop-2 D-4), so ids WERE found before any name is consulted.
  const known = [
    tm({ chatId: C1, messageId: "a1", at: "2026-11-12T10:00:00Z", sender: { id: ID_A, name: "Sam Okafor", isApp: false }, ownerUserId: ID_A }),
    tm({ chatId: C2, messageId: "a2", at: "2026-11-12T11:00:00Z", sender: { id: ID_A, name: "Sam Okafor", isApp: false }, ownerUserId: ID_A }),
  ];
  const ask = tm({ messageId: "p1", at: "2026-11-16T12:00:00Z", text: "Synthetic: can you send the deck?" });
  const second = tm({ messageId: "b1", at: "2026-11-16T12:30:00Z", sender: { id: ID_B, name: "Samuel Okafor", isApp: false }, text: "Synthetic: on it, sending today." });
  const rows = [...known, ask, second];
  const speakers = (rs: LedgerReportRow[], names: string[]) => teamsChatsFromLedger(rs, [], names).find((c) => c.chatId === C3)!.messages.map((m) => m.speaker);
  t("F4-1 GUARD: main id known (2+ chats) AND ownNames ['Samuel Okafor'] -> the result holds BOTH ids, and id-B's message is OWNER", [ownerTeamsIdsAcross(rows, [], ["Samuel Okafor"]).sort(), speakers(rows, ["Samuel Okafor"])], [[ID_A, ID_B].sort(), ["OTHER", "OWNER"]]);
  t("F4-2 GUARD: a saved EMPTY list is respected (not re-seeded): resolve keeps [], and id-B stays OTHER", [resolveActionsSettings({ ownNames: [] }, ["Samuel Okafor"]).ownNames, ownerTeamsIdsAcross(rows, [], resolveActionsSettings({ ownNames: [] }, ["Samuel Okafor"]).ownNames), speakers(rows, resolveActionsSettings({ ownNames: [] }, ["Samuel Okafor"]).ownNames)], [[], [ID_A], ["OTHER", "OTHER"]]);
  const cfgF4 = (names: string[], login = "sokafor@huddle.example") =>
    ({ mailbox: "sokafor@work.example", ownerLogins: [login], correspondence: { ownerNames: names } }) as Parameters<typeof ownerFullNames>[0];
  t(
    "F4-3 seed: no stored field -> ownNames = configured full names; config 'Sam' only + login sokafor@ -> []",
    [resolveActionsSettings({ dailyCap: 9 }, ownerFullNames(cfgF4(["Sam Okafor", "Samuel Okafor"]))).ownNames, resolveActionsSettings(null, ownerFullNames(cfgF4(["Sam"]))).ownNames, resolveActionsSettings({}, ["Sam Okafor"]).ownNames],
    [["Sam Okafor", "Samuel Okafor"], [], ["Sam Okafor"]],
  );
  const rivera = tm({ messageId: "r1", at: "2026-11-16T12:45:00Z", sender: { id: "f4-rivera", name: "Sam Rivera", isApp: false }, text: "Synthetic: can you review this?" });
  // Mutation-proof note: "Sam Rivera" alone cannot prove the 2-word rule (it never folds equal to "sam"); a sender whose
  // Teams display name is only "Sam" is the case the rule protects.
  const bareSam = tm({ messageId: "r2", at: "2026-11-16T12:50:00Z", sender: { id: "f4-bare", name: "Sam", isApp: false }, text: "Synthetic: can you look at this?" });
  t("F4-4 GUARD: namesakes are OTHER even with ['Sam Okafor','Sam'] listed: 'Sam Rivera' (first name only shared) and a sender shown only as 'Sam' (one-word names never match)", [speakers([...known, ask, rivera, bareSam], ["Sam Okafor", "Sam"]), ownerTeamsIdsAcross([...known, ask, rivera, bareSam], [], ["Sam Okafor", "Sam"])], [["OTHER", "OTHER", "OTHER"], [ID_A]]);
  const commaB = tm({ messageId: "b2", at: "2026-11-16T12:30:00Z", sender: { id: ID_B, name: "Okafor, Samuel", isApp: false } });
  t("F4-5 'Okafor, Samuel' against ['Samuel Okafor'] is the OWNER (Last, First fold)", speakers([...known, ask, commaB], ["Samuel Okafor"]), ["OTHER", "OWNER"]);
  const appB = tm({ messageId: "b3", at: "2026-11-16T12:30:00Z", sender: { id: "f4-app", name: "Samuel Okafor", isApp: true } });
  t("F4-6 an app sender named 'Samuel Okafor' is never added", [ownerTeamsIdsAcross([...known, ask, appB], [], ["Samuel Okafor"]), speakers([...known, ask, appB], ["Samuel Okafor"])], [[ID_A], ["OTHER", "OTHER"]]);
  // F4-7: the only message after the latest true OTHER message is from id-B -> settled (the owner wrote after it).
  const chatSettled = teamsChatsFromLedger(rows, [], ["Samuel Okafor"]).find((c) => c.chatId === C3)!;
  const chatUnsettled = teamsChatsFromLedger(rows, [], []).find((c) => c.chatId === C3)!;
  const vSettled = admitActionVerdict({ open_item: false, kind: "none", todo: null, due: null, quote: null, confidence: "high", reason: "Answered by your reply", category: "person_request" }, teamsQuoteHaystack(chatSettled), { key: "f4|b1", settled: chatSettled.settled, nowIso: NOW });
  t("F4-7 settled: id-B wrote after the latest OTHER -> settled true, latest OTHER is the real other person, answered by reply (no 'Reply to <his name>' item)", [chatSettled.settled, chatSettled.latestOther?.id, chatUnsettled.settled, chatUnsettled.latestOther?.id, vSettled.status, vSettled.answeredByReply], [true, ask.sourceItemId, false, second.sourceItemId, "none", true]);
  const many = Array.from({ length: 12 }, (_, i) => `Synthetic Name${String.fromCharCode(65 + i)} Example`);
  const resolved = resolveActionsSettings({ ownNames: [...many, "x".repeat(120) + " Long", "   ", "", "sam okafor", "Sam  Okafor", 7, null] }).ownNames;
  t("F4-8 bounds: at most 10, each trimmed to 80, no blanks, no duplicates by folded form", [resolved.length, resolved.every((n) => n.length <= OWN_NAME_CHARS && !!n.trim()), OWN_NAMES_MAX, cleanOwnNames(["sam okafor", "Sam  Okafor", "Okafor, Sam", " ", "Pat Example"]), cleanOwnNames(["y".repeat(120)])[0].length], [10, true, 10, ["sam okafor", "Pat Example"], 80]);
  // F4-9 / X-6: ONE resolver. All three passes (heartbeat, page read, report) hand the resolved s.ownNames to the ONE
  // assembly, which uses it for Teams identity AND the model's owner-name context.
  const { readFileSync } = await import("node:fs");
  const srvF4 = readFileSync(new URL("../src/features/huddle/lib/actions/actions.server.ts", import.meta.url), "utf8");
  const cfgSam = parseFeedsConfig(JSON.stringify({ enabled: true, synthetic: false, driveUser: "sokafor@work.example", mailbox: "sokafor@work.example", ownerLogins: ["sokafor@huddle.example"], teams: {}, correspondence: { ownerNames: ["Sam Okafor"] } }))!;
  const asmSeed = assembleLedgerPlan({ rows, proposals: [], bell: [] }, cfgSam, Date.parse("2026-11-09T05:00:00Z"));
  const asmOwn = assembleLedgerPlan({ rows, proposals: [], bell: [] }, cfgSam, Date.parse("2026-11-09T05:00:00Z"), ["Sam Okafor", "Samuel Okafor"]);
  const spk = (a: typeof asmOwn) => a.plan.teams.scan.concat(a.plan.teams.resolved.map((r) => r.c)).find((c) => c.chatId === C3)?.messages.map((m) => m.speaker) ?? null;
  t(
    "F4-9 GUARD (X-6): heartbeat, page read, report (and the F5 held action) all pass s.ownNames into assembleLedgerPlan; with it id-B is OWNER, the seed alone keeps it OTHER; names reach the model context",
    [
      (srvF4.match(/assembleLedgerPlan\(data, cfg, .*, s\.ownNames\);/g) ?? []).length,
      (srvF4.match(/assembleLedgerPlan\(/g) ?? []).length,
      spk(asmSeed),
      spk(asmOwn),
      asmOwn.ctx.ownerNames.includes("Samuel Okafor"),
      asmOwn.ctx.ownerFullNames,
      asmSeed.ctx.ownerFullNames,
    ],
    [4, 4, ["OTHER", "OTHER"], ["OTHER", "OWNER"], true, ["Sam Okafor", "Samuel Okafor"], ["Sam Okafor"]],
  );
  const viewF4 = readFileSync(new URL("../src/features/huddle/components/ActionsView.tsx", import.meta.url), "utf8");
  t("F4-10 / F4-13 the What shows panel has the 'Names that are you' field (resolved list, saved through onChange) and says when it applies", [viewF4.includes("Names that are you"), viewF4.includes('data-testid="actions-own-names"'), viewF4.includes("defaultValue={settings.ownNames.join(\"\\n\")}"), viewF4.includes("onChange({ ...settings, ownNames: next })"), viewF4.includes("{OWN_NAMES_NOTE}"), OWN_NAMES_NOTE], [true, true, true, true, true, "Applies to new messages and the next re-check."]);
  // F4 spelling table S4-1..S4-16 (sender display-name spellings against ownNames ["Samuel Okafor", "Sam Okafor"]).
  const OWN = ["Samuel Okafor", "Sam Okafor"];
  const S4: [string, string, unknown, boolean, "OWNER" | "OTHER"][] = [
    ["S4-1", "exact", "Samuel Okafor", false, "OWNER"],
    ["S4-2", "case + spaces", "samuel  OKAFOR", false, "OWNER"],
    ["S4-3", "Last, First", "Okafor, Samuel", false, "OWNER"],
    ["S4-4", "trim", " Sam Okafor ", false, "OWNER"],
    ["S4-5", "bare first name", "Sam", false, "OTHER"],
    ["S4-6", "bare first name", "Samuel", false, "OTHER"],
    ["S4-7", "first-name namesake", "Sam Rivera", false, "OTHER"],
    ["S4-8", "prefix", "Samuel Okafor-Diaz", false, "OTHER"],
    ["S4-9", "middle initial not folded", "Samuel J. Okafor", false, "OTHER"],
    ["S4-10", "suffix not stripped", "Samuel Okafor (External)", false, "OTHER"],
    ["S4-11", "no comma, no swap", "Okafor Samuel", false, "OTHER"],
    ["S4-12", "accents not stripped", "Sámuel Okafor", false, "OTHER"],
    ["S4-13", "two commas", "Okafor, Samuel, Jr", false, "OTHER"],
    ["S4-14", "app sender", "Samuel Okafor", true, "OTHER"],
    ["S4-15", "exact full-name namesake (accepted risk)", "Samuel Okafor", false, "OWNER"],
    ["S4-16", "empty / missing name", "", false, "OTHER"],
  ];
  const s4got: string[] = [];
  const s4want: string[] = [];
  for (const [id, , name, isApp] of S4) {
    const r = tm({ messageId: `s4-${id}`, at: "2026-11-16T12:30:00Z", sender: { id: `f4-${id.toLowerCase()}`, name: name as string, isApp } });
    s4got.push(`${id}:${speakers([...known, ask, r], OWN)[1]}`);
  }
  for (const [id, , , , want] of S4) s4want.push(`${id}:${want}`);
  const missingName = tm({ messageId: "s4-missing", at: "2026-11-16T12:30:00Z", sender: { id: "f4-missing", isApp: false } as never });
  t("F4 spelling table S4-1..S4-16 (Teams sender names vs ['Samuel Okafor','Sam Okafor'])", [s4got, speakers([...known, ask, missingName], OWN)[1], foldPersonName("Okafor, Samuel, Jr")], [s4want, "OTHER", "okafor, samuel, jr"]);
}

// ── F5 (AC-actions-safety-and-invites): items HELD by the safety check, their own group, Add as task / Dismiss ──────
{
  const { HELD_REASON_TEXT, HELD_GROUP_LABEL, HELD_QUOTE_LABEL, isHeldCandidate } = await import("../src/features/huddle/lib/actions/actions");
  const { actOnHeldItem, heldProposalCandidates, isHeldVerdict, HELD_ACTION_ERROR } = await import("../src/features/huddle/lib/actions/pipeline");
  const held = (o: Partial<ActionCandidate> = {}) => cand({ status: "not_checked", notCheckedReason: "quote_not_found", proposalId: null, proposalState: null, section: "todo", kind: "action", itemKey: "h|1", display: { ...disp, title: "Test-Send the weekly notes", quote: "Test-invented quote", reasonLine: "Model text that must not be the held reason." }, ...o });
  const sel1 = selectActionItems([held()], S());
  t("F5-1 GUARD: a current quote_not_found verdict is HELD: in held (1), not unchecked, not rows; heldCounts.all 1", [sel1.held.length, sel1.unchecked.length, sel1.rows.length, sel1.heldCounts.all, sel1.notChecked], [1, 0, 0, 1, 0]);
  const sel2 = selectActionItems([held({ notCheckedReason: "bad_shape", itemKey: "b|1" }), cand({ status: "not_checked", proposalId: null, section: null, itemKey: "n|1" })], S());
  t("F5-2 GUARD: bad_shape and never-judged stay in unchecked, never held", [sel2.held.length, sel2.unchecked.map((r) => r.itemKey).sort(), isHeldCandidate({ status: "not_checked", notCheckedReason: "bad_shape" }), isHeldCandidate({ status: "open", notCheckedReason: "quote_not_found" })], [0, ["b|1", "n|1"], false, false]);
  const inv = held({ category: "meeting_invite", itemKey: "mi|1" });
  const hid = selectActionItems([inv], S());
  const shown = selectActionItems([inv], S({ hideCategories: [] }));
  const teamsOff = selectActionItems([held({ source: "teams", itemKey: "t|1" })], S({ sources: { email: true, teams: false, meeting: true } }));
  t("F5-9 the What-shows switches apply to held items: meeting_invite hidden by default (counted), shown when switched off; a source switch hides too", [hid.held.length, hid.hidden.categories.meeting_invite, shown.held.length, teamsOff.held.length, teamsOff.hidden.sources], [0, 1, 1, 0, 1]);
  const mix = [
    cand({ itemKey: "o|1" }),
    cand({ itemKey: "o|2" }),
    held({ source: "teams", itemKey: "h|t" }),
    cand({ status: "not_checked", proposalId: null, section: null, itemKey: "n|1" }),
    cand({ status: "not_checked", proposalId: null, section: null, itemKey: "n|2" }),
    cand({ status: "not_checked", proposalId: null, section: null, itemKey: "n|3" }),
  ];
  const selM = selectActionItems(mix, S());
  t("F5-10 GUARD: tabs count open + held + not-checked (All 6, Email 5, Teams 1); notChecked === unchecked.length and excludes held", [tabCounts(selM.rows, selM.unchecked, selM.held), selM.notChecked, selM.unchecked.length, selM.heldCounts], [{ all: 6, email: 5, teams: 1, meeting: 0 }, 3, 3, { all: 1, email: 0, teams: 1, meeting: 0 }]);
  t("F5-11 the Teams tab lists only Teams held items", filterRows(selectActionItems([held({ itemKey: "he|1" }), held({ source: "teams", itemKey: "ht|1" })], S()).held, "teams").map((r) => r.itemKey), ["ht|1"]);
  t("F5-12 the held reason is the FIXED code sentence, never the model's reason", [sel1.held[0].heldReason, sel1.held[0].heldReason === sel1.held[0].reasonLine, HELD_REASON_TEXT.quote_not_found], [HELD_REASON_TEXT.quote_not_found, false, "Held back: the AI's supporting quote didn't match the message word for word, so it wasn't added automatically."]);
  const decided = selectActionItems([held({ proposalId: "prop-aa01", proposalState: "approved", itemKey: "d|1" }), held({ proposalId: "prop-aa02", proposalState: "dismissed", itemKey: "d|2" }), held({ onBoard: true, itemKey: "d|3" }), held({ proposalId: "prop-aa03", proposalState: "proposed", itemKey: "d|4" })], S());
  t("F5-5/F5-8 selection: a held item whose rescue proposal was decided (approved / dismissed) or is on the board is gone; one still 'proposed' stays held with that id", [decided.held.map((r) => [r.itemKey, r.id]), decided.unchecked.length, decided.rows.length], [[["d|4", "prop-aa03"]], 0, 0]);

  // The rescue path through the real plan (a synthetic 1:1 Teams chat) with an in-memory thread store.
  const HC = `19:f5_held${"@"}unq.gbl.spaces`;
  const ASKH = "Hi Sam. Here is the outline of topics I want from you each week. Please send your first notes by Monday.";
  const hRow: LedgerReportRow = { source: "teams", sourceItemId: teamsSourceItemId(HC, "1"), threadId: HC, at: "2026-11-16T12:00:00Z", content: { kind: "teams", chatId: HC, chatName: null, messageId: "1", at: "2026-11-16T12:00:00Z", sender: { id: "f5-pat", name: "Pat Example", isApp: false }, fromOwner: false, text: ASKH, webUrl: null, mentionedUserIds: [], ownerUserId: "f5-owner" } as TeamsContent };
  const hAsm = assembleLedgerPlan({ rows: [hRow], proposals: [], bell: [] }, cfg, SINCE);
  const hU = threadUnits(hAsm, S()).units.find((x) => x.teams?.chatId === HC)!;
  const heldV = admitActionVerdict({ open_item: true, kind: "action", todo: "Test-Send your first notes by Monday", due: "Monday", quote: "Please send your weekly notes by Monday", confidence: "high", reason: "Asked.", category: "person_request" }, teamsQuoteHaystack(hU.teams!), { key: hU.itemKey, settled: false, nowIso: NOW, inputVersion: CLASSIFIER_INPUT_VERSION.teams });
  t("F5 setup: the paraphrased quote is HELD (not_checked / quote_not_found) and isHeldVerdict says so", [heldV.status, heldV.notCheckedReason, isHeldVerdict(heldV, hU)], ["not_checked", "quote_not_found", true]);
  const storeKey = `${hU.storeAt.source}\u0000${hU.storeAt.sourceItemId}`;
  const mkWorld = (opts: { proposeThrows?: boolean; actFails?: boolean } = {}) => {
    const store = new Map<string, ActionVerdict>([[storeKey, { ...heldV }]]);
    const proposals = new Map<string, { id: string; state: string; title: string; assignee: null; correction: null }>();
    const calls = { propose: 0, act: [] as string[] };
    let chain = Promise.resolve();
    const deps = {
      lockThread: <T,>(u: typeof hU, fn: (tx: { current(): Promise<ActionVerdict | null>; store(v: ActionVerdict): Promise<void> }) => Promise<T>): Promise<T> => {
        const k = `${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`;
        const run = chain.then(async () => {
          const snapshot = store.get(k) ?? null;
          let pending: ActionVerdict | null = null;
          const out = await fn({ current: async () => store.get(k) ?? null, store: async (v) => void (pending = v) });
          if (pending) store.set(k, pending); // commit only when fn returned (a throw rolls back)
          void snapshot;
          return out;
        });
        chain = run.then(() => undefined, () => undefined);
        return run;
      },
      propose: async (_u: typeof hU, cands: readonly { task: string; evidence: string }[], text: string) => {
        calls.propose++;
        if (opts.proposeThrows) throw new Error("proposals:store_failed");
        if (!cands.length || !cands.every((c) => text.includes(c.evidence))) return { id: null, onBoard: false };
        const id = "prop-f5000001";
        proposals.set(id, { id, state: "proposed", title: cands[0].task, assignee: null, correction: null });
        return { id, onBoard: false };
      },
      act: async (id: string, action: "approve" | "dismiss") => {
        calls.act.push(`${action}:${id}`);
        if (opts.actFails) return { ok: false, error: "Couldn't add that task to your board." };
        const p = proposals.get(id);
        if (p) p.state = action === "approve" ? "approved" : "dismissed";
        return { ok: true };
      },
    };
    const page = () => selectActionItems(buildCandidates({ assembled: hAsm, rows: [hRow], settings: S(), verdicts: store, proposals, meetingProposals: [], replies: [], isDraftable: () => false }).candidates, S());
    return { store, proposals, calls, deps, page };
  };
  const w = mkWorld();
  const before = w.page();
  const add = await actOnHeldItem(hU, "approve", w.deps);
  const after = w.page();
  t(
    "F5-5 GUARD: Add as task -> ONE proposal via propose, approved via act, its id written back on the stored verdict (still not_checked); next read: in none of held / unchecked / rows",
    [before.held.length, add.ok, w.calls.propose, w.calls.act, w.store.get(storeKey)?.proposalId, w.store.get(storeKey)?.status, w.store.get(storeKey)?.notCheckedReason, after.held.length, after.unchecked.length, after.rows.length],
    [1, true, 1, ["approve:prop-f5000001"], "prop-f5000001", "not_checked", "quote_not_found", 0, 0, 0],
  );
  const wd = mkWorld();
  const dis = await actOnHeldItem(hU, "dismiss", wd.deps);
  t("F5-6 Dismiss -> a proposal is created and dismissed; the item is gone on the next read", [dis.ok, wd.calls.act, wd.proposals.get("prop-f5000001")?.state, wd.page().held.length], [true, ["dismiss:prop-f5000001"], "dismissed", 0]);
  const wc = mkWorld();
  const [c1, c2] = await Promise.all([actOnHeldItem(hU, "approve", wc.deps), actOnHeldItem(hU, "approve", wc.deps)]);
  t("F5-7 a double click (two at once): ONE propose, the second click re-uses the first proposal's id", [c1.ok, c2.ok, wc.calls.propose, c1.ok && c2.ok && c1.proposalId === c2.proposalId, wc.proposals.size], [true, true, 1, true, 1]);
  const wt = mkWorld({ proposeThrows: true });
  const thr = await actOnHeldItem(hU, "approve", wt.deps);
  t("F5-8 propose fails -> plain error, verdict unchanged (no proposalId), item still held", [thr, wt.store.get(storeKey)?.proposalId, wt.page().held.length], [{ ok: false, error: HELD_ACTION_ERROR }, null, 1]);
  const wf = mkWorld({ actFails: true });
  const f1 = await actOnHeldItem(hU, "approve", wf.deps);
  const stillHeld = wf.page().held;
  wf.deps.act = async (id: string, action: "approve" | "dismiss") => {
    wf.calls.act.push(`${action}:${id}`);
    const p = wf.proposals.get(id);
    if (p) p.state = "approved";
    return { ok: true };
  };
  const f2 = await actOnHeldItem(hU, "approve", wf.deps);
  t("F5-8 the action fails after the proposal was created -> row stays held WITH that id; the next click re-uses it (no 2nd propose)", [f1.ok, stillHeld.map((r) => r.id), f2.ok, wf.calls.propose, wf.calls.act, wf.page().held.length], [false, ["prop-f5000001"], true, 1, ["approve:prop-f5000001", "approve:prop-f5000001"], 0]);
  const wn = mkWorld();
  wn.store.set(storeKey, { ...heldV, status: "open", notCheckedReason: undefined, proposalId: null });
  t("F5 a verdict that is not held (open) is refused: no propose, no act", [await actOnHeldItem(hU, "approve", wn.deps), wn.calls.propose, wn.calls.act.length], [{ ok: false, error: "That item isn't in your list." }, 0, 0]);

  // F5-14: re-judged at a new version and now admitted -> open, KEEPS the rescue proposal (runClassify keepId), moves
  // from held to rows, never both.
  const wr = mkWorld({ actFails: true });
  await actOnHeldItem(hU, "approve", wr.deps); // rescue proposal created, still 'proposed'
  wr.store.set(storeKey, { ...wr.store.get(storeKey)!, inputVersion: 1 }); // judged at an OLDER version
  let proposed = 0;
  const rj = await runClassify(hAsm, S(), currentlyJudgedKeys(wr.store), 5, {
    recordCall: async () => {},
    model: async () => ({ open_item: true, kind: "action", todo: "Test-Send your first notes by Monday", due: "Monday", quote: "Please send your first notes by Monday.", confidence: "high", reason: "Asked.", category: "person_request" }),
    propose: async () => (proposed++, { id: "prop-f5ffffff", onBoard: false }),
    storeVerdict: async () => {},
    addMeetingRows: async () => 0,
    nowIso: () => NOW,
    lockThread: wr.deps.lockThread as never,
  });
  const reSel = wr.page();
  t("F5-14 re-judged into open: keeps the rescue proposal (0 new proposals), listed in rows, not in held", [rj.open, proposed, wr.store.get(storeKey)?.status, wr.store.get(storeKey)?.proposalId, reSel.rows.length, reSel.held.length], [1, 0, "open", "prop-f5000001", 1, 0]);

  // X-5 follow-up (coordinator 2026-11-18): part A's re-judge keeps the earlier proposal id WHATEVER the new status, so
  // a not-checked or held verdict can carry a proposal the owner already decided.
  const DECIDED = ["approved", "completed", "dismissed", "delegated", "corrected"];
  const ncWith = (state: string, i: number) => cand({ status: "not_checked", notCheckedReason: "bad_shape", proposalId: `prop-dd0${i}`, proposalState: state, section: null, itemKey: `nc-${state}|1` });
  const selNc = selectActionItems([...DECIDED.map(ncWith), ncWith("proposed", 9)], S());
  const selHd = selectActionItems([...DECIDED.map((st, i) => held({ proposalId: `prop-ee0${i}`, proposalState: st, itemKey: `hd-${st}|1` })), held({ proposalId: "prop-ee09", proposalState: "proposed", itemKey: "hd-proposed|1" })], S());
  t("XF-1 GUARD: a NOT-CHECKED item whose kept proposal the owner already decided (approved/completed/dismissed/delegated/corrected) is not listed; one still 'proposed' is", [selNc.unchecked.map((r) => r.itemKey), selNc.notChecked, selNc.rows.length], [["nc-proposed|1"], 1, 0]);
  t("XF-2 a HELD item whose kept proposal was decided is not listed; one still 'proposed' stays held with that id", [selHd.held.map((r) => [r.itemKey, r.id]), selHd.unchecked.length], [[["hd-proposed|1", "prop-ee09"]], 0]);
  const wrongC = { reason: "not_an_action" as const, text: null, itemKey: "hw|1", at: NOW, withdrawnAt: null };
  const selW = selectActionItems([held({ proposalId: "prop-ff01", proposalState: "proposed", itemKey: "hw|1", correction: wrongC }), cand({ status: "not_checked", proposalId: "prop-ff02", proposalState: "proposed", section: null, itemKey: "nw|1", correction: { ...wrongC, itemKey: "nw|1" } })], S());
  t("XF-3 a Wrong? on the same item version keeps a held / not-checked item in Corrected (with Undo), never listed", [selW.corrected.map((r) => r.itemKey).sort(), selW.held.length, selW.unchecked.length], [["hw|1", "nw|1"], 0, 0]);
  const wk = mkWorld();
  wk.store.set(storeKey, { ...heldV, proposalId: "prop-cafe0001" });
  const kept = await actOnHeldItem(hU, "dismiss", wk.deps);
  t("XF-4 GUARD: a held verdict that already carries a proposal (kept by the re-judge) re-uses it at Add / Dismiss: 0 new proposals, the action runs on that id", [kept, wk.calls.propose, wk.calls.act, wk.store.get(storeKey)?.proposalId], [{ ok: true, proposalId: "prop-cafe0001" }, 0, ["dismiss:prop-cafe0001"], "prop-cafe0001"]);

  const hc = heldProposalCandidates("Test-Send your first notes by Monday", "Please send your weekly notes by Monday", ASKH);
  t("F5 heldProposalCandidates: every evidence is verbatim from the message (never the AI's quote); the to-do first; a grounded fallback sentence last", [hc.every((c) => ASKH.includes(c.evidence)), hc.some((c) => c.evidence.includes("weekly notes")), hc[0].task, hc[hc.length - 1], heldProposalCandidates(null, null, ""), heldProposalCandidates("x", null, null)], [true, false, "Test-Send your first notes by Monday", { task: "Please send your first notes by Monday.", evidence: "Please send your first notes by Monday." }, [], []]);

  const { readFileSync } = await import("node:fs");
  const viewF5 = readFileSync(new URL("../src/features/huddle/components/ActionsView.tsx", import.meta.url), "utf8");
  t(
    "F5-3/F5-4 the view renders the held group expanded (no CollapsibleSection), with the fixed reason, the labelled quote, Add as task and Dismiss, only when non-empty, before Not checked yet",
    [
      viewF5.includes("const heldGroup = held.length ? ("),
      /heldGroup = held\.length \? \(\s*<section/.test(viewF5),
      viewF5.includes("{HELD_GROUP_LABEL}"),
      viewF5.includes("{row.heldReason}"),
      viewF5.includes("{HELD_QUOTE_LABEL}"),
      viewF5.includes('data-testid="actions-held-add"') && viewF5.includes("Add as task"),
      viewF5.includes('data-testid="actions-held-dismiss"'),
      viewF5.indexOf("{heldGroup}") > 0 && viewF5.indexOf("{heldGroup}") < viewF5.lastIndexOf("{notChecked}"),
      viewF5.includes("tabCounts(openRows, unchecked, held)"),
      HELD_GROUP_LABEL,
      HELD_QUOTE_LABEL,
    ],
    [true, true, true, true, true, true, true, true, true, "Held by the safety check", "AI's quote (not found in the message)"],
  );
  const srvF5 = readFileSync(new URL("../src/features/huddle/lib/actions/actions.server.ts", import.meta.url), "utf8");
  const heldFn = srvF5.slice(srvF5.indexOf("export async function actOnHeldItemFor("), srvF5.indexOf("/** X-6: the bell rows"));
  t("F5-13 the held action logs only the action, the source and ok (no to-do, quote, name or id)", [(heldFn.match(/console\.(log|error|warn)\(/g) ?? []).length, heldFn.includes("console.log(`[actions] held ${input.action} source=${u.source} ok=${r.ok}`)")], [1, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
