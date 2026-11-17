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
  normTeamsId,
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

// ── Verifier report-from-ledger-1, finding 1: a mention that names no comparable user (@Everyone, tag, app, team,
//    channel) MAY address the owner -> the chat SHOWS (fail open). Synthetic ids only.
const pmsg = (id: string, o: Record<string, unknown>) => ({ id, createdDateTime: "2026-11-10T14:00:00Z", from: { user: { id: "other-guid", displayName: "Pat Example" } }, body: { contentType: "html", content: "Please send the synthetic numbers" }, ...o });
const parseOne = (o: Record<string, unknown>) => parseTeamsLog(line([pmsg("1", o)]), cfg).messages[0];
const everyone = { body: { contentType: "html", content: '<at id="0">Everyone</at> please send the synthetic numbers by Friday' }, mentions: [{ id: 0, mentionText: "Everyone", mentioned: { conversation: { id: CHAT_G, displayName: "Everyone", conversationIdentityType: "chat" } } }] };
const pe = parseOne(everyone);
t("VF1-1 parser: @Everyone (conversation mention) -> no user ids, unresolvedMention true", [pe.mentionedUserIds, pe.unresolvedMention], [[], true]);
t(
  "VF1-2 parser: tag / application / team / channel mentions -> unresolvedMention true; [2026-11-17] only the Graph tag shape is groupMentionOnly (app and the non-Graph {team}/{channel} shapes stay unknown)",
  [{ tag: { id: "tag-1", displayName: "Leads" } }, { application: { id: "app-1" } }, { team: { id: "team-1" } }, { channel: { id: "chan-1" } }].map((mentioned) => {
    const m = parseOne({ mentions: [{ id: 0, mentioned }] });
    return [m.unresolvedMention, m.groupMentionOnly];
  }),
  [[true, true], [true, false], [true, false], [true, false]],
);
t(
  "VF1-3 parser: a resolved user mention whose <at> id matches, and an empty list with no <at>, -> unresolvedMention false",
  [parseOne({ body: { contentType: "html", content: '<at id="0">Pat</at> ok?' }, mentions: [{ id: 0, mentioned: { user: { id: "user-guid-0002" } } }] }).unresolvedMention, parseOne({ mentions: [] }).unresolvedMention],
  [false, false],
);
t("VF1-4 parser: body <at> tag with no matching user mention -> unresolvedMention true", [parseOne({ body: { contentType: "html", content: '<at id="0">Someone</at> ok?' }, mentions: [] }).unresolvedMention, parseOne({ body: { contentType: "html", content: '<at id="3">Someone</at> ok?' }, mentions: [{ id: 0, mentioned: { user: { id: "user-guid-0002" } } }] }).unresolvedMention], [true, true]);
const evChats = teamsChatsFromLedger([pe].map((m) => ({ source: "teams" as const, sourceItemId: m.messageId, threadId: m.chatId, at: m.at, content: teamsContent(m) })));
const evPlan = planLedgerReport({ emailFacts: [], teams: evChats, meetings: [], signals: [], sinceMs: SINCE });
t(
  "VF1-5 end to end: an @Everyone ask in a group chat the owner never wrote in is SCANNED, not hidden; ownerMentioned unknown",
  [evPlan.teams.hiddenUninvolved.length, evPlan.teams.scan.length, evChats[0].involvement.reason, evChats[0].ownerMentioned, evPlan.teams.cantTell],
  [0, 1, "owner_maybe_mentioned", null, 1],
);
t("VF1-6 stored unresolvedMention true -> shows; stored false with [] -> still hidden (rule unchanged)", [chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent), unresolvedMention: true }]).reason, chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent), unresolvedMention: false }]).reason], ["owner_maybe_mentioned", "uninvolved"]);
t(
  "VF1-7 legacy row (no flag): an <at> tag left in the stored text with no stored user mention -> shows; without one -> unchanged (hidden)",
  [chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent), text: "hi <at>Everyone</at> please" }]).reason, chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent) }]).reason],
  ["owner_maybe_mentioned", "uninvolved"],
);
t("VF1-8 the content hash is unchanged by unresolvedMention (nothing re-processes)", teamsSourceItem(pe, { path: "/t" }).contentHash === teamsSourceItem({ ...pe, unresolvedMention: undefined, mentionedUserIds: undefined }, { path: "/t" }).contentHash, true);
t("VF1-9 stored content carries unresolvedMention", teamsContent(pe).unresolvedMention, true);

