// WHAT:       Offline tests (synthetic data only) for the Actions-view accuracy fixes of 2026-11-17: the owner's Teams
//             ids are taken across ALL stored rows (sender no longer reversed), the display-name last resort, the
//             settled guard + grounding text, the "AI misread it" Wrong? reason, Fireflies detail lines attached to
//             their item, and one row per Teams ask (+ the group-chat label).
// WHY:        Owner report 2026-11-17 from the live Actions view (sender reversed, hallucinated "you have not
//             replied", no AI-inaccuracy option, label lines as rows, two rows for one ask).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-actions-accuracy.md.
// Run: bun scripts/actions-accuracy.test.ts
//
// THIS REPO IS PUBLIC: every name, id and sentence below is invented.
import {
  admitActionVerdict,
  scrubOwnerStateTodo,
  GROUNDED,
  STEP2_INSTRUCTIONS,
  STEP3_INSTRUCTIONS,
  TEAMS_INSTRUCTIONS,
  teamsQuoteHaystack,
} from "../src/features/huddle/lib/correspondence/action-classify";
import { ownerFullNames } from "../src/features/huddle/lib/correspondence/needs-you";
import { assembleLedgerPlan, foldPersonName, ownerTeamsIdsAcross, teamsChatsFromLedger, type LedgerReportRow } from "../src/features/huddle/lib/correspondence/report-from-ledger";
import { parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { teamsSourceItemId, type TeamsContent } from "../src/features/huddle/lib/correspondence/source-item";
import { CORRECTION_LABEL, CORRECTION_REASONS, makeCorrection, ACTIONS_SETTINGS_DEFAULT, selectActionItems, whatShowsHideReason, type ActionCandidate } from "../src/features/huddle/lib/actions/actions";
import { buildCandidates, collapseDuplicateTeamsItems, currentlyJudgedKeys, runClassify, teamsSourceLabel, threadUnits, verdictIsCurrent, type ClassifyDeps } from "../src/features/huddle/lib/actions/pipeline";
import { CLASSIFIER_INPUT_VERSION, type ActionVerdict } from "../src/features/huddle/lib/correspondence/action-classify";
import { detailLineOf, isMetadataDetail, splitActionItems } from "../src/features/huddle/lib/proposals/meeting-triage";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const AT = "@";
const NOW = "2026-11-17T15:00:00Z";
const OWNER_ID = "owner-guid-0001";
const OTHER_ID = "other-guid-0002";
const MAILBOX = "owner@work.example";
const ONE = `19:a_b${AT}unq.gbl.spaces`;
const ONE2 = `19:c_d${AT}unq.gbl.spaces`;
const GRP = `19:grp${AT}thread.v2`;

const msg = (o: Partial<TeamsContent> = {}): TeamsContent => ({
  kind: "teams",
  chatId: ONE,
  chatName: null,
  messageId: "1",
  at: "2026-11-16T15:00:00Z",
  sender: { id: OTHER_ID, name: "Pat Example", isApp: false },
  fromOwner: null,
  text: "Synthetic text",
  webUrl: null,
  mentionedUserIds: [],
  ...o,
});
const row = (o: Partial<TeamsContent>): LedgerReportRow => {
  const c = msg(o);
  return { source: "teams", sourceItemId: teamsSourceItemId(c.chatId, c.messageId), threadId: c.chatId, at: c.at, content: c };
};

// ── R1. SENDER: owner ids across ALL rows, never per chat ────────────────────────────────────────────
// Live shape (probe 2026-11-17): recent rows carry NO ownerUserId and fromOwner null; the owner id is on OTHER rows.
const older = row({ chatId: ONE2, messageId: "o1", at: "2026-11-10T10:00:00Z", ownerUserId: OWNER_ID, text: "Synthetic older chat" });
// Loop-2 D-4: a row id is taken across chats only when it is on rows of 2+ chats, so the fixture carries the
// owner's id on a second older chat (his own line there, so that chat has nothing to classify).
const ONE3 = `19:e_f${AT}unq.gbl.spaces`;
const older2 = row({ chatId: ONE3, messageId: "o2", at: "2026-11-11T10:00:00Z", sender: { id: OWNER_ID, name: "Example, Owen", isApp: false }, ownerUserId: OWNER_ID, text: "Synthetic older owner line" });
const ask = row({ chatId: ONE, messageId: "q1", at: "2026-11-16T12:00:00Z", text: "Synthetic: can we meet weekly?" });
const own = row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: OWNER_ID, name: "Example, Owen", isApp: false }, text: "Hey, when you're back, please let me know how often you want our synthetic 1:1." });
const chats = teamsChatsFromLedger([older, older2, ask, own]);
const c1 = chats.find((c) => c.chatId === ONE)!;
t(
  "R1-1 GUARD: owner id seen on another chat's row labels the owner's own message OWNER (sender not reversed)",
  [c1.messages.map((m) => m.speaker), c1.latestOther?.id, c1.settled],
  [["OTHER", "OWNER"], ask.sourceItemId, true],
);
t("R1-2 the owner's own sentence is never in the quote haystack", teamsQuoteHaystack(c1).some((s) => s.includes("when you're back")), false);
const ownOnly = teamsChatsFromLedger([older, older2, row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: OWNER_ID, name: "x", isApp: false }, text: "Synthetic owner-only note" })]);
t("R1-3 a chat holding only the owner's message has no latest OTHER (nothing to classify)", ownOnly.find((c) => c.chatId === ONE)!.latestOther, null);
t("R1-4 ownerTeamsIdsAcross: configured + every row's ownerUserId, normalised", ownerTeamsIdsAcross([older, older2, ask], [" CFG-ID "]).sort(), ["cfg-id", OWNER_ID].sort());

// Through the real assembly (config WITHOUT teams.ownerSenderIds, as live), and into the Actions units.
const cfgNoIds = parseFeedsConfig(JSON.stringify({ enabled: true, synthetic: false, driveUser: MAILBOX, mailbox: MAILBOX, ownerLogins: ["owner@huddle.example"], teams: {}, correspondence: { ownerNames: ["Owen Example"] } }))!;
const asm = assembleLedgerPlan({ rows: [older, older2, ask, own], proposals: [], bell: [] }, cfgNoIds, Date.parse("2026-11-09T05:00:00Z"));
const unit = threadUnits(asm, ACTIONS_SETTINGS_DEFAULT).units.find((u) => u.teams?.chatId === ONE);
t("R1-5 end to end (assembleLedgerPlan -> threadUnits): the unit's latest OTHER is the other person's message and it is settled", [unit?.refItemId, unit?.teams?.settled], [ask.sourceItemId, true]);

