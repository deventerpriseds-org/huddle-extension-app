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
import { CORRECTION_LABEL, CORRECTION_REASONS, makeCorrection, ACTIONS_SETTINGS_DEFAULT, type ActionCandidate } from "../src/features/huddle/lib/actions/actions";
import { buildCandidates, collapseDuplicateTeamsItems, currentlyJudgedKeys, runClassify, teamsSourceLabel, threadUnits, verdictIsCurrent, type ClassifyDeps } from "../src/features/huddle/lib/actions/pipeline";
import { CLASSIFIER_INPUT_VERSION, type ActionVerdict } from "../src/features/huddle/lib/correspondence/action-classify";
import { detailLineOf, splitActionItems } from "../src/features/huddle/lib/proposals/meeting-triage";

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
t("R1-8 GUARD: once an id is known, a NAMESAKE with another id stays OTHER", teamsChatsFromLedger([older, older2, ask, twin, own], [], ["Owen Example"]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), ["OTHER", "OWNER", "OTHER"]);
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
  t("R7-7 email verdicts without inputVersion stay current (email version not bumped)", verdictIsCurrent({ key: "e|1" }, "e|1", "email"), true);
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