// ── Finding 4: a mention with an empty / non-string user id, a null mention entry, or a tag mention is UNKNOWN
//    (someone was mentioned, we cannot tell who) -> the chat shows. Parser side and stored side.
t(
  "VF4-1 parser: user id empty / whitespace / numeric, a null entry, an entry with no `mentioned`, a tag -> unresolvedMention true",
  [[{ id: 0, mentioned: { user: { id: "" } } }], [{ id: 0, mentioned: { user: { id: "   " } } }], [{ id: 0, mentioned: { user: { id: 9 } } }], [null], [{ id: 0 }], [{ id: 0, mentioned: { tag: { id: "tag-1" } } }]].map((mentions) => parseOne({ mentions }).unresolvedMention),
  [true, true, true, true, true, true],
);
const p4 = parseOne({ mentions: [null] });
t("VF4-2 parser -> ledger end to end: a null mention entry in a group chat the owner never wrote in -> SHOWS", chatInvolvement(CHAT_G, [teamsContent(p4)]).reason, "owner_maybe_mentioned");
t(
  "VF4-3 stored (older writer, no flag): an empty-string / whitespace / null / numeric entry in mentionedUserIds -> SHOWS",
  [[""], ["  "], [null], [7], ["user-guid-0002", ""]].map((ids) => chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent), mentionedUserIds: ids as string[] }]).reason),
  ["owner_maybe_mentioned", "owner_maybe_mentioned", "owner_maybe_mentioned", "owner_maybe_mentioned", "owner_maybe_mentioned"],
);
t("VF4-4 a stored list of real, non-owner user ids is still 'nobody we care about' -> hidden (rule unchanged)", chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent), mentionedUserIds: ["user-guid-0002"] }]).reason, "uninvolved");

// ── Finding 5: chatInvolvement and teamsChatsFromLedger use ONE owner-id normaliser (trim + lower-case), so the
//    involvement verdict and the facts handed to the model (who is OWNER, settled, ownerMentioned) always agree.
t("VF5-1 normTeamsId: trim + lower-case; non-string -> ''", [normTeamsId("  OWNER-Guid-0001 "), normTeamsId(null), normTeamsId(9), normTeamsId(undefined)], [OWNER, "", "", ""]);
const f5 = (rows: LedgerReportRow[], cfgIds: string[] = []) => {
  const c = teamsChatsFromLedger(rows, cfgIds)[0];
  return [c.involvement.reason, c.messages.map((m) => m.speaker), c.settled, c.ownerMentioned];
};
const askThenOwner = (o1: Partial<TeamsContent>, o2: Partial<TeamsContent>) => [tmsg(CHAT_G, "q", "2026-11-10T10:00:00Z", o1), tmsg(CHAT_G, "a", "2026-11-10T11:00:00Z", { fromOwner: null, ...o2 })];
t(
  "VF5-2 stored ownerUserId upper-case (non-parser writer): the owner's reply is OWNER and the chat is settled, matching owner_sent",
  f5(askThenOwner({ ownerUserId: OWNER.toUpperCase() }, { ownerUserId: OWNER.toUpperCase(), sender: { id: OWNER, name: "Owner", isApp: false } })),
  ["owner_sent", ["OTHER", "OWNER"], true, false],
);
t(
  "VF5-3 configured id with surrounding whitespace (no line id): same verdict and same speakers",
  f5(askThenOwner({ ownerUserId: undefined }, { ownerUserId: undefined, sender: { id: OWNER, name: "Owner", isApp: false } }), [`  ${OWNER.toUpperCase()} `]),
  ["owner_sent", ["OTHER", "OWNER"], true, false],
);
t(
  "VF5-4 sender id and mention id with whitespace / upper-case (non-parser writer) -> OWNER / owner mentioned, at both sites",
  [f5(askThenOwner({}, { sender: { id: ` ${OWNER.toUpperCase()} `, name: "Owner", isApp: false } }))[1], f5([tmsg(CHAT_G, "m", "2026-11-10T10:00:00Z", { mentionedUserIds: [` ${OWNER.toUpperCase()}`] })])],
  [["OTHER", "OWNER"], ["owner_mentioned", ["OTHER"], false, true]],
);
t("VF5-5 stored mentionsOwner=true alone: the facts say ownerMentioned=true, matching the owner_mentioned verdict", f5([tmsg(CHAT_G, "m", "2026-11-10T10:00:00Z", { mentionsOwner: true })])[3], true);
t("VF5-6 a null entry in a stored mention list is handled by the normal path (no fallback), and shows", f5([tmsg(CHAT_G, "m", "2026-11-10T10:00:00Z", { mentionedUserIds: [null as unknown as string] })]), ["owner_maybe_mentioned", ["OTHER"], false, null]);