// Display-name LAST RESORT: only when no id is known anywhere.
const noIdOwn = row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: OWNER_ID, name: "Example, Owen", isApp: false } });
t("R1-6 GUARD: no id anywhere -> a sender named as the owner ('Last, First' folded) contributes its id", teamsChatsFromLedger([ask, noIdOwn], [], ["Owen Example"]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), ["OTHER", "OWNER"]);
t("R1-7 without owner names the same chat stays as stored (no guessing)", teamsChatsFromLedger([ask, noIdOwn]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), ["OTHER", "OTHER"]);
const twin = row({ chatId: ONE, messageId: "q2", at: "2026-11-16T13:00:00Z", sender: { id: "namesake-guid", name: "Owen Example", isApp: false } });
// SUPERSEDED 2026-11-18 by F4 (AC-actions-safety-and-invites, owner-approved): R1-8 used to say "once an id is known, a
// sender with the owner's EXACT full name and another id stays OTHER". F4 makes the owner's own names count ALWAYS (his
// second account has its own id), and AC S4-15 accepts the exact-full-name namesake risk: the owner controls the list.
// What still holds, and is pinned here: a namesake sharing only the FIRST name stays OTHER.
const firstOnly = row({ chatId: ONE, messageId: "q3", at: "2026-11-16T13:05:00Z", sender: { id: "rivera-guid", name: "Owen Rivera", isApp: false } });
t("R1-8 (F4) once an id is known, a sender with the owner's exact FULL name is the owner (his 2nd account); a first-name namesake stays OTHER", teamsChatsFromLedger([older, older2, ask, twin, firstOnly, own], [], ["Owen Example"]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), ["OTHER", "OWNER", "OWNER", "OTHER"]);
t("R1-9 an app sender with the owner's name never counts", ownerTeamsIdsAcross([row({ sender: { id: "app-guid", name: "Owen Example", isApp: true } })], [], ["Owen Example"]), []);
t("R1-10 foldPersonName: 'Last, First' -> 'first last'; plain kept", [foldPersonName("Example,  Owen"), foldPersonName(" Owen  Example "), foldPersonName(null)], ["owen example", "owen example", ""]);

// ── R2. SETTLED GUARD + GROUNDING ────────────────────────────────────────────────────────────────────
const HAY = ["Could you confirm the synthetic venue by Thursday?"];
const good = { open_item: true, kind: "reply", todo: "Confirm the venue", due: "Thursday", quote: "confirm the synthetic venue by Thursday", confidence: "high", reason: "Asked directly.", category: "person_request" };
const adm = (raw: unknown, settled: boolean) => admitActionVerdict(raw, HAY, { key: "k|1", settled, nowIso: NOW });
t("R2-1 GUARD: settled + kind reply -> NOT admitted (none, answered by his reply)", [adm(good, true).status, adm(good, true).answeredByReply], ["none", true]);
t("R2-2 GUARD: settled + kind both -> admitted as action only", [adm({ ...good, kind: "both" }, true).status, adm({ ...good, kind: "both" }, true).kind], ["open", "action"]);
t(
  "R2-3 GUARD: settled + a reason claiming he has not replied -> reason dropped (a sentence about someone else is kept)",
  ["You have not replied yet.", "Pat asked and you haven't responded.", "There is no reply from you.", "You are yet to answer.", "Pat hasn't got back on the form."].map((reason) => adm({ ...good, kind: "action", reason }, true).reason),
  [null, null, null, null, "Pat hasn't got back on the form."],
);
t("R2-4 settled + action keeps a neutral reason; NOT settled is unchanged (reply stays open, reason kept)", [adm({ ...good, kind: "action", reason: "Form to fill." }, true).reason, adm(good, false).status, adm({ ...good, reason: "You have not replied yet." }, false).reason], ["Form to fill.", "open", "You have not replied yet."]);
t("R2-5 the grounding rule is in the Teams, step-2 and step-3 instructions", [TEAMS_INSTRUCTIONS, STEP2_INSTRUCTIONS, STEP3_INSTRUCTIONS].map((s) => s.includes(GROUNDED)), [true, true, true]);

// ── R3. WRONG?: "AI misread it" ──────────────────────────────────────────────────────────────────────
t("R3-1 the new reason exists, labelled, and the earlier reasons are all still there", [CORRECTION_REASONS.includes("ai_misread"), CORRECTION_LABEL.ai_misread, ["not_mine", "already_handled", "not_an_action", "wrong_section", "stop_list"].every((r) => (CORRECTION_REASONS as readonly string[]).includes(r))], [true, "AI misread it", true]);
const mc = makeCorrection({ reason: "ai_misread", text: "Synthetic: that was my own message", itemKey: "teams:x|y" }, null, NOW);
t("R3-2 an ai_misread correction is accepted through the same validator", mc.ok && [mc.correction.reason, mc.correction.text], ["ai_misread", "Synthetic: that was my own message"]);

// ── R4. MEETING DETAIL LINES ─────────────────────────────────────────────────────────────────────────
const NOTES = [
  "Responsible person: Not stated.",
  "**Pat Example**",
  "- **Send** the synthetic deck to the team (01:02)",
  "  - Responsible person: Not stated.",
  "  - Timestamp: (01:01–01:32).",
  "  - Timing: Beyond two weeks, inferred because no date was set.",
  "- Book the synthetic room for the offsite",
  "  - **Owner:** Pat",
  "  * Due date: Friday",
  "- Deadline: none",
].join("\n");
const sp = splitActionItems(NOTES);
t("R4-1 GUARD: label lines are never items; ** stripped from titles", sp.items, ["Send the synthetic deck to the team", "Book the synthetic room for the offsite"]);
t(
  "R4-2 label lines are attached to the item above them",
  sp.details.map((d) => d.map((x) => x.label)),
  [["responsible person", "timestamp", "timing"], ["owner", "due date", "deadline"]],
);
t("R4-3 a label line before any item is dropped and counted; headings still recorded", [sp.dropped.detail, sp.headings], [1, ["Pat Example", "Pat Example"]]);
t(
  "R4-4 spellings: Responsible/Owner/Assignee/Assigned to/Timestamp/Time stamps/Timing/Due/Deadline/Context/Notes; not a sentence that merely contains a colon",
  ["Responsible: x", "Assignee: x", "Assigned to: x", "Time stamps: x", "Due: x", "Context: x", "Notes: x", "**Timestamp:** (00:10)", "Send the deck: today", "Owners meeting prep"].map((l) => detailLineOf(l)?.label ?? null),
  ["responsible", "assignee", "assigned to", "time stamps", "due", "context", "notes", "timestamp", null, null],
);

// ── R6. ONE ROW PER TEAMS ASK + LABEL ────────────────────────────────────────────────────────────────
const cand = (o: Partial<ActionCandidate> & { quote?: string | null; who?: string }): ActionCandidate =>
  ({
    proposalId: null,
    proposalState: null,
    source: "teams",
    status: "open",
    answeredByReply: false,
    onBoard: false,
    section: "needs_reply",
    category: null,
    kind: "reply",
    itemKey: "k",
    correction: null,
    listSender: null,
    uninvolved: false,
    at: null,
    ...o,
    display: { title: "x", who: o.who ?? "Pat Example", sourceLabel: "", reasonLine: null, quote: o.quote ?? null, due: null, reply: null, replyAsk: null, teamsLink: null, meetingTitle: null, assignee: null },
  }) as ActionCandidate;
