// WHAT:       Offline tests (synthetic data only) for the open-items report read from the Azure ledger:
//             the WINDOW rule, the UNINVOLVED-CHAT rule (Teams group/meeting chats the owner never wrote in and was never
//             @mentioned in are hidden before any AI step; 1:1 always shows; missing data shows), the RESOLUTION rule
//             (decided task proposals / dismissed bell rows set a thread aside only until something newer arrives),
//             the ledger -> message mappers, the meeting action-item list, and the Teams parser keeping mention ids.
// WHY:        Owner 2026-11-16: the report must run off Azure since Monday, keep every unresolved item, and hide
//             Teams group chats he is not part of. These rules decide what the owner is shown.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-report-from-ledger.md.
// Run: bun scripts/report-from-ledger.test.ts
import {
  REPORT_SINCE_DEFAULT,
  chatInvolvement,
  emailMessagesFromLedger,
  forwardsFromLedger,
  inReportWindow,
  meetingItemsFromLedger,
  messageLookup,
  planLedgerReport,
  resolutionSignals,
  sentFromLedger,
  teamsChatKind,
  teamsChatsFromLedger,
  threadResolution,
  type LedgerReportRow,
} from "../src/features/huddle/lib/correspondence/report-from-ledger";
import { conversationFacts, groupEmailConversations, type NeedsYouContext } from "../src/features/huddle/lib/correspondence/needs-you";
import { latestSentByConversation, parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { parseTeamsLog } from "../src/features/huddle/lib/external-feeds/teams-log";
import { teamsContent, teamsSourceItem, type EmailContent, type TeamsContent, type TranscriptContent } from "../src/features/huddle/lib/correspondence/source-item";
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
const OWNER = "owner-guid-0001";
const SINCE = Date.parse("2026-11-09T05:00:00Z");
const CHAT_1 = "19:aaa_bbb@unq.gbl.spaces";
const CHAT_G = "19:group01@thread.v2";
const CHAT_M = "19:meeting_xyz@thread.v2";
const CHAT_C = "19:chan@thread.tacv2";

const tmsg = (chatId: string, id: string, at: string, o: Partial<TeamsContent> = {}): LedgerReportRow => ({
  source: "teams",
  sourceItemId: `${encodeURIComponent(chatId)}:${id}`,
  threadId: chatId,
  at,
  content: {
    kind: "teams",
    chatId,
    chatName: "Synthetic chat",
    messageId: id,
    at,
    sender: { id: "other-guid", name: "Pat Example", isApp: false },
    fromOwner: false,
    text: "Can someone look at the synthetic draft?",
    webUrl: null,
    mentionedUserIds: [],
    ownerUserId: OWNER,
    ...o,
  },
});
const contentsOf = (rows: LedgerReportRow[]) => rows.map((r) => r.content as TeamsContent);

const email = (id: string, conv: string, at: string, o: Partial<EmailContent> = {}): LedgerReportRow => ({
  source: "email",
  sourceItemId: `${MAILBOX}:${id}`,
  threadId: conv,
  at,
  content: {
    kind: "email",
    subject: "Synthetic subject",
    from: { name: "Pat Example", address: "pat@partner.example" },
    to: [MAILBOX],
    cc: [],
    receivedAt: at,
    conversationId: conv,
    internetMessageId: null,
    bodyText: "Could you send the synthetic numbers?",
    isForward: false,
    ...o,
  },
});

// ── Chat kind
t("K-1 chat kind from the Graph id shape", [CHAT_1, CHAT_G, CHAT_M, CHAT_C, "weird"].map(teamsChatKind), ["one_on_one", "group", "meeting", "channel", "unknown"]);

// ── UNINVOLVED_CHAT_RULE
const g1 = [tmsg(CHAT_G, "1", "2026-11-10T14:00:00Z"), tmsg(CHAT_G, "2", "2026-11-10T15:00:00Z")];
t("U-1 group chat, owner never wrote, never mentioned -> HIDDEN (uninvolved)", chatInvolvement(CHAT_G, contentsOf(g1)), { hide: true, kind: "group", reason: "uninvolved" });
t("U-2 meeting chat, same -> HIDDEN", chatInvolvement(CHAT_M, contentsOf(g1.map((r) => ({ ...r, content: { ...(r.content as TeamsContent), chatId: CHAT_M } })))), { hide: true, kind: "meeting", reason: "uninvolved" });
t("U-3 1:1 chat ALWAYS shows, even with no owner message and no mention", chatInvolvement(CHAT_1, contentsOf(g1)), { hide: false, kind: "one_on_one", reason: "one_on_one" });
const gSent = [...g1, tmsg(CHAT_G, "3", "2026-11-10T13:00:00Z", { fromOwner: true, sender: { id: OWNER, name: "Owner", isApp: false } })];
t("U-4 group chat where the owner sent a message (even before the others) -> shows", chatInvolvement(CHAT_G, contentsOf(gSent)), { hide: false, kind: "group", reason: "owner_sent" });
const gMention = [tmsg(CHAT_G, "1", "2026-11-10T14:00:00Z", { mentionedUserIds: ["someone-else"] }), tmsg(CHAT_G, "2", "2026-11-10T15:00:00Z", { mentionedUserIds: [OWNER.toUpperCase()] })];
t("U-5 group chat where the owner was @mentioned (id compared case-insensitively) -> shows", chatInvolvement(CHAT_G, contentsOf(gMention)), { hide: false, kind: "group", reason: "owner_mentioned" });
const gNoMentionData = [tmsg(CHAT_G, "1", "2026-11-10T14:00:00Z"), tmsg(CHAT_G, "2", "2026-11-10T15:00:00Z", { mentionedUserIds: undefined })];
t("U-6 a message with NO mention data (stored before the field) -> can't tell -> SHOWS", chatInvolvement(CHAT_G, contentsOf(gNoMentionData)), { hide: false, kind: "group", reason: "cant_tell_no_mention_data" });
const gNull = [tmsg(CHAT_G, "1", "2026-11-10T14:00:00Z", { fromOwner: null })];
t("U-7 a message whose author is unknown (fromOwner null) -> can't tell -> SHOWS", chatInvolvement(CHAT_G, contentsOf(gNull)), { hide: false, kind: "group", reason: "cant_tell_owner_unknown" });
const gNoOwnerId = [tmsg(CHAT_G, "1", "2026-11-10T14:00:00Z", { ownerUserId: undefined })];
t("U-8 no owner id anywhere (no line id, none configured) -> can't tell -> SHOWS", chatInvolvement(CHAT_G, contentsOf(gNoOwnerId)), { hide: false, kind: "group", reason: "cant_tell_owner_unknown" });
const gCfgMention = [tmsg(CHAT_G, "1", "2026-11-10T14:00:00Z", { ownerUserId: undefined, mentionedUserIds: ["cfg-owner-id"] })];
t("U-9 configured owner ids count for the mention test", chatInvolvement(CHAT_G, contentsOf(gCfgMention), ["CFG-OWNER-ID"]).reason, "owner_mentioned");
const gSenderId = [tmsg(CHAT_G, "1", "2026-11-10T14:00:00Z", { fromOwner: false, sender: { id: OWNER.toUpperCase(), name: "Owner", isApp: false } })];
t("U-10 a message whose sender id IS the owner's id counts as sent by him", chatInvolvement(CHAT_G, contentsOf(gSenderId)).reason, "owner_sent");
// 2026-11-16 (Actions view, owner's accepted answers): channels are treated like group chats (was: always shown).
t("U-11 a channel the owner never wrote in and was never @mentioned in -> HIDE, like a group", chatInvolvement(CHAT_C, contentsOf(g1)), { hide: true, kind: "channel", reason: "uninvolved" });

// ── Teams facts + the plan (pre-filter BEFORE any AI step)
const allTeams = [...g1, tmsg(CHAT_1, "9", "2026-11-11T09:00:00Z"), ...gMention.map((r) => ({ ...r, sourceItemId: r.sourceItemId + "m", content: { ...(r.content as TeamsContent), chatId: "19:group02@thread.v2" } }))];
const chats = teamsChatsFromLedger(allTeams);
const plan1 = planLedgerReport({ emailFacts: [], teams: chats, meetings: [], signals: [], sinceMs: SINCE });
t("P-1 uninvolved group chat is set aside, never scanned; 1:1 and mentioned group chat are scanned", [plan1.teams.hiddenUninvolved.map((c) => c.chatId), plan1.teams.scan.map((c) => c.chatId).sort()], [[CHAT_G], [CHAT_1, "19:group02@thread.v2"].sort()]);
const plan1b = planLedgerReport({ emailFacts: [], teams: teamsChatsFromLedger(gNoMentionData), meetings: [], signals: [], sinceMs: SINCE });
t("P-2 a can't-tell group chat is scanned and counted", [plan1b.teams.scan.length, plan1b.teams.cantTell, plan1b.teams.hiddenUninvolved.length], [1, 1, 0]);
const tf = teamsChatsFromLedger(gSent)[0];
t("P-3 teams facts: speakers, latest OTHER, settled only when the owner wrote AFTER it", [tf.messages.map((m) => m.speaker), tf.latestOther?.id.endsWith(":2"), tf.settled], [["OWNER", "OTHER", "OTHER"], true, false]);
const tfSettled = teamsChatsFromLedger([...g1, tmsg(CHAT_G, "4", "2026-11-10T16:00:00Z", { fromOwner: true })])[0];
t("P-4 owner wrote after the latest OTHER -> settled", tfSettled.settled, true);

// ── WINDOW
t("W-1 window: at/after since in, before out, unreadable out", [inReportWindow(SINCE, SINCE), inReportWindow(SINCE - 1, SINCE), inReportWindow(NaN, SINCE)], [true, false, false]);
t("W-2 the default window is Monday 2026-11-09 00:00 ET", REPORT_SINCE_DEFAULT, "2026-11-09T05:00:00Z");
const ctx: NeedsYouContext = { ownerAddresses: new Set([MAILBOX]), ownerNames: ["Owner"], latestSent: new Map(), sentKnown: true };
const factsOf = (rows: LedgerReportRow[], c: NeedsYouContext = ctx) => [...groupEmailConversations(MAILBOX, emailMessagesFromLedger(rows))].map(([k, ms]) => conversationFacts(k, ms, c));
const eRows = [
  email("old1", "conv-old", "2026-11-05T12:00:00Z"),
  email("span1", "conv-span", "2026-11-06T12:00:00Z"),
  email("span2", "conv-span", "2026-11-10T12:00:00Z"),
  email("new1", "conv-new", "2026-11-12T12:00:00Z"),
];
const planW = planLedgerReport({ emailFacts: factsOf(eRows), teams: teamsChatsFromLedger([tmsg(CHAT_1, "old", "2026-11-01T10:00:00Z")]), meetings: [], signals: [], sinceMs: SINCE });
t("W-3 a conversation is in when its NEWEST message is in the window, and keeps its older messages", [planW.email.scan.map((f) => [f.conversationId, f.messages.length]).sort(), planW.email.outOfWindow, planW.teams.outOfWindow], [[["conv-new", 1], ["conv-span", 2]], 1, 1]);
const planDays = planLedgerReport({ emailFacts: factsOf(eRows), teams: [], meetings: [], signals: [], sinceMs: SINCE });
t("W-4 previous days' unresolved items stay (Tuesday's conversation is still listed on a later day)", planDays.email.scan.some((f) => f.conversationId === "conv-span"), true);

// ── RESOLUTION
const rRows = [email("a1", "conv-a", "2026-11-10T12:00:00Z"), email("b1", "conv-b", "2026-11-10T12:00:00Z"), email("b2", "conv-b", "2026-11-12T12:00:00Z"), email("c1", "conv-c", "2026-11-10T12:00:00Z"), email("d1", "conv-d", "2026-11-10T12:00:00Z")];
const lookup = messageLookup([...rRows, ...g1], MAILBOX);
const sigs = resolutionSignals(
  [
    { source: "email", sourceItemId: `${MAILBOX}:conv:conv-a`, normTitle: "x", state: "approved", decidedAt: "2026-11-11T09:00:00Z" },
    { source: "email", sourceItemId: `${MAILBOX}:conv:conv-b`, normTitle: "x", state: "dismissed", decidedAt: "2026-11-11T09:00:00Z" },
    { source: "email", sourceItemId: `${MAILBOX}:conv:conv-c`, normTitle: "x", state: "proposed", decidedAt: "2026-11-11T09:00:00Z" },
    { source: "teams", sourceItemId: g1[1].sourceItemId, normTitle: "x", state: "delegated", decidedAt: "2026-11-11T09:00:00Z" },
  ],
  [{ kind: "email", graphMessageId: `feed:${MAILBOX}:d1`, conversationId: "conv-d", status: "dismissed", receivedAt: "2026-11-10T12:00:00Z" }],
  lookup,
  MAILBOX,
);
const planR = planLedgerReport({ emailFacts: factsOf(rRows), teams: [], meetings: [], signals: sigs, sinceMs: SINCE });
t("R-1 added as a task (approved) after the latest message -> set aside as resolved", planR.email.resolved.some((x) => x.f.conversationId === "conv-a"), true);
t("R-2 ignored BEFORE a newer message arrived -> SHOWS again", planR.email.scan.some((f) => f.conversationId === "conv-b"), true);
t("R-3 a proposal still waiting on the owner (proposed) resolves nothing", planR.email.scan.some((f) => f.conversationId === "conv-c"), true);
t("R-4 a dismissed bell row for the latest message -> resolved", planR.email.resolved.some((x) => x.f.conversationId === "conv-d" && x.via.via === "bell_dismissed"), true);
t("R-5 exactly a and d resolved", planR.email.resolved.map((x) => x.f.conversationId).sort(), ["conv-a", "conv-d"]);
const tSig = threadResolution(`teams:${CHAT_G}`, Date.parse("2026-11-10T15:00:00Z"), sigs);
t("R-6 a Teams proposal on the latest message (delegated) resolves the chat; a later message would not", [tSig?.state, threadResolution(`teams:${CHAT_G}`, Date.parse("2026-11-10T15:00:01Z"), sigs)], ["delegated", null]);
const chatBell = resolutionSignals([], [{ kind: "chat", graphMessageId: `${CHAT_1}:9`, conversationId: CHAT_1, status: "dismissed", receivedAt: "2026-11-11T09:00:00Z" }, { kind: "chat", graphMessageId: `${CHAT_C}:1`, conversationId: CHAT_C, status: "replied", receivedAt: "2026-11-11T09:00:00Z" }], new Map(), MAILBOX);
t("R-7 dismissed chat bell row -> a signal; 'replied' is NOT a resolution", chatBell.map((s) => [s.thread, s.via]), [[`teams:${CHAT_1}`, "bell_dismissed"]]);
const planRT = planLedgerReport({ emailFacts: [], teams: teamsChatsFromLedger([tmsg(CHAT_1, "9", "2026-11-11T09:00:00Z")]), meetings: [], signals: chatBell, sinceMs: SINCE });
t("R-8 a dismissed 1:1 chat is set aside as resolved, not scanned", [planRT.teams.resolved.length, planRT.teams.scan.length], [1, 0]);
t("R-9 owner-only conversation is never 'resolved' (the scan counts it)", planLedgerReport({ emailFacts: factsOf([email("o1", "conv-o", "2026-11-10T12:00:00Z", { from: { name: "Owner", address: MAILBOX } })]), teams: [], meetings: [], signals: sigs, sinceMs: SINCE }).email.scan.length, 1);

// ── Mappers
const mapped = emailMessagesFromLedger([email("m1", "conv-m", "2026-11-10T12:00:00Z"), email("m2", "conv-m", "2026-11-10T13:00:00Z", { to: [], cc: [] })]);
t("M-1 ledger email -> feed id + recipients; both lists empty -> recipients unknown (never 'not addressed')", [mapped[0].id, mapped[0].toRecipients, "toRecipients" in mapped[1]], [`feed:${MAILBOX}:m1`, [MAILBOX], false]);
const fx = factsOf([email("m1", "conv-m", "2026-11-10T12:00:00Z")])[0];
t("M-2 owner position from stored To", fx.ownerPosition, "direct");
const sentRows: LedgerReportRow[] = [{ source: "sent", sourceItemId: `${MAILBOX}:s1`, threadId: "conv-m", at: "2026-11-10T14:00:00Z", content: { ...(email("s1", "conv-m", "2026-11-10T14:00:00Z").content as EmailContent), kind: "sent", sentAt: "2026-11-10T14:00:00Z" } }];
const sent = sentFromLedger(sentRows);
const fxSent = factsOf([email("m1", "conv-m", "2026-11-10T12:00:00Z")], { ...ctx, latestSent: latestSentByConversation(sent) })[0];
t("M-3 stored Sent Items -> 'answered by your reply' (settled)", [sent.length, fxSent.settled], [1, true]);
const fwd = forwardsFromLedger([email("f1", "conv-f", "2026-11-10T12:00:00Z", { subject: "FW: synthetic", isForward: true, bodyText: "See below.\n\nFrom: Pat Example\nSent: Monday\nTo: Owner\nSubject: synthetic\n\nPlease complete the synthetic form by Friday." }), email("f2", "conv-g", "2026-11-10T12:00:00Z", { subject: "FW: other", isForward: true, bodyText: "See below." })]);
t("M-4 forwards: a plain-text forward header is recovered; one whose forwarded part was not stored is counted", [fwd.isForward, fwd.forwards.size, fwd.missing, (fwd.forwards.get(`feed:${MAILBOX}:f1`) ?? "").includes("synthetic form")], [2, 1, 1, true]);

// ── Meetings
const tr: LedgerReportRow = {
  source: "transcript",
  sourceItemId: "mtg-1",
  threadId: null,
  at: "2026-11-10T16:00:00Z",
  content: { kind: "transcript", title: "Synthetic sync", meetingAt: "2026-11-10T16:00:00Z", sentences: [], summary: { action_items: "- Send the synthetic deck (01:02)\n- Book the synthetic room\n" } } as TranscriptContent,
};
const mt = meetingItemsFromLedger([tr], [
  { source: "transcript", sourceItemId: "mtg-1", normTitle: titleKey("Book the synthetic room"), state: "dismissed", decidedAt: null },
  { source: "transcript", sourceItemId: "mtg-1", normTitle: titleKey("Send the synthetic deck"), state: "untriaged", decidedAt: null },
]);
t("MT-1 meeting action items split (stamp stripped); a triaged item (Skip) is set aside; untriaged stays open", [mt[0].open, mt[0].resolved.map((r) => r.state)], [["Send the synthetic deck"], ["dismissed"]]);
const planM = planLedgerReport({ emailFacts: [], teams: [], meetings: [...mt, { ...mt[0], meetingId: "old", newestMs: Date.parse("2026-11-02T00:00:00Z") }], signals: [], sinceMs: SINCE });
t("MT-2 meetings before the window are left out", [planM.meetings.inWindow.length, planM.meetings.outOfWindow], [1, 1]);

// ── Teams parser keeps mention ids + the line owner id (stored content)
const cfg = parseFeedsConfig(JSON.stringify({ enabled: true, ownerLogins: [MAILBOX], driveUser: MAILBOX, mailbox: MAILBOX, synthetic: false, teams: {} }))!;
const line = (msgs: unknown[]) => JSON.stringify({ source: "teams", synthetic: false, chatId: CHAT_G, ownerUserId: OWNER.toUpperCase(), capturedUtc: "2026-11-10T23:00:00Z", messages: msgs });
const parsed = parseTeamsLog(
  line([
    { id: "1", createdDateTime: "2026-11-10T14:00:00Z", from: { user: { id: "Other-Guid", displayName: "Pat Example" } }, body: { contentType: "text", content: "hello @Owner" }, mentions: [{ id: 0, mentioned: { user: { id: "OWNER-GUID-0001" } } }, { id: 1, mentioned: { conversation: { id: "x" } } }] },
    { id: "2", createdDateTime: "2026-11-10T14:01:00Z", from: { user: { id: "other-guid", displayName: "Pat Example" } }, body: { contentType: "text", content: "no mentions here" }, mentions: [] },
    { id: "3", createdDateTime: "2026-11-10T14:02:00Z", from: { user: { id: "other-guid", displayName: "Pat Example" } }, body: { contentType: "text", content: "no mentions field" } },
  ]),
  cfg,
);
t("TP-1 mentions -> user ids only, lower-cased; [] kept as []; absent stays absent; ownerUserId lower-cased; mentionsOwner only when known", parsed.messages.map((m) => [m.mentionedUserIds ?? "ABSENT", m.ownerUserId, m.fromOwner, m.mentionsOwner ?? "ABSENT"]), [[["owner-guid-0001"], OWNER, false, true], [[], OWNER, false, false], ["ABSENT", OWNER, false, "ABSENT"]]);
t("TP-1b stored mentionsOwner=true alone is enough to show the chat", chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent), mentionsOwner: true }]).reason, "owner_mentioned");
const tc = teamsContent(parsed.messages[0]);
t("TP-2 stored Teams content carries the new fields; the content hash is unchanged by them", [tc.mentionedUserIds, tc.ownerUserId, teamsSourceItem(parsed.messages[0], { path: "/t" }).contentHash === teamsSourceItem({ ...parsed.messages[0], mentionedUserIds: undefined, ownerUserId: undefined }, { path: "/t" }).contentHash], [["owner-guid-0001"], OWNER, true]);
const viaParser = teamsChatsFromLedger(parsed.messages.map((m) => ({ source: "teams" as const, sourceItemId: m.messageId, threadId: m.chatId, at: m.at, content: teamsContent(m) })));
t("TP-3 end to end: parsed line -> stored content -> the chat shows because the owner was @mentioned", viaParser[0].involvement.reason, "owner_mentioned");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