// ── Finding 2: a malformed stored mention field (string / object) must not throw; it shows, and one bad row never
//    aborts the report.
const bad = (v: unknown) => ({ ...(g1[0].content as TeamsContent), mentionedUserIds: v as string[] });
const safeInv = (ms: TeamsContent[]) => {
  try {
    return chatInvolvement(CHAT_G, ms).reason;
  } catch (e) {
    return `THREW ${(e as Error).name}`;
  }
};
t("VF2-1 mentionedUserIds stored as a string or an object -> no throw, can't tell -> SHOWS", [safeInv([bad(OWNER)]), safeInv([bad({ 0: "x" })]), safeInv([bad(7)])], ["cant_tell_no_mention_data", "cant_tell_no_mention_data", "cant_tell_no_mention_data"]);
const safeHide = (ms: TeamsContent[]) => {
  try {
    return chatInvolvement(CHAT_G, ms).hide;
  } catch (e) {
    return `THREW ${(e as Error).name}`;
  }
};
t("VF2-2 anything that would throw inside the rule -> cant_tell_malformed, shows", [safeInv([null as unknown as TeamsContent]), safeHide([null as unknown as TeamsContent])], ["cant_tell_malformed", false]);
const CHAT_B = "19:group03@thread.v2";
const throwingText = { toString: () => { throw new Error("synthetic"); } } as unknown as string;
const mixedRows: LedgerReportRow[] = [
  ...g1,
  tmsg(CHAT_B, "b1", "2026-11-12T10:00:00Z", { mentionedUserIds: "not-an-array" as unknown as string[] }),
  tmsg("19:group04@thread.v2", "c1", "2026-11-12T11:00:00Z", { text: throwingText }),
];
const safeChats = (() => {
  try {
    return teamsChatsFromLedger(mixedRows);
  } catch (e) {
    return `THREW ${(e as Error).name}`;
  }
})();
const mixedPlan = typeof safeChats === "string" ? null : planLedgerReport({ emailFacts: [], teams: safeChats, meetings: [], signals: [], sinceMs: SINCE });
t(
  "VF2-3 one bad row never aborts the report: every chat comes back; the bad ones SHOW, the good uninvolved one is still hidden",
  typeof safeChats === "string" ? safeChats : [safeChats.map((c) => [c.chatId, c.involvement.reason]).sort(), mixedPlan!.teams.hiddenUninvolved.map((c) => c.chatId), mixedPlan!.teams.scan.length],
  [[[CHAT_G, "uninvolved"], [CHAT_B, "cant_tell_no_mention_data"], ["19:group04@thread.v2", "cant_tell_malformed"]].sort(), [CHAT_G], 2],
);
t(
  "VF2-4 a malformed chat is counted as can't-tell in the plan (alongside the no-mention-data one)",
  mixedPlan ? mixedPlan.teams.cantTell : "no plan",
  2,
);

// ── Owner decision 2026-11-17: a group / meeting / channel chat whose ONLY mention is a team, tag or channel mention
//    is HIDDEN; @Everyone, the owner's id, the owner writing, 1:1, and anything unreadable still SHOW. One test per
//    row of the spelling table in docs/qc-evidence/BUILD-actions-cap-tag-rule.md (Graph shapes from Graph's own docs).
//    Synthetic ids only.
const CHAT_1B = "19:ccc_ddd@unq.gbl.spaces";
const lineFor = (chatId: string, msgs: unknown[], ownerUserId: string | null = OWNER) =>
  JSON.stringify({ source: "teams", synthetic: false, chatId, ...(ownerUserId ? { ownerUserId } : {}), capturedUtc: "2026-11-10T23:00:00Z", messages: msgs });