const dupA = cand({ itemKey: "a", at: "2026-11-16T12:56:00Z", quote: "Please let me know  how often you want our synthetic 1:1" });
const dupB = cand({ itemKey: "b", at: "2026-11-16T15:04:00Z", quote: "please let me know how often you want our synthetic 1:1" });
const other = cand({ itemKey: "c", at: "2026-11-16T16:00:00Z", quote: "please let me know how often you want our synthetic 1:1", who: "Sam Example" });
const email = cand({ itemKey: "e", source: "email", at: "2026-11-16T10:00:00Z", quote: "please let me know how often you want our synthetic 1:1" });
const closed = cand({ itemKey: "n", status: "none", at: "2026-11-16T09:00:00Z", quote: "please let me know how often you want our synthetic 1:1" });
// Loop-2 D-2: the same-sender test is by SENDER ID (senderIdOf), never by display name; a long quote is required.
const sidOf = (m: Record<string, string>) => (c: ActionCandidate) => m[c.itemKey] ?? null;
const SIDS = { a: "pat-guid", b: "pat-guid", c: "sam-guid", e: "pat-guid", n: "pat-guid" };
t("R6-1 GUARD: same sender id + same long quote in two chats -> ONE row, the newest", collapseDuplicateTeamsItems([dupA, dupB, other, email, closed], sidOf(SIDS)).map((c) => c.itemKey), ["b", "c", "e", "n"]);
t("R6-2 GUARD (loop-2 D-2): a shared backing proposal alone never collapses (different senders, different quotes)", collapseDuplicateTeamsItems([cand({ itemKey: "p1", proposalId: "prop-1", at: "2026-11-16T10:00:00Z", quote: "review the synthetic document for the board pack" }), cand({ itemKey: "p2", proposalId: "prop-1", who: "Sam Example", at: "2026-11-16T11:00:00Z", quote: "please review the synthetic document before Monday" })], sidOf({ p1: "pat-guid", p2: "sam-guid" })).map((c) => c.itemKey), ["p1", "p2"]);
t("R6-3 different asks are untouched", collapseDuplicateTeamsItems([cand({ itemKey: "x1", quote: "send the synthetic deck" }), cand({ itemKey: "x2", quote: "book the synthetic room" })]).map((c) => c.itemKey), ["x1", "x2"]);
const shortQ = "Can you take a look at this?";
t("R6-5 GUARD (loop-2 D-2): same sender, the SAME SHORT generic sentence in two chats -> TWO rows", collapseDuplicateTeamsItems([cand({ itemKey: `teams:${ONE}|m1`, at: "2026-11-16T10:00:00Z", quote: shortQ }), cand({ itemKey: `teams:${GRP}|m2`, at: "2026-11-16T11:00:00Z", quote: shortQ })], () => "pat-guid").length, 2);
t("R6-6 the same long quote under the same display NAME but no known sender id -> TWO rows (a name is not an id)", collapseDuplicateTeamsItems([dupA, dupB]).map((c) => c.itemKey), ["a", "b"]);
t("R6-7 two open items from the SAME chat -> one row, the newest", collapseDuplicateTeamsItems([cand({ itemKey: `teams:${ONE}|m1`, at: "2026-11-16T10:00:00Z", quote: "send the synthetic deck" }), cand({ itemKey: `teams:${ONE}|m2`, at: "2026-11-16T11:00:00Z", quote: "book the synthetic room" })]).map((c) => c.itemKey), [`teams:${ONE}|m2`]);
{
  // Through buildCandidates: the same long ask from the same person in the 1:1 and in a group chat -> one row; the
  // sender id comes from the stored rows.
  const LONG = "Synthetic: please send me the signed vendor form by Friday";
  const r1 = row({ chatId: ONE, messageId: "a1", at: "2026-11-16T10:00:00Z", text: LONG });
  const r2 = row({ chatId: GRP, chatName: "Synthetic squad", messageId: "a2", at: "2026-11-16T11:00:00Z", text: LONG, mentionedUserIds: [OWNER_ID] });
  const r3 = row({ chatId: ONE2, messageId: "a3", at: "2026-11-16T12:00:00Z", sender: { id: "sam-guid", name: "Sam Example", isApp: false }, text: LONG });
  const rs = [older, older2, r1, r2, r3];
  const asmD2 = assembleLedgerPlan({ rows: rs, proposals: [], bell: [] }, cfgNoIds, Date.parse("2026-11-09T05:00:00Z"));
  const us = threadUnits(asmD2, ACTIONS_SETTINGS_DEFAULT).units.filter((x) => x.source === "teams");
  const vs = new Map<string, ActionVerdict>(us.map((x) => [`${x.storeAt.source}\u0000${x.storeAt.sourceItemId}`, { v: 1, key: x.itemKey, inputVersion: CLASSIFIER_INPUT_VERSION.teams, status: "open", kind: "reply", category: "person_request", confidence: "high", todo: "Send the form", due: null, quote: "please send me the signed vendor form by Friday", reason: "Asked.", answeredByReply: false, proposalId: "prop-shared", at: NOW } as ActionVerdict]));
  const got = buildCandidates({ assembled: asmD2, rows: rs, settings: ACTIONS_SETTINGS_DEFAULT, verdicts: vs, proposals: new Map([["prop-shared", { id: "prop-shared", state: "proposed", title: "Send the form", assignee: null, correction: null }]]), meetingProposals: [], replies: [], isDraftable: () => false }).candidates.filter((c) => c.source === "teams" && c.status === "open");
  t("R6-8 end to end: Pat's 1:1 + group copy collapse to the newest; Sam's identical ask (other id, same proposal) stays", got.map((c) => [c.display.who, c.at]).sort(), [["Pat Example", "2026-11-16T11:00:00Z"], ["Sam Example", "2026-11-16T12:00:00Z"]]);
}
{
  // Verify-2 orphan fix (2026-11-18): the collapse winner is chosen among items the page will LIST first. The same
  // What-shows rule the selection applies (whatShowsHideReason) decides eligibility; ties go to the smaller itemKey.
  const LQ = "Synthetic: please send me the signed quarterly vendor form by Friday afternoon";
  const A1 = cand({ itemKey: `teams:${ONE}|a1`, proposalId: "pa", proposalState: "proposed", category: "person_request", at: "2026-11-16T10:00:00Z", quote: LQ });
  const B1 = cand({ itemKey: `teams:${GRP}|b1`, proposalId: "pb", proposalState: "proposed", category: "person_request", at: "2026-11-16T11:00:00Z", quote: LQ });
  const same = () => "pat-guid";
  const hideUn = { ...ACTIONS_SETTINGS_DEFAULT, hideUninvolvedChats: true };
  const elig = (s: typeof ACTIONS_SETTINGS_DEFAULT) => {
    const w = whatShowsHideReason(s);
    return (c: ActionCandidate) => w(c) === null;
  };
  const where = (sel: ReturnType<typeof selectActionItems>, key: string) => (["rows", "unchecked", "held", "corrected", "answered"] as const).filter((g) => sel[g].some((r) => r.itemKey === key));
  const run = (cands: ActionCandidate[], s = ACTIONS_SETTINGS_DEFAULT) => {
    const sel = selectActionItems(collapseDuplicateTeamsItems(cands, same, elig(s)), s);
    return { A: where(sel, A1.itemKey), B: where(sel, B1.itemKey), hidden: sel.hidden.total };
  };
  t("R6-9 GUARD (verify-2 orphan): newer twin uninvolved + Hide uninvolved on -> the older involved twin stays listed", run([A1, { ...B1, uninvolved: true }], hideUn), { A: ["rows"], B: [], hidden: 0 });
  t("R6-10 GUARD (verify-2 orphan): newer twin in a HIDDEN category -> the older twin stays listed", run([A1, { ...B1, category: "meeting_invite" }]), { A: ["rows"], B: [], hidden: 0 });
  t("R6-11 GUARD (verify-2 tie): same `at`, both input orders -> the SAME winner (smaller itemKey)", [collapseDuplicateTeamsItems([A1, { ...B1, at: A1.at }], same).map((c) => c.itemKey), collapseDuplicateTeamsItems([{ ...B1, at: A1.at }, A1], same).map((c) => c.itemKey)], [[A1.itemKey], [A1.itemKey]]);
  t("R6-12 both twins hidden -> still ONE ask (the newest) in the hidden count, as before", run([{ ...A1, uninvolved: true }, { ...B1, uninvolved: true }], hideUn), { A: [], B: [], hidden: 1 });
  t("R6-13 an older hidden twin never drops the newer listed one", run([{ ...A1, uninvolved: true }, B1], hideUn), { A: [], B: ["rows"], hidden: 0 });
  // The verifier's probe table (VERIFY-actions-no-orphans-2.md): every row keeps its earlier result except the fixed one.
  t(
    "R6-14 verify-2 probe rows unchanged except the fixed one: diff at / B dismissed / B on board / B Wrong? / A legacy held / B legacy held",
    [
      run([A1, B1]),
      run([A1, { ...B1, proposalState: "dismissed" }]),
      run([A1, { ...B1, onBoard: true }]),
      run([A1, { ...B1, correction: { itemKey: B1.itemKey, reason: "not_mine", at: "x" } as ActionCandidate["correction"] }]),
      run([{ ...A1, proposalId: null }, B1]),
      run([A1, { ...B1, proposalId: null }]),
    ],
    [
      { A: [], B: ["rows"], hidden: 0 },
      { A: [], B: [], hidden: 0 },
      { A: [], B: [], hidden: 0 },
      { A: [], B: ["corrected"], hidden: 0 },
      { A: [], B: ["rows"], hidden: 0 },
      { A: [], B: ["held"], hidden: 0 },
    ],
  );
  // End to end through buildCandidates (the wiring the page uses): Pat's 1:1 ask, and the same ask newer in an
  // involved group chat that the classifier put in a hidden category -> the 1:1 ask is listed.
  const LONG = "Synthetic: please send me the signed vendor form by Friday";
  const r1 = row({ chatId: ONE, messageId: "v1", at: "2026-11-16T10:00:00Z", text: LONG });
  const r2 = row({ chatId: GRP, chatName: "Synthetic squad", messageId: "v2", at: "2026-11-16T11:00:00Z", text: LONG, mentionedUserIds: [OWNER_ID] });
  const rs = [older, older2, r1, r2];
  const asmV = assembleLedgerPlan({ rows: rs, proposals: [], bell: [] }, cfgNoIds, Date.parse("2026-11-09T05:00:00Z"));
  const us = threadUnits(asmV, ACTIONS_SETTINGS_DEFAULT).units.filter((x) => x.source === "teams" && (x.teams?.chatId === ONE || x.teams?.chatId === GRP));
  const grp = (x: (typeof us)[number]) => x.teams?.chatId === GRP;
  const vs = new Map<string, ActionVerdict>(us.map((x) => [`${x.storeAt.source}\u0000${x.storeAt.sourceItemId}`, { v: 1, key: x.itemKey, inputVersion: CLASSIFIER_INPUT_VERSION.teams, status: "open", kind: "reply", category: grp(x) ? "meeting_invite" : "person_request", confidence: "high", todo: "Send the form", due: null, quote: "please send me the signed vendor form by Friday", reason: "Asked.", answeredByReply: false, proposalId: grp(x) ? "prop-g" : "prop-1", at: NOW } as ActionVerdict]));
  const props = new Map([["prop-1", { id: "prop-1", state: "proposed", title: "Send the form", assignee: null, correction: null }], ["prop-g", { id: "prop-g", state: "proposed", title: "Send the form", assignee: null, correction: null }]]);
  const candsV = buildCandidates({ assembled: asmV, rows: rs, settings: ACTIONS_SETTINGS_DEFAULT, verdicts: vs, proposals: props, meetingProposals: [], replies: [], isDraftable: () => false }).candidates;
  const selV = selectActionItems(candsV, ACTIONS_SETTINGS_DEFAULT);
  t("R6-15 GUARD (verify-2, end to end): the newer twin hidden by category does not drop the listed 1:1 ask", [us.length, selV.rows.filter((r) => r.itemKey.startsWith(`teams:${ONE}|`)).length, selV.hidden.categories.meeting_invite ?? 0], [2, 1, 0]);
}
t(
  "R6-4 label: 1:1; a group chat named only after the owner -> 'Teams group chat'; another name kept; no name -> 'Teams'",
  [teamsSourceLabel({ kind: "one_on_one", chatName: null }, ["Owen Example"]), teamsSourceLabel({ kind: "group", chatName: "Example, Owen" }, ["Owen Example"]), teamsSourceLabel({ kind: "group", chatName: "Synthetic squad" }, ["Owen Example"]), teamsSourceLabel({ kind: "group", chatName: null }, [])],
  ["Teams 1:1", "Teams group chat", "Teams, Synthetic squad", "Teams"],
);
void GRP;

