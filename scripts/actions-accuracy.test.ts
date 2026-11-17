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
const ask = row({ chatId: ONE, messageId: "q1", at: "2026-11-16T12:00:00Z", text: "Synthetic: can we meet weekly?" });
const own = row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: OWNER_ID, name: "Example, Owen", isApp: false }, text: "Hey, when you're back, please let me know how often you want our synthetic 1:1." });
const chats = teamsChatsFromLedger([older, ask, own]);
const c1 = chats.find((c) => c.chatId === ONE)!;
t(
  "R1-1 GUARD: owner id seen on another chat's row labels the owner's own message OWNER (sender not reversed)",
  [c1.messages.map((m) => m.speaker), c1.latestOther?.id, c1.settled],
  [["OTHER", "OWNER"], ask.sourceItemId, true],
);
t("R1-2 the owner's own sentence is never in the quote haystack", teamsQuoteHaystack(c1).some((s) => s.includes("when you're back")), false);
const ownOnly = teamsChatsFromLedger([older, row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: OWNER_ID, name: "x", isApp: false }, text: "Synthetic owner-only note" })]);
t("R1-3 a chat holding only the owner's message has no latest OTHER (nothing to classify)", ownOnly.find((c) => c.chatId === ONE)!.latestOther, null);
t("R1-4 ownerTeamsIdsAcross: configured + every row's ownerUserId, normalised", ownerTeamsIdsAcross([older, ask], [" CFG-ID "]).sort(), ["cfg-id", OWNER_ID].sort());

// Through the real assembly (config WITHOUT teams.ownerSenderIds, as live), and into the Actions units.
const cfgNoIds = parseFeedsConfig(JSON.stringify({ enabled: true, synthetic: false, driveUser: MAILBOX, mailbox: MAILBOX, ownerLogins: ["owner@huddle.example"], teams: {}, correspondence: { ownerNames: ["Owen Example"] } }))!;
const asm = assembleLedgerPlan({ rows: [older, ask, own], proposals: [], bell: [] }, cfgNoIds, Date.parse("2026-11-09T05:00:00Z"));
const unit = threadUnits(asm, ACTIONS_SETTINGS_DEFAULT).units.find((u) => u.teams?.chatId === ONE);
t("R1-5 end to end (assembleLedgerPlan -> threadUnits): the unit's latest OTHER is the other person's message and it is settled", [unit?.refItemId, unit?.teams?.settled], [ask.sourceItemId, true]);

// Display-name LAST RESORT: only when no id is known anywhere.
const noIdOwn = row({ chatId: ONE, messageId: "m1", at: "2026-11-16T12:56:00Z", sender: { id: OWNER_ID, name: "Example, Owen", isApp: false } });
t("R1-6 GUARD: no id anywhere -> a sender named as the owner ('Last, First' folded) contributes its id", teamsChatsFromLedger([ask, noIdOwn], [], ["Owen Example"]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), ["OTHER", "OWNER"]);
t("R1-7 without owner names the same chat stays as stored (no guessing)", teamsChatsFromLedger([ask, noIdOwn]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), ["OTHER", "OTHER"]);
const twin = row({ chatId: ONE, messageId: "q2", at: "2026-11-16T13:00:00Z", sender: { id: "namesake-guid", name: "Owen Example", isApp: false } });
t("R1-8 GUARD: once an id is known, a NAMESAKE with another id stays OTHER", teamsChatsFromLedger([older, ask, twin, own], [], ["Owen Example"]).find((c) => c.chatId === ONE)!.messages.map((m) => m.speaker), ["OTHER", "OWNER", "OTHER"]);
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
const dupA = cand({ itemKey: "a", at: "2026-11-16T12:56:00Z", quote: "Please let me know  how often" });
const dupB = cand({ itemKey: "b", at: "2026-11-16T15:04:00Z", quote: "please let me know how often" });
const other = cand({ itemKey: "c", at: "2026-11-16T16:00:00Z", quote: "please let me know how often", who: "Sam Example" });
const email = cand({ itemKey: "e", source: "email", at: "2026-11-16T10:00:00Z", quote: "please let me know how often" });
const closed = cand({ itemKey: "n", status: "none", at: "2026-11-16T09:00:00Z", quote: "please let me know how often" });
t("R6-1 GUARD: same sender + same quote in two chats -> ONE row, the newest", collapseDuplicateTeamsItems([dupA, dupB, other, email, closed]).map((c) => c.itemKey), ["b", "c", "e", "n"]);
t("R6-2 same backing proposal -> one row, the newest", collapseDuplicateTeamsItems([cand({ itemKey: "p1", proposalId: "prop-1", at: "2026-11-16T10:00:00Z" }), cand({ itemKey: "p2", proposalId: "prop-1", at: "2026-11-16T11:00:00Z" })]).map((c) => c.itemKey), ["p2"]);
t("R6-3 different asks are untouched", collapseDuplicateTeamsItems([cand({ itemKey: "x1", quote: "send the synthetic deck" }), cand({ itemKey: "x2", quote: "book the synthetic room" })]).map((c) => c.itemKey), ["x1", "x2"]);
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
  const rowsD1 = [older, ask, own];
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