const mk = (mentions: unknown, o: { body?: string; chatId?: string; extra?: unknown[]; ownerUserId?: string | null } = {}) => {
  const msgs = [
    pmsg("1", { body: { contentType: "html", content: o.body ?? "Please send the synthetic numbers" }, ...(mentions === undefined ? {} : { mentions }) }),
    ...(o.extra ?? []),
  ];
  const parsedMk = parseTeamsLog(lineFor(o.chatId ?? CHAT_G, msgs, o.ownerUserId === undefined ? OWNER : o.ownerUserId), cfg).messages;
  const v = chatInvolvement(o.chatId ?? CHAT_G, parsedMk.map(teamsContent));
  return `${v.hide ? "HIDE" : "SHOW"}:${v.reason}`;
};
const conv = (conversationIdentityType: unknown, id: unknown = "19:conv01@thread.v2") => ({ conversation: { id, displayName: "Synthetic", ...(conversationIdentityType === undefined ? {} : { conversationIdentityType }) } });
const one = (mentioned: unknown, id = 0) => [{ id, mentionText: "Synthetic", mentioned }];
const SHOW_MAYBE = "SHOW:owner_maybe_mentioned";
const HIDE_UN = "HIDE:uninvolved";

t("MK-R1 user mention of the owner's id -> SHOW", mk(one({ user: { id: OWNER.toUpperCase() } })), "SHOW:owner_mentioned");
t("MK-R2 user mention of another user only -> HIDE (unchanged)", mk(one({ user: { id: "user-guid-0002" } })), HIDE_UN);
t("MK-R3 user id empty / whitespace / number / user null -> SHOW", [one({ user: { id: "" } }), one({ user: { id: "  " } }), one({ user: { id: 9 } }), one({ user: null })].map((m) => mk(m)), [SHOW_MAYBE, SHOW_MAYBE, SHOW_MAYBE, SHOW_MAYBE]);
t("MK-R4 application (bot) mention -> SHOW (not covered by the decision)", mk(one({ application: { id: "app-guid-0001", displayName: "Synthetic bot" } })), SHOW_MAYBE);
t("MK-R5 @Everyone (conversation, type chat) -> SHOW", mk(one(conv("chat", CHAT_G))), SHOW_MAYBE);
t("MK-R6 team mention (conversation, type team) -> HIDE", mk(one(conv("team", "team-guid-0001"))), HIDE_UN);
t("MK-R7 channel mention (conversation, type channel) -> HIDE", mk(one(conv("channel", "19:chan01@thread.tacv2"))), HIDE_UN);
t("MK-R8 conversation type unknownFutureValue -> SHOW", mk(one(conv("unknownFutureValue"))), SHOW_MAYBE);
t("MK-R9 conversation with no conversationIdentityType -> SHOW", mk(one(conv(undefined))), SHOW_MAYBE);
t("MK-R10 team type but id empty / missing / non-string -> SHOW", [conv("team", ""), { conversation: { displayName: "Synthetic", conversationIdentityType: "team" } }, conv("team", 5)].map((x) => mk(one(x))), [SHOW_MAYBE, SHOW_MAYBE, SHOW_MAYBE]);
t("MK-R11 tag mention -> HIDE (no tag-membership data)", mk(one({ tag: { id: "tag-guid-0001", displayName: "Synthetic leads" } })), HIDE_UN);
t("MK-R12 tag with empty / missing id, or tag not an object -> SHOW", [{ tag: { id: "" } }, { tag: { displayName: "x" } }, { tag: "tag-guid-0001" }].map((x) => mk(one(x))), [SHOW_MAYBE, SHOW_MAYBE, SHOW_MAYBE]);
t(
  "MK-R13 Graph's real channel shape (Ex.8: other variants explicit null) + matching <at id=0> -> HIDE",
  mk(one({ application: null, device: null, user: null, tag: null, conversation: { id: "19:chan01@thread.tacv2", displayName: "General", conversationIdentityType: "channel" } }), { body: '<at id="0">General</at>&nbsp;Hello there!' }),
  HIDE_UN,
);
t("MK-R14 two non-null variants in one entry (tag AND conversation) -> SHOW (ambiguous)", mk(one({ tag: { id: "tag-guid-0001" }, ...conv("team", "team-guid-0001") })), SHOW_MAYBE);
t("MK-R15 device mention -> SHOW (Graph: not supported -> unreadable)", mk(one({ device: { id: "dev-0001" } })), SHOW_MAYBE);
t("MK-R16 conversationIdentityType wrong case ('Team') -> SHOW", mk(one(conv("Team", "team-guid-0001"))), SHOW_MAYBE);
t("MK-R17 body <at id=0> with NO mentions entry -> SHOW", mk([], { body: '<at id="0">Someone</at> ok?' }), SHOW_MAYBE);
t("MK-R18 body <at id=0> matched by a tag mention at id 0 -> HIDE", mk(one({ tag: { id: "tag-guid-0001" } }), { body: '<at id="0">Synthetic leads</at> ok?' }), HIDE_UN);
t("MK-R19 tag at id 0 + an unexplained <at id=1> -> SHOW", mk(one({ tag: { id: "tag-guid-0001" } }), { body: '<at id="0">Leads</at> and <at id="1">Someone</at>' }), SHOW_MAYBE);
t("MK-R20 mix: tag + the owner's user id -> SHOW (owner mentioned)", mk([...one({ tag: { id: "tag-guid-0001" } }), ...one({ user: { id: OWNER } }, 1)]), "SHOW:owner_mentioned");
t("MK-R21 mix: tag + @Everyone -> SHOW", mk([...one({ tag: { id: "tag-guid-0001" } }), ...one(conv("chat", CHAT_G), 1)]), SHOW_MAYBE);
t("MK-R22 mix: tag + application -> SHOW", mk([...one({ tag: { id: "tag-guid-0001" } }), ...one({ application: { id: "app-guid-0001" } }, 1)]), SHOW_MAYBE);
t("MK-R23 a null entry / an entry with no `mentioned` (alongside a tag) -> SHOW", [[null, ...one({ tag: { id: "tag-guid-0001" } }, 1)], [{ id: 0 }]].map((m) => mk(m)), [SHOW_MAYBE, SHOW_MAYBE]);
t("MK-R24 non-Graph shapes {team:{..}} / {channel:{..}} -> SHOW (unreadable)", [{ team: { id: "team-1" } }, { channel: { id: "chan-1" } }].map((x) => mk(one(x))), [SHOW_MAYBE, SHOW_MAYBE]);
t("MK-R25 meeting chat, team mention only -> HIDE", mk(one(conv("team", "team-guid-0001")), { chatId: CHAT_M }), HIDE_UN);
t("MK-R26 channel chat (thread.tacv2), channel mention only -> HIDE", mk(one(conv("channel", CHAT_C)), { chatId: CHAT_C }), HIDE_UN);
t("MK-N1 over-match negative: 1:1 chat with a tag mention -> SHOW", mk(one({ tag: { id: "tag-guid-0001" } }), { chatId: CHAT_1B }), "SHOW:one_on_one");
t(
  "MK-N2 over-match negative: group chat with a tag mention where the owner wrote -> SHOW",
  mk(one({ tag: { id: "tag-guid-0001" } }), { extra: [{ id: "9", createdDateTime: "2026-11-10T15:00:00Z", from: { user: { id: OWNER, displayName: "Owner" } }, body: { contentType: "text", content: "on it" }, mentions: [] }] }),
  "SHOW:owner_sent",
);
t(
  "MK-N3 over-match negative: tag-only message + a message with no mention data -> SHOW",
  mk(one({ tag: { id: "tag-guid-0001" } }), { extra: [{ id: "8", createdDateTime: "2026-11-10T15:00:00Z", from: { user: { id: "other-guid", displayName: "Pat Example" } }, body: { contentType: "text", content: "no mentions field" } }] }),
  "SHOW:cant_tell_no_mention_data",
);
t("MK-N4 over-match negative: tag-only message, owner id unknown -> SHOW", mk(one({ tag: { id: "tag-guid-0001" } }), { ownerUserId: null }), "SHOW:cant_tell_owner_unknown");