// ── R7. LOOP-2 D-1: a verdict judged by the OLD labelling is judged again ───────────────────────────
// The chat's LAST message is the owner's own (so the item key is the same before and after the fix). The verdict
// the old code stored for that key took the owner's sentence as an ask from someone else.
{
  const rowsD1 = [older, older2, ask, own];
  const u = threadUnits(asm, ACTIONS_SETTINGS_DEFAULT).units.find((x) => x.teams?.chatId === ONE)!;
  const storeKey = `${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`;
  const stale: ActionVerdict = { v: 1, key: u.itemKey, status: "open", kind: "action", category: "person_request", confidence: "high", todo: "Tell them how often", due: null, quote: "please let me know how often you want our synthetic 1:1", reason: "Asked directly.", answeredByReply: false, proposalId: "p-stale", at: NOW };
  const verdicts = new Map<string, ActionVerdict>([[storeKey, stale]]);
  t("R7-1 GUARD: a stored Teams verdict from before the version (no inputVersion) is NOT counted as judged", currentlyJudgedKeys(verdicts).has(u.itemKey), false);
  const cands = (vs: ReadonlyMap<string, ActionVerdict>, props: [string, string][]) =>
    buildCandidates({ assembled: asm, rows: rowsD1, settings: ACTIONS_SETTINGS_DEFAULT, verdicts: vs, proposals: new Map(props.map(([id, title]) => [id, { id, state: "proposed", title, assignee: null, correction: null }])), meetingProposals: [], replies: [], isDraftable: () => false }).candidates.find((c) => c.source === "teams")!;
  const before = cands(verdicts, [["p-stale", "Tell them how often"]]);
  t("R7-2 GUARD: until re-judged the stale verdict is not shown (not checked yet), never the owner's own sentence", [before.status, before.display.quote], ["not_checked", null]);
  const answer = (kind: string) => ({ open_item: true, kind, todo: "Say whether weekly works", due: null, quote: "can we meet weekly?", confidence: "high", reason: "Asked directly.", category: "person_request" });
  const run = async (kind: string) => {
    const stored = new Map<string, ActionVerdict>();
    const deps: ClassifyDeps = {
      recordCall: async () => {},
      model: async () => answer(kind),
      propose: async () => ({ id: "p-new", onBoard: false }),
      storeVerdict: async (at, v) => void stored.set(`${at.source}\u0000${at.sourceItemId}`, v),
      addMeetingRows: async () => 0,
      nowIso: () => NOW,
    };
    const r = await runClassify(asm, { ...ACTIONS_SETTINGS_DEFAULT, sources: { ...ACTIONS_SETTINGS_DEFAULT.sources, email: false, meeting: false } }, currentlyJudgedKeys(verdicts), 6, deps);
    return { r, nv: stored.get(storeKey) };
  };
  const { r, nv } = await run("action");
  // Two Teams threads in this plan (ONE, and the older ONE2 chat which has no verdict at all): both are called.
  t("R7-3 the old-version thread is judged again (inside the per-pass limit) and stored at the current version", [r.calls, r.alreadyJudged, nv?.inputVersion, nv?.key === u.itemKey], [2, 0, CLASSIFIER_INPUT_VERSION.teams, true]);
  const after = cands(new Map([[storeKey, nv!]]), [["p-new", "Say whether weekly works"]]);
  t("R7-4 the corrected sender wins: shown as the OTHER person's ask, quoting the OTHER person's message", [after.status, after.display.who, after.display.quote, after.display.title], ["open", "Pat Example", "can we meet weekly?", "Say whether weekly works"]);
  const rep = await run("reply");
  t("R7-5 the re-judged verdict passes the settled guard (owner wrote last): a reply he already gave is not owed", [rep.nv?.status, rep.nv?.answeredByReply], ["none", true]);
  t("R7-6 a current-version verdict is reused (no call); a verdict for an older item key is not", [currentlyJudgedKeys(new Map([[storeKey, nv!]])).has(u.itemKey), verdictIsCurrent({ ...nv!, key: "teams:x|old" }, u.itemKey, "teams")], [true, false]);
  // 2026-11-17 (app_invite, BUILD-actions-app-invite.md): the email instructions changed, so email was bumped to 2 and
  // teams to 3. Every verdict judged before is judged again; only the current version is reused.
  t(
    "R7-7 GUARD (updated for X-1, 2026-11-18): email at 3, teams at 4 -- older email (none / 1 / 2) and teams (2 / 3) verdicts are re-judged",
    [verdictIsCurrent({ key: "e|1" }, "e|1", "email"), verdictIsCurrent({ key: "e|1", inputVersion: 1 }, "e|1", "email"), verdictIsCurrent({ key: "e|1", inputVersion: 2 }, "e|1", "email"), verdictIsCurrent({ key: "e|1", inputVersion: 3 }, "e|1", "email"), verdictIsCurrent({ key: "t|1", inputVersion: 2 }, "t|1", "teams"), verdictIsCurrent({ key: "t|1", inputVersion: 3 }, "t|1", "teams"), verdictIsCurrent({ key: "t|1", inputVersion: 4 }, "t|1", "teams")],
    [false, false, false, true, false, false, true],
  );
}