const pk = (mentions: unknown[], body?: string) => {
  const m = parseOne({ mentions, ...(body ? { body: { contentType: "html", content: body } } : {}) });
  return [m.unresolvedMention, m.chatWideMention, m.groupMentionOnly];
};
t(
  "MK-P1 parser kind flags: tag / team / @Everyone / app / user only / none",
  [pk(one({ tag: { id: "tag-guid-0001" } })), pk(one(conv("team", "team-guid-0001"))), pk(one(conv("chat", CHAT_G))), pk(one({ application: { id: "app-1" } })), pk(one({ user: { id: "user-guid-0002" } })), pk([])],
  [[true, false, true], [true, false, true], [true, true, false], [true, false, false], [false, false, false], [false, false, false]],
);
t("MK-P2 stored content carries chatWideMention and groupMentionOnly", (() => { const c = teamsContent(parseOne({ mentions: one({ tag: { id: "tag-guid-0001" } }) })); return [c.unresolvedMention, c.chatWideMention, c.groupMentionOnly]; })(), [true, false, true]);
const tagMsg = parseOne({ mentions: one({ tag: { id: "tag-guid-0001" } }) });
t("MK-H1 the content hash is unchanged by the new kind flags (nothing re-processes)", teamsSourceItem(tagMsg, { path: "/t" }).contentHash === teamsSourceItem({ ...tagMsg, chatWideMention: undefined, groupMentionOnly: undefined, unresolvedMention: undefined, mentionedUserIds: undefined }, { path: "/t" }).contentHash, true);