// ── R9. LOOP-2 D-4: one bad ownerUserId row cannot promote a sender everywhere ─────────────────────
{
  const SAM = "sam-guid-0003";
  const realA = row({ chatId: ONE2, messageId: "r1", at: "2026-11-10T10:00:00Z", ownerUserId: OWNER_ID });
  const realB = row({ chatId: GRP, messageId: "r2", at: "2026-11-10T11:00:00Z", ownerUserId: OWNER_ID, mentionedUserIds: [OWNER_ID] });
  const bad = row({ chatId: `19:bad${AT}thread.v2`, messageId: "b1", at: "2026-11-10T12:00:00Z", ownerUserId: SAM });
  const samAsk = row({ chatId: ONE, messageId: "s1", at: "2026-11-16T12:00:00Z", sender: { id: SAM, name: "Sam Example", isApp: false }, text: "Synthetic: can you send the report?" });
  t("R9-1 GUARD: an id on ONE chat's row is not taken across chats when the owner's id is on 2+ chats", ownerTeamsIdsAcross([realA, realB, bad, samAsk]), [OWNER_ID]);
  t("R9-2 so the sender of that bad row stays OTHER in every other chat (his ask still shows)", teamsChatsFromLedger([realA, realB, bad, samAsk]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), ["OTHER"]);
  t("R9-3 one chat only: the most frequent id (2+ rows, strictly ahead) is taken; a 1-row id is not; a tie takes neither", [ownerTeamsIdsAcross([realA, row({ chatId: ONE2, messageId: "r3", ownerUserId: OWNER_ID })]), ownerTeamsIdsAcross([realA]), ownerTeamsIdsAcross([realA, row({ chatId: ONE2, messageId: "r3", ownerUserId: OWNER_ID }), row({ chatId: ONE2, messageId: "r4", ownerUserId: SAM }), row({ chatId: ONE2, messageId: "r5", ownerUserId: SAM })])], [[OWNER_ID], [], []]);
  t("R9-4 a configured id always counts; within its OWN chat a row's ownerUserId still labels the owner", [ownerTeamsIdsAcross([bad], ["CFG-1"]), teamsChatsFromLedger([row({ chatId: ONE2, messageId: "x1", sender: { id: OWNER_ID, name: "x", isApp: false }, ownerUserId: OWNER_ID })]).find((c) => c.chatId === ONE2)!.messages.map((m) => m.speaker)], [["cfg-1"], ["OWNER"]]);
}

// ── R10. LOOP-2 D-5: the uninvolved rule keeps its pre-fix fail-open ─────────────────────────────────
{
  const G2 = `19:grp2${AT}thread.v2`;
  const g1 = row({ chatId: G2, messageId: "g1", at: "2026-11-16T10:00:00Z", fromOwner: false, mentionedUserIds: [] });
  const g2 = row({ chatId: G2, messageId: "g2", at: "2026-11-16T11:00:00Z", fromOwner: false, mentionedUserIds: [] });
  const inv = (rs: LedgerReportRow[], cfg: string[] = []) => teamsChatsFromLedger(rs, cfg).find((c) => c.chatId === G2)!.involvement;
  t("R10-1 GUARD: rows fromOwner:false + mention arrays, NO owner id of the chat's own (ids only on other chats) -> cant_tell_owner_unknown, SHOWN", [inv([older, older2, g1, g2]).reason, inv([older, older2, g1, g2]).hide], ["cant_tell_owner_unknown", false]);
  t("R10-2 unchanged: with a configured owner id the same chat is uninvolved (hidden)", [inv([g1, g2], [OWNER_ID]).reason, inv([g1, g2], [OWNER_ID]).hide], ["uninvolved", true]);
  const gOwn = row({ chatId: G2, messageId: "g3", at: "2026-11-16T12:00:00Z", sender: { id: OWNER_ID, name: "x", isApp: false }, fromOwner: null, mentionedUserIds: [] });
  t("R10-3 the cross-chat ids may still make a chat SHOW: the owner's own message there -> owner_sent", inv([older, older2, g1, gOwn]).reason, "owner_sent");
}

// ── R11. LOOP-2 D-6: the settled guard scrubs the to-do too ──────────────────────────────────────────
{
  const act = (o: Record<string, unknown>, settled = true) => adm({ ...good, kind: "action", ...o }, settled);
  t(
    "R11-1 GUARD: settled -> a to-do claiming he has not replied keeps only its action; a pure claim is dropped",
    ["You have not replied to Pat: send the deck", "You haven't replied yet.", "You still need to resubmit the form", "Reply to Pat - you have not responded"].map((todo) => act({ todo }).todo),
    ["Send the deck", null, "Resubmit the form", "Reply to Pat"],
  );
  t("R11-2 GUARD: settled -> a reason asserting 'you still need to ...' is dropped", act({ reason: "You still need to resubmit the form." }).reason, null);
  t(
    "R11-3 no over-reach: normal to-dos and someone else's state are kept; NOT settled is unchanged",
    [act({ todo: "Send the deck to Pat" }).todo, act({ todo: "Pat still needs the signed form" }).todo, act({ reason: "Pat still needs the form." }).reason, act({ todo: "You have not replied to Pat: send the deck" }, false).todo],
    ["Send the deck to Pat", "Pat still needs the signed form", "Pat still needs the form.", "You have not replied to Pat: send the deck"],
  );
  t("R11-4 scrubOwnerStateTodo leaves null / claim-free input as is", [scrubOwnerStateTodo(null), scrubOwnerStateTodo("Book the room")], [null, "Book the room"]);
}

// ── R12. LOOP-2 D-7: a real "Label: action" bullet stays an item ─────────────────────────────────────
{
  const E = [
    "**Pat Example**",
    "- Pat to send the synthetic deck (01:02)",
    "Responsible person: Not stated.",
    "Timestamp: (01:01-01:32).",
    "- Timing the launch with marketing",
    "- Notes from Jane on budget",
    "- **Deadline**: submit the synthetic grant application by Dec 1",
    "- Note: Owen to send synthetic pricing to the client",
    "Timing: Beyond two weeks, inferred because no date was set.",
    "  - Context: the client asked twice",
  ].join("\n");
  const se = splitActionItems(E);
  t(
    "R12-1 GUARD: '- Note: <action>' and '- **Deadline**: <action>' stay ITEMS (content never dropped)",
    se.items,
    ["Pat to send the synthetic deck", "Timing the launch with marketing", "Notes from Jane on budget", "Deadline: submit the synthetic grant application by Dec 1", "Note: Owen to send synthetic pricing to the client"],
  );
  t(
    "R12-2 the owner's real metadata lines still attach (Responsible person / Timestamp / Timing), and an indented note attaches",
    se.details.map((d) => d.map((x) => x.label)),
    [["responsible person", "timestamp"], [], [], [], ["timing", "context"]],
  );
  t("R12-3 isMetadataDetail: metadata label + no action verb only", [isMetadataDetail({ label: "owner", value: "Pat" }), isMetadataDetail({ label: "owner", value: "Pat to send the deck" }), isMetadataDetail({ label: "note", value: "Not stated" })], [true, false, false]);
}

// ── R8. LOOP-2 D-3: owner FULL names from config, never a bare first name ──────────────────────────
{
  const full = ownerFullNames({ mailbox: "owen.example@work.example", ownerLogins: ["owen.example@huddle.example"] });
  t("R8-1 ownerFullNames: 'first.last' login/mailbox -> 'First Last'; config names need two words; no config -> login only", [full, ownerFullNames({ ownerLogins: ["oexample@x.example"], correspondence: { ownerNames: ["Owen", "Example, Owen", "Owen  Example"] } })], [["Owen Example"], ["Example, Owen", "Owen Example"]]);
  // The live default: NO correspondence.ownerNames, login first.last. No owner id anywhere (last resort applies).
  const cfgDefault = parseFeedsConfig(JSON.stringify({ enabled: true, synthetic: false, driveUser: MAILBOX, mailbox: MAILBOX, ownerLogins: ["owen.example@huddle.example"], teams: {} }))!;
  const ownLF = row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: OWNER_ID, name: "Example, Owen", isApp: false }, text: "Synthetic owner line" });
  const asm3 = assembleLedgerPlan({ rows: [ask, ownLF], proposals: [], bell: [] }, cfgDefault, Date.parse("2026-11-09T05:00:00Z"));
  t("R8-2 GUARD: default config (no ownerNames): 'Example, Owen' is recognised as the owner via the login's full name", asm3.plan.teams.scan.concat(asm3.plan.teams.hiddenUninvolved).find((c) => c.chatId === ONE)?.messages.map((m) => m.speaker), ["OTHER", "OWNER"]);
  const sameFirst = row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: "near-guid", name: "Owen Other", isApp: false } });
  const bare = row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: "bare-guid", name: "Owen", isApp: false } });
  t(
    "R8-3 GUARD: a bare first-name match never marks the sender as the owner (configured 'Owen'; senders 'Owen' and 'Owen Other')",
    [teamsChatsFromLedger([ask, bare], [], ["Owen"]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), teamsChatsFromLedger([ask, sameFirst], [], ["Owen", "Owen Example"]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker)],
    [["OTHER", "OTHER"], ["OTHER", "OTHER"]],
  );
  t(
    "R8-4 label: a group chat named 'Example, Owen' -> 'Teams group chat' with the full name; a chat named just 'Owen' keeps its name",
    [teamsSourceLabel({ kind: "group", chatName: "Example, Owen" }, full), teamsSourceLabel({ kind: "group", chatName: "Owen" }, ["Owen", ...full])],
    ["Teams group chat", "Teams, Owen"],
  );
  const grpRow = row({ chatId: GRP, chatName: "Example, Owen", messageId: "g1", at: "2026-11-16T11:00:00Z", text: "Synthetic group line", mentionedUserIds: [OWNER_ID] });
  const asm4 = assembleLedgerPlan({ rows: [older, older2, grpRow], proposals: [], bell: [] }, cfgDefault, Date.parse("2026-11-09T05:00:00Z"));
  const g = buildCandidates({ assembled: asm4, rows: [older, older2, grpRow], settings: { ...ACTIONS_SETTINGS_DEFAULT, hideUninvolvedChats: false }, verdicts: new Map(), proposals: new Map(), meetingProposals: [], replies: [], isDraftable: () => false }).candidates.find((c) => c.itemKey.startsWith(`teams:${GRP}`));
  t("R8-5 end to end with the default config: the group chat named after the owner is labelled 'Teams group chat'", g?.display.sourceLabel, "Teams group chat");
}