const st = (o: Partial<TeamsContent>) => chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent), ...o }]).reason;
t("MK-S1 stored OLD row: unresolvedMention true, no kind flags -> SHOW", st({ unresolvedMention: true }), "owner_maybe_mentioned");
t("MK-S2 stored new row: groupMentionOnly true, chatWideMention false -> HIDE", st({ unresolvedMention: true, groupMentionOnly: true, chatWideMention: false }), "uninvolved");
t("MK-S3 stored inconsistent: groupMentionOnly true AND chatWideMention true -> SHOW", st({ unresolvedMention: true, groupMentionOnly: true, chatWideMention: true }), "owner_maybe_mentioned");
t("MK-S4 stored groupMentionOnly true but chatWideMention absent -> SHOW", st({ unresolvedMention: true, groupMentionOnly: true }), "owner_maybe_mentioned");
t("MK-S5 stored groupMentionOnly true + an empty user id entry -> SHOW", st({ unresolvedMention: true, groupMentionOnly: true, chatWideMention: false, mentionedUserIds: [""] }), "owner_maybe_mentioned");
t(
  "MK-S6 two stored messages: one new tag-only, one OLD unresolved -> SHOW",
  chatInvolvement(CHAT_G, [{ ...(g1[0].content as TeamsContent), unresolvedMention: true, groupMentionOnly: true, chatWideMention: false }, { ...(g1[1].content as TeamsContent), unresolvedMention: true }]).reason,
  "owner_maybe_mentioned",
);
t("MK-S7 stored groupMentionOnly true with unresolvedMention false -> HIDE (nothing unresolved)", st({ unresolvedMention: false, groupMentionOnly: true, chatWideMention: false }), "uninvolved");
const tagChats = teamsChatsFromLedger([tagMsg].map((m) => ({ source: "teams" as const, sourceItemId: m.messageId, threadId: m.chatId, at: m.at, content: teamsContent(m) })));
const tagPlan = planLedgerReport({ emailFacts: [], teams: tagChats, meetings: [], signals: [], sinceMs: SINCE });
t(
  "MK-F1 end to end: a tag-only group chat lands in hiddenUninvolved; ownerMentioned is now false (was null)",
  [tagPlan.teams.hiddenUninvolved.length, tagPlan.teams.scan.length, tagChats[0].involvement.reason, tagChats[0].ownerMentioned],
  [1, 0, "uninvolved", false],
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