// R13 role labels never reach the owner (2026-11-17 owner screenshot: "OTHER asked ..., and OWNER said ...")
{
  const { plainRoles, GROUNDED } = await import("../src/features/huddle/lib/correspondence/action-classify");
  t("R13-1 OTHER/OWNER labels become plain words", plainRoles("OTHER asked how to handle PTO, and OWNER said they would circle back."), "They asked how to handle PTO, and you said they would circle back.");
  t("R13-2 the OWNER's -> your", plainRoles("Send the OWNER's timesheet."), "Send your timesheet.");
  t("R13-3 ordinary lowercase 'other' is untouched", plainRoles("Review the other draft."), "Review the other draft.");
  t("R13-4 null stays null", plainRoles(null), null);
  t("R13-5 the instructions tell the model not to write the labels", GROUNDED.includes("Never write the words OWNER or OTHER"), true);
}

// ── RED-TEAM pre-pass 2026-11-18 (docs/qc-evidence/REDTEAM-actions-safety-invites.md). A row that FAILS here is an
// attack that SUCCEEDED: the test asserts the CORRECT behaviour and the source was deliberately NOT fixed. ──
{
  const { quoteIsVerbatim, isMomentaryQuote, actionSectionFor } = await import("../src/features/huddle/lib/correspondence/action-classify");
  const A = { key: "k|rt", settled: false, nowIso: NOW };
  const ask = (quote: string, o: Record<string, unknown> = {}) => ({ open_item: true, kind: "action", category: "person_request", confidence: "high", todo: "Synthetic to-do", quote, reason: "Synthetic reason", ...o });
  // F1 (quote admission)
  t("RT-1 F1 an ellipsis must not elide a negation inside one sentence (quote inverts 'do not send')", quoteIsVerbatim("Please do ... send the contract to the client.", ["Please do not send the contract to the client. Thanks."]), false);
  t("RT-2 F1 rule 4: a fragment must not end mid-word on a combining mark (NFD 'cafe\\u0301')", quoteIsVerbatim("We reviewed the cafe ... notes are due Friday", ["We reviewed the café menu. The notes are due Friday."]), false);
  t("RT-3 F1 the same visible text in NFC (quote) and NFD (message) is admitted", quoteIsVerbatim("The café notes are due Friday", ["The café notes are due Friday."]), true);
  t("RT-4 F1 fragments are never stitched across two OTHER messages", quoteIsVerbatim("Here is the outline of topics. Please send your first notes by Monday.", ["Here is the outline of topics.", "Please send your first notes by Monday."]), false);
  t("RT-5 F1 one occurrence cannot back a repeated fragment", quoteIsVerbatim("Please confirm the venue. ... Please confirm the venue.", ["Please confirm the venue. Thanks."]), false);
  t("RT-6 F1 a 7-sentence quote that is ONE contiguous span is still admitted by the whole-quote path (rule 1)", quoteIsVerbatim("One two. Three. Four. Five. Six. Seven. Eight nine ten.", ["One two. Three. Four. Five. Six. Seven. Eight nine ten."].map((s) => s + " x")), true);
  t("RT-6b F1 ... but 7 fragments with a gap are rejected", quoteIsVerbatim("One two. Three. Four. Five. Six. Seven. ... Eight nine ten eleven.", ["One two. Three. Four. Five. Six. Seven. Gap. Eight nine ten eleven."]), false);
  // F3 (momentary backstop must fail OPEN)
  const hidden = admitActionVerdict(ask("Thanks!", { todo: "Send the signed contract" }), ["Thanks! Can you send me the signed contract by Friday?"], A);
  t("RT-7 F3 a pleasantry QUOTE on a message that carries a real ask must not hide the item (fail open: held or open, never none)", hidden.status !== "none", true);
  t("RT-8 F3 'Thanks — can you send the deck' (em dash) is not momentary", isMomentaryQuote("Thanks — can you send the deck"), false);
  t("RT-9 F3 'Running late… can you start the review' is not momentary", isMomentaryQuote("Running late… can you start the review"), false);
  t("RT-10 F3 'See you there; bring the contract' is not momentary", isMomentaryQuote("See you there; bring the contract"), false);
  // F2-6 (a bare invite must never become a reply item)
  const dinner = "Dinner Friday at 7, hope you can make it! The venue is the synthetic bistro on Example Street.";
  const both = admitActionVerdict(ask("Dinner Friday at 7, hope you can make it!", { kind: "both", category: "meeting_invite" }), [dinner], A);
  t("RT-11 F2-6 a bare dinner invite judged meeting_invite + kind BOTH is not listed under Needs your reply", both.status === "open" && actionSectionFor("email", both.kind) === "needs_reply", false);
  const realAsk = admitActionVerdict(ask("Please bring your first draft to Thursday's call.", { kind: "action", category: "meeting_invite" }), ["Join link. Please bring your first draft to Thursday's call."], A);
  t("RT-12 F2-6 a meeting_invite of kind ACTION with a real ask keeps today's path (open)", realAsk.status, "open");
  // F4 ("Names that are you")
  const OA = "owner-guid-rt-a";
  const base = [row({ chatId: ONE2, messageId: "rt1", sender: { id: OA, name: "Sam Okafor", isApp: false }, ownerUserId: OA }), row({ chatId: ONE3, messageId: "rt2", sender: { id: OA, name: "Sam Okafor", isApp: false }, ownerUserId: OA })];
  const second = (name: string, isApp = false, names = ["Samuel Okafor", "Sam Okafor"]) =>
    ownerTeamsIdsAcross([...base, row({ chatId: ONE, messageId: "rt3", sender: { id: "second-acct-rt-b", name, isApp } })], [], names).includes("second-acct-rt-b");
  t("RT-13 F4 his second account in NFD ('Sa\\u0301muel Okafor') vs the list in NFC ('S\\u00E1muel Okafor') is the OWNER", second("Sámuel Okafor", false, ["Sámuel Okafor"]), true);
  t("RT-14 F4 a display name with a trailing zero-width space is still his name", second("Samuel Okafor​"), true);
  t("RT-15 F4 'Okafor , Samuel' (space before the comma) is the OWNER", second("Okafor , Samuel"), true);
  t("RT-16 F4 namesake 'Sam Rivera' with a bare 'Sam' in the list is OTHER", second("Sam Rivera", false, ["Sam", "Sam Okafor"]), false);
  t("RT-17 F4 'Samuel Okafor-Diaz' (prefix namesake) is OTHER", second("Samuel Okafor-Diaz"), false);
  t("RT-18 F4 'Okafor Samuel' (no comma) is OTHER unless listed", second("Okafor Samuel"), false);
  t("RT-19 F4 an app sender named after him is never the OWNER", second("Samuel Okafor", true), false);
  t("RT-20 F4 'Samuel Okafor (External)' is OTHER unless listed (SD)", second("Samuel Okafor (External)"), false);
  // ── FIX pass 2026-11-18 (docs/qc-evidence/FIX-redteam-actions-safety-invites.md): one guard per fix, each isolates ONE rule.
  t("RT-1b GUARD F1 a sentence-split gap may not skip words inside a sentence ('Please do. Send the contract.' vs '... Do not send the contract.')", quoteIsVerbatim("Please do. Send the contract to the client.", ["Please do. Do not send the contract to the client."]), false);
  t("RT-1c F1 an ellipsis that skips WHOLE sentences is still admitted", quoteIsVerbatim("Here is the plan. ... Send the draft by Friday.", ["Here is the plan. The room is booked. Send the draft by Friday."]), true);
  t("RT-2b GUARD F1 rule 4: a non-composing combining mark (q + U+0307) after a fragment's last letter is mid-word", quoteIsVerbatim("Here is the plan. Send the draft to q", ["Here is the plan. Ignore this. Send the draft to q̇x now."]), false);
  t("RT-3b GUARD F1 an NFC quote matches the NFD message even as one contiguous span", quoteIsVerbatim("Please review the café menu", ["Please review the café menu today."]), true);
  const latest = (msgs: string[]) => admitActionVerdict(ask("Thanks!", { todo: "Send the signed contract" }), msgs, { ...A, latestMessages: msgs.slice(-1) });
  t("RT-7b F3 a Teams sender whose LATEST message is wholly 'Thanks!' is dropped (momentary)", [latest(["Can you send the signed contract by Friday?", "Thanks!"]).status, latest(["Can you send the signed contract by Friday?", "Thanks!"]).dropReason], ["none", "momentary"]);
  t("RT-7c GUARD F3 'Thanks!' quoted from an EARLIER message while the sender's latest carries a real ask is not dropped", latest(["Thanks!", "Can you send the signed contract by Friday?"]).status !== "none", true);
  t("RT-11b GUARD F2-6 meeting_invite + kind both is admitted as kind action (To-do, not Needs your reply)", [both.status, both.kind], ["open", "action"]);
  t("RT-11c F2-6 kind both on another category is unchanged", admitActionVerdict(ask("Dinner Friday at 7, hope you can make it!", { kind: "both", category: "person_request" }), [dinner], A).kind, "both");
  t("RT-13b GUARD foldPersonName NFC: NFD and NFC spellings fold to one name", foldPersonName("Sámuel Okafor") === foldPersonName("Sámuel Okafor"), true);
  t("RT-14b GUARD foldPersonName strips zero-width / format characters (U+200B, U+FEFF, U+2060)", [foldPersonName("Samuel​ Okafor﻿"), foldPersonName("Okafor,⁠ Samuel")], ["samuel okafor", "samuel okafor"]);
}

// ── Verifier VERIFY-actions-safety-invites-1 (F3 FAILS-CLOSED): the Teams wiring gives the backstop the WHOLE unanswered tail ──
{
  const TV = `19:tv_x${AT}unq.gbl.spaces`;
  const LEE = { id: "other-guid-0003", name: "Lee Example", isApp: false };
  const OWN = { id: OWNER_ID, name: "Example, Owen", isApp: false };
  const runTail = async (chat: LedgerReportRow[], quote = "Thanks!") => {
    const asmT = assembleLedgerPlan({ rows: [older, older2, ...chat], proposals: [], bell: [] }, cfgNoIds, Date.parse("2026-11-09T05:00:00Z"));
    const stored = new Map<string, ActionVerdict>();
    const deps: ClassifyDeps = {
      recordCall: async () => {},
      model: async () => ({ open_item: true, kind: "action", todo: "Send the signed contract", due: null, quote, confidence: "high", reason: "Asked directly.", category: "person_request" }),
      propose: async () => ({ id: "p-tv", onBoard: false }),
      storeVerdict: async (at, v) => void stored.set(`${at.source}\u0000${at.sourceItemId}`, v),
      addMeetingRows: async () => 0,
      nowIso: () => NOW,
    };
    await runClassify(asmT, { ...ACTIONS_SETTINGS_DEFAULT, sources: { ...ACTIONS_SETTINGS_DEFAULT.sources, email: false, meeting: false } }, new Set(), 6, deps);
    const u = threadUnits(asmT, ACTIONS_SETTINGS_DEFAULT).units.find((x) => x.teams?.chatId === TV);
    return u ? stored.get(`${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`)?.status : "no-unit";
  };
  const askPat = row({ chatId: TV, messageId: "t1", at: "2026-11-16T12:00:00Z", text: "Can you send me the signed contract by Friday?" });
  const thanksPat = row({ chatId: TV, messageId: "t2", at: "2026-11-16T12:01:00Z", text: "Thanks!" });
  const thanksLee = row({ chatId: TV, messageId: "t3", at: "2026-11-16T12:02:00Z", sender: LEE, text: "Thanks!" });
  t("F3V-1 GUARD same sender: an ask then 'Thanks!' (model quotes 'Thanks!') is NOT dropped", ["open", "not_checked"].includes(String(await runTail([askPat, thanksPat]))), true);
  t("F3V-2 GUARD another sender: Pat asks, Lee says 'Thanks!' -> NOT dropped", ["open", "not_checked"].includes(String(await runTail([askPat, thanksLee]))), true);
  const brt = row({ chatId: TV, messageId: "t4", at: "2026-11-16T12:03:00Z", sender: OWN, text: "Be right there" });
  const nw = row({ chatId: TV, messageId: "t5", at: "2026-11-16T12:04:00Z", text: "No worries, thank you!" });
  t("F3V-3 GUARD (loop 2 A7) an ask, the owner's 'Be right there', then 'No worries, thank you!' -> NOT dropped by code (the ask is in the chat)", ["open", "not_checked"].includes(String(await runTail([askPat, brt, nw], "No worries, thank you!"))), true);
  const deckAsk = row({ chatId: TV, messageId: "t6", at: "2026-11-16T12:00:00Z", text: "Can you send me the deck tomorrow?" });
  const ownDeck = row({ chatId: TV, messageId: "t7", at: "2026-11-16T12:01:00Z", sender: OWN, text: "Be right there. I'll send you the deck tomorrow." });
  const seeYou = row({ chatId: TV, messageId: "t8", at: "2026-11-16T12:02:00Z", text: "Thanks, see you soon!" });
  t("F3V-5 GUARD (loop 2 A8) a promised deliverable then 'Thanks, see you soon!' -> NOT dropped", ["open", "not_checked"].includes(String(await runTail([deckAsk, ownDeck, seeYou], "Thanks, see you soon!"))), true);
  const okPat = row({ chatId: TV, messageId: "t9", at: "2026-11-16T12:00:00Z", text: "See you this afternoon!" });
  const brt2 = row({ chatId: TV, messageId: "t10", at: "2026-11-16T12:01:00Z", sender: OWN, text: "Be right there" });
  const nw2 = row({ chatId: TV, messageId: "t11", at: "2026-11-16T12:02:00Z", text: "No worries, thank you!" });
  t("F3V-4 a chat that is ONLY logistics and pleasantries (both speakers) -> dropped (momentary)", await runTail([okPat, brt2, nw2], "No worries, thank you!"), "none");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
