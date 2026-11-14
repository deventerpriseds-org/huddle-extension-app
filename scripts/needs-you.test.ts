// WHAT:          Offline suite for the correspondence "needs you" redesign (part A): the per-conversation classifier
//                (lib/correspondence/needs-you.ts), the spelling tables S-A..S-E of the AC, the Teams mentions parse,
//                the new config switches, and a PIN of Iris's live email screen (inbound-email.ts must not move).
// WHY:           Owner 2026-11-14 redesign; AC docs/qc-evidence/AC-correspondence-redesign.md sections R1-R4, R6, R8, R9.
// SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/IMPL-needs-you-redesign.md.
//
// Run: bun scripts/needs-you.test.ts        ALL DATA SYNTHETIC (.example / .test addresses, made-up ids).
import { readFileSync } from "node:fs";
import {
  asksSomething,
  inboundEmailDirective,
  newTextOnly,
  screenMessage,
  type InboundEmailMode,
  type InboundMessage,
} from "../src/features/huddle/lib/email/inbound-email";
import { latestSentByConversation, mapFeedMessage, parseFeedsConfig, type FeedInboundMessage } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { messageMentions, parseTeamsLog, statedOwnerIds } from "../src/features/huddle/lib/external-feeds/teams-log";
import {
  assigneeIsOwner,
  chatKind,
  classifyChat,
  classifyEmailConversation,
  classifyEmailConversations,
  conversationIsTodoSource,
  directAsk,
  doerVerdict,
  isCalendarItem,
  isMinutesEmail,
  ownerAddressing,
  ownerAddressSet,
  parseRecipients,
  verdictCounts,
  type NeedsYouContext,
  type TodoSegment,
} from "../src/features/huddle/lib/correspondence/needs-you";
import type { SourceItem, TeamsMessage } from "../src/features/huddle/lib/correspondence/source-item";
import { conversationProposalsProcessor } from "../src/features/huddle/lib/proposals/engine";
import type { ProposalStore } from "../src/features/huddle/lib/proposals/proposals";

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const OWNER = "owner@work.example";
const MB = OWNER;
const owners = new Set([OWNER]);
const NAMES = ["Owner Name"];
const ctx = (over: Partial<NeedsYouContext> = {}): NeedsYouContext => ({
  ownerAddresses: owners,
  ownerNames: NAMES,
  latestSent: new Map(),
  sentKnown: true,
  ...over,
});
let seq = 0;
const em = (over: Partial<FeedInboundMessage> & { at?: string } = {}): FeedInboundMessage => {
  const { at, ...rest } = over;
  seq++;
  return {
    id: `feed:${MB}:m${seq}`,
    subject: "Budget numbers",
    receivedDateTime: at ?? `2026-11-10T1${seq % 10}:00:00Z`,
    bodyText: "Can you send the budget numbers?",
    fromAddress: "pat@work.example",
    fromName: "Pat Doe",
    conversationId: "conv-1",
    headerNames: [],
    precedence: null,
    autoSubmitted: null,
    toRecipients: OWNER,
    ...rest,
  };
};
const one = (m: FeedInboundMessage, c = ctx()) => classifyEmailConversation(`${MB}\u0000${m.conversationId}`, [m], c).verdict;

// ── S-A recipient strings (owner = owner@work.example) ─────────────────────────────────────────────
const reach = (to: unknown, cc?: unknown) => ownerAddressing({ toRecipients: to, ccRecipients: cc }, owners).kind;
t("S-A1 To owner -> direct", reach("owner@work.example"), "direct");
t("S-A2 To Name <owner> -> direct", reach("Owner Name <owner@work.example>"), "direct");
t("S-A3 quoted 'Name, Owner' + pat -> group, 2 addresses", [reach('"Name, Owner" <owner@work.example>; pat@work.example'), parseRecipients('"Name, Owner" <owner@work.example>; pat@work.example').addresses.length], ["group", 2]);
t("S-A4 comma-separated pat, owner -> group", reach("pat@work.example, owner@work.example"), "group");
t("S-A5 OWNER@WORK.EXAMPLE -> direct (case-insensitive)", reach("OWNER@WORK.EXAMPLE"), "direct");
t("S-A6 a list address only -> none", reach("dl-all@work.example"), "none");
t("S-A7 To pat, CC owner -> cc_only (counts for replies; OQ-3)", reach("pat@work.example", "owner@work.example"), "cc_only");
t("S-A8 To empty, CC empty (BCC) -> none no_recipients", ownerAddressing({ toRecipients: "", ccRecipients: "" }, owners), { kind: "none", reason: "no_recipients" });
t("S-A9 'Undisclosed recipients:;' -> none", ownerAddressing({ toRecipients: "Undisclosed recipients:;" }, owners), { kind: "none", reason: "no_recipients" });
t("S-A10 owner@work.example.evil.test -> none (whole address only)", reach("owner@work.example.evil.test"), "none");
t("S-A11 notowner@work.example -> none (no substring)", reach("notowner@work.example"), "none");
t("S-A12 owner+billing@ -> none unless an alias", [reach("owner+billing@work.example"), ownerAddressing({ toRecipients: "owner+billing@work.example" }, new Set([OWNER, "owner+billing@work.example"])).kind], ["none", "direct"]);
t("S-A13 address text inside a display name -> the <addr> wins -> none", reach('"owner@work.example" <pat@work.example>'), "none");
t("AC-R3.2 display name + mixed case, with others -> group", reach("Pat Doe <pat@work.example>; Owner Name <OWNER@Work.Example>"), "group");
t("AC-R3.3 quoted comma -> 2 addresses not 3", parseRecipients('"Doe, Pat" <pat@work.example>, owner@work.example').addresses, ["pat@work.example", "owner@work.example"]);
t("AC-R3.6 Graph array shape == string shape", [
  reach([{ emailAddress: { name: "Owner", address: "Owner@work.example" } }]),
  reach([{ emailAddress: { address: "pat@work.example" } }, { emailAddress: { address: OWNER } }]),
  parseRecipients([{ emailAddress: { address: "pat@work.example" } }]).addresses,
], ["direct", "group", ["pat@work.example"]]);
t("R3 a field absent on both -> unknown no_recipient_field (never not_addressed)", ownerAddressing({}, owners), { kind: "unknown", reason: "no_recipient_field" });
t("R3 owner alone on To with others on CC -> group, ownerAloneOnTo", ownerAddressing({ toRecipients: OWNER, ccRecipients: "pat@work.example" }, owners), { kind: "group", ownerAloneOnTo: true });
t("P-5 real shape: ';'-separated, no <> / quotes", parseRecipients("a@work.example;owner@work.example; b@work.example").addresses, ["a@work.example", "owner@work.example", "b@work.example"]);
t("ownerAddressSet: mailbox + logins + aliases, lower-cased", [...ownerAddressSet({ mailbox: "Owner@Work.Example", ownerLogins: ["me@eds.example"], correspondence: { ownerAliases: ["alias@work.example"] } })], [OWNER, "me@eds.example", "alias@work.example"]);

// ── R3 verdicts ─────────────────────────────────────────────────────────────────────────────────────
t("AC-R3.4 To a list only, body asks -> not_addressed", one(em({ toRecipients: "dl-all@work.example", conversationId: "c-r34" })), "not_addressed");
t("AC-R3.8 addressed to owner but List-Unsubscribe -> automated", one(em({ headerNames: ["list-unsubscribe"], conversationId: "c-r38a" })), "automated");
t("AC-R3.8 Precedence: bulk -> automated", one(em({ precedence: "bulk", conversationId: "c-r38b" })), "automated");
t("AC-R3.8 Auto-Submitted: auto-generated -> automated; 'no' -> not", [one(em({ autoSubmitted: "auto-generated", conversationId: "c-r38c" })), one(em({ autoSubmitted: "no", conversationId: "c-r38d" }))], ["automated", "needs_reply"]);
for (const h of ["x-servicenow-generated", "x-ms-exchange-organization-bulkcategory", "x-ms-engage-notification", "list-id"]) {
  t(`AC-R3.8 broadcast header ${h} -> automated (probe P-1)`, one(em({ headerNames: [h], conversationId: `c-${h}` })), "automated");
}
t("AC-R3.8 automated sender address (noreply@) -> automated", one(em({ fromAddress: "noreply@vendor.example", conversationId: "c-noreply" })), "automated");
t("AC-R3.9 owner address list empty -> cant_tell, never not_addressed / needs_reply", [
  classifyEmailConversation("k", [em({ toRecipients: "dl-all@work.example" })], ctx({ ownerAddresses: new Set() })).verdict,
  classifyEmailConversation("k", [em()], ctx({ ownerAddresses: new Set() })).verdict,
], ["cant_tell", "cant_tell"]);
t("AC-R3.7 owner on To of the FIRST message, latest non-owner message reaches him on neither -> not_addressed", classifyEmailConversation("k", [
  em({ conversationId: "c37", at: "2026-11-10T09:00:00Z", toRecipients: OWNER }),
  em({ conversationId: "c37", at: "2026-11-10T10:00:00Z", toRecipients: "pat@work.example", bodyText: "Can you also check this?" }),
], ctx()).verdict, "not_addressed");
t("R3 CC-only with an ask -> needs_reply (CC counts for the reply list)", one(em({ toRecipients: "pat@work.example", ccRecipients: OWNER, conversationId: "c-cc" })), "needs_reply");
t("R3 record without recipients fields -> cant_tell no_recipient_field", classifyEmailConversation("k", [em({ toRecipients: undefined })], ctx()).reason, "no_recipient_field");

// ── S-B / R4 invites ────────────────────────────────────────────────────────────────────────────────
const cal = (over: Partial<FeedInboundMessage>) => isCalendarItem({ subject: "Q3 review", headerNames: [], contentClass: null, ...over });
t("S-B1 Content-Class calendarmessage -> invite", cal({ contentClass: "urn:content-classes:calendarmessage" }), true);
t("S-B2 content-class value in caps (mapper lower-cases; test both)", [cal({ contentClass: "URN:CONTENT-CLASSES:CALENDARMESSAGE" }), mapFeedMessage({ id: "x", internetMessageHeaders: [{ Name: "content-class", Value: "URN:CONTENT-CLASSES:CALENDARMESSAGE" }] }, MB).contentClass], [true, "urn:content-classes:calendarmessage"]);
t("P-1 x-ms-exchange-calendar-series-instance-id -> invite", cal({ headerNames: ["x-ms-exchange-calendar-series-instance-id"] }), true);
t("P-1 x-ms-exchange-calendar-originator-id -> invite", cal({ headerNames: ["x-ms-exchange-calendar-originator-id"] }), true);
for (const s of ["Accepted: Q3 review", "Tentative: Q3 review", "Declined: Q3 review", "Canceled: Q3 review", "Cancelled: Q3 review", "New Time Proposed: Q3 review", "Invitation: Q3 review @ Tue Nov 18, 2026 10am - 11am (EST) (owner@work.example)", "Updated invitation: Q3 review @ Tue"]) {
  t(`S-B ${s.slice(0, 22)} -> invite`, cal({ subject: s }), true);
}
t("S-B10 'Re: Invitation: Q3 review' + 'Can we move it to 3pm?' -> needs_reply", one(em({ subject: "Re: Invitation: Q3 review", bodyText: "Can we move it to 3pm?", conversationId: "c-b10" })), "needs_reply");
t("S-B11 'Re: quick invite question' + 'Are you free Thursday?' -> needs_reply", one(em({ subject: "Re: quick invite question", bodyText: "Are you free Thursday?", conversationId: "c-b11" })), "needs_reply");
t("S-B12 'Invitation to speak at our panel' + 'Would you join?' -> needs_reply", one(em({ subject: "Invitation to speak at our panel", bodyText: "Would you join?", conversationId: "c-b12" })), "needs_reply");
t("S-B13 / AC-R4.6 body 'Join the meeting now', no header/subject signal -> decided normally (fyi here)", [one(em({ subject: "Q3 sync", bodyText: "Microsoft Teams meeting\nJoin the meeting now", conversationId: "c-b13" })), one(em({ subject: "Q3 sync", bodyText: "Microsoft Teams meeting\nJoin the meeting now. Can you present?", conversationId: "c-b13b" }))], ["fyi", "needs_reply"]);
t("AC-R4.1 calendar header wins over an asking body", one(em({ headerNames: ["x-ms-exchange-calendar-originator-id"], bodyText: "Can you make it?", conversationId: "c-r41" })), "invite");
t("AC-R4.7 latest non-owner message is an invite, an EARLIER real ask unanswered -> invite", classifyEmailConversation("k", [
  em({ conversationId: "c47", at: "2026-11-10T09:00:00Z", bodyText: "Can you send the numbers?" }),
  em({ conversationId: "c47", at: "2026-11-10T10:00:00Z", subject: "Accepted: Budget numbers", bodyText: "" }),
], ctx()).verdict, "invite");
t("AC-R1.5 subject 'Re: quick invite question', body 'Thanks, all set.' -> no ask (fyi)", one(em({ subject: "Re: quick invite question", bodyText: "Thanks, all set.", conversationId: "c-r15" })), "fyi");
t("AC-R4.4 / F-3: an ORIGINAL subject with the word 'invite' decides nothing", one(em({ subject: "Team invite list", bodyText: "Here is the list.", conversationId: "c-r44" })), "fyi");

// ── S-C minutes ─────────────────────────────────────────────────────────────────────────────────────
const mins = (subject: string, body = "Notes below. Dana to send the deck.", from = "pat@work.example") => isMinutesEmail({ subject, fromAddress: from }, `${body}`, NAMES);
t("S-C1 'Meeting Minutes: Budget sync Nov 14, 10:00 AM' -> minutes", mins("Meeting Minutes: Budget sync Nov 14, 10:00 AM"), true);
t("S-C2 'Updated Meeting Minutes: ...' -> minutes", mins("Updated Meeting Minutes: Budget sync"), true);
t("S-C3 a fireflies.ai sender -> minutes, any subject", [mins("Your notes", "x", "fred@fireflies.ai"), mins("Your notes", "x", "fred@mail.fireflies.ai")], [true, true]);
t("S-C3 over-match: notfireflies.ai is not the vendor", mins("Your notes", "x", "fred@notfireflies.ai"), false);
t("S-C4 'Meeting recap: Budget sync' / 'Recap of Budget sync' -> minutes", [mins("Meeting recap: Budget sync"), mins("Recap of Budget sync")], [true, true]);
t("S-C5 'Meeting notes: ...' / 'Meeting summary for ...' -> minutes", [mins("Meeting notes: Budget sync"), mins("Meeting summary for Budget sync")], [true, true]);
t("S-C6 'Fw: Meeting Minutes: ...' + 'Owner, can you take item 3 by Friday?' -> needs_reply", one(em({ subject: "Fw: Meeting Minutes: Budget sync", bodyText: "Owner, can you take item 3 by Friday?", conversationId: "c-c6" })), "needs_reply");
t("S-C7 'Summary of the budget' + 'Can you approve by Friday?' -> needs_reply", one(em({ subject: "Summary of the budget", bodyText: "Can you approve by Friday?", conversationId: "c-c7" })), "needs_reply");
t("AC-R5.1 a minutes email with an asking recap body but no DIRECT ask -> minutes", one(em({ subject: "Meeting notes: Budget sync", bodyText: "Thank you all for attending. Please find the notes below. Open question: who owns the budget?", conversationId: "c-r51" })), "minutes");
t("S-C over-match: forwarded minutes with no question -> minutes", one(em({ subject: "Fw: Meeting notes: Budget sync", bodyText: "FYI", conversationId: "c-fwmin" })), "minutes");
t("S-C: an ordinary subject that merely contains 'summary' is not minutes", mins("Q3 summary numbers"), false);
t("directAsk: 'thank you' is not 'you'; a quoted old question does not count", [directAsk("Thank you, please see below.", NAMES), directAsk("Sounds good.\n> Can you send it?", NAMES), directAsk("Owner Name, could we get this by Friday?", NAMES)], [false, false, true]);

// ── R2 one item per conversation ────────────────────────────────────────────────────────────────────
{
  const thread = [
    em({ conversationId: "c21", at: "2026-11-10T09:00:00Z", fromAddress: "a@work.example", bodyText: "Can you review the plan?" }),
    em({ conversationId: "c21", at: "2026-11-10T10:00:00Z", fromAddress: "b@work.example", subject: "Re: Budget numbers", bodyText: "+1" }),
    em({ conversationId: "c21", at: "2026-11-10T11:00:00Z", fromAddress: "a@work.example", subject: "Re: Budget numbers", bodyText: "Any update? Can you confirm?" }),
    em({ conversationId: "c21", at: "2026-11-10T12:00:00Z", fromAddress: "c@work.example", subject: "Re: Budget numbers", bodyText: "thanks" }),
  ];
  const vs = classifyEmailConversations(MB, thread, ctx());
  t("AC-R2.1 4 messages, one conversationId -> ONE item", vs.length, 1);
  t("AC-R2.2 decided on the LATEST non-owner message ('thanks') -> fyi", vs[0].verdict, "fyi");
}
t("AC-R2.3 A asks, B (not owner) answers with no new ask -> fyi", classifyEmailConversation("k", [
  em({ conversationId: "c23", at: "2026-11-10T09:00:00Z", bodyText: "Can you send the file?" }),
  em({ conversationId: "c23", at: "2026-11-10T10:00:00Z", fromAddress: "b@work.example", subject: "Re: Budget numbers", bodyText: "Sent it over just now." }),
], ctx()).verdict, "fyi");
t("AC-R2.4 a later Sent Items message in the conversation -> replied", classifyEmailConversation("k", [em({ conversationId: "c24", at: "2026-11-10T09:00:00Z" })], ctx({ latestSent: latestSentByConversation([{ conversationId: "c24", sentAt: "2026-11-10T10:00:00.000Z" }]) })).verdict, "replied");
t("AC-R2.4 an EARLIER Sent Items message does not settle", classifyEmailConversation("k", [em({ conversationId: "c24b", at: "2026-11-10T09:00:00Z" })], ctx({ latestSent: latestSentByConversation([{ conversationId: "c24b", sentAt: "2026-11-10T08:00:00.000Z" }]) })).verdict, "needs_reply");
{
  const v = classifyEmailConversation("k", [
    em({ id: "feed:x:t1", conversationId: "c25", at: "2026-11-10T09:00:00Z", bodyText: "Can you send the file?" }),
    em({ id: "feed:x:t3", conversationId: "c25", at: "2026-11-10T11:00:00Z", fromAddress: "b@work.example", subject: "Re: Budget numbers", bodyText: "New question: can you join Friday?" }),
  ], ctx({ latestSent: latestSentByConversation([{ conversationId: "c25", sentAt: "2026-11-10T10:00:00.000Z" }]) }));
  t("AC-R2.5 ask, owner sends, NEW ask after -> needs_reply on the t3 message", [v.verdict, v.deciding?.id], ["needs_reply", "feed:x:t3"]);
}
t("AC-R2.6 owner's own reply in the INBOX settles earlier asks", classifyEmailConversation("k", [
  em({ conversationId: "c26", at: "2026-11-10T09:00:00Z" }),
  em({ conversationId: "c26", at: "2026-11-10T10:00:00Z", fromAddress: "Owner@Work.Example", subject: "Re: Budget numbers", bodyText: "Here they are." }),
], ctx({ sentKnown: false })).verdict, "replied");
t("AC-R2.7 no usable Sent Items + would be needs_reply -> cant_tell no_sent_items", [classifyEmailConversation("k", [em({ conversationId: "c27" })], ctx({ sentKnown: false })).verdict, classifyEmailConversation("k", [em({ conversationId: "c27" })], ctx({ sentKnown: false })).reason], ["cant_tell", "no_sent_items"]);
t("AC-R2.8 a zoneless received time is read as UTC (sent 10:30Z settles a 10:00 zoneless receipt; sent 09:30Z does not)", [
  classifyEmailConversation("k", [em({ conversationId: "c28", receivedDateTime: "2026-11-10T10:00:00" })], ctx({ latestSent: new Map([["c28", Date.parse("2026-11-10T10:30:00Z")]]) })).verdict,
  classifyEmailConversation("k", [em({ conversationId: "c28", receivedDateTime: "2026-11-10T10:00:00" })], ctx({ latestSent: new Map([["c28", Date.parse("2026-11-10T09:30:00Z")]]) })).verdict,
], ["replied", "needs_reply"]);
t("AC-R2.13 a forward with a NEW conversationId is its own conversation (grouping by id, never subject)", classifyEmailConversations(MB, [em({ conversationId: "orig", subject: "Plan" }), em({ conversationId: "fwd", subject: "Fw: Plan" })], ctx()).length, 2);
t("R2 no conversationId -> its own conversation keyed by message id", classifyEmailConversations(MB, [em({ conversationId: null }), em({ conversationId: null })], ctx()).map((c) => c.key.includes(":msg:")), [true, true]);

// ── Teams: mentions (S-D), chat kind (S-E), chat verdicts (R2.10-2.12, OQ-5) ───────────────────────
const OID = "aaaa-owner";
const ownerSet = new Set([OID]);
t("S-D1 mention of the owner's user id -> owner true", messageMentions({ mentions: [{ mentioned: { user: { id: OID } } }] }, ownerSet), { owner: true, other: false });
t("S-D2 id in a different case -> true", messageMentions({ mentions: [{ mentioned: { user: { id: OID.toUpperCase() } } }] }, ownerSet)?.owner, true);
t("S-D3 another user -> owner false, other true", messageMentions({ mentions: [{ mentioned: { user: { id: "bbbb" } } }] }, ownerSet), { owner: false, other: true });
t("S-D4 a conversation (whole chat) mention -> owner false", messageMentions({ mentions: [{ mentioned: { conversation: { id: "19:aaaa@thread.v2" } } }] }, ownerSet)?.owner, false);
t("S-D5 a tag mention -> owner false", messageMentions({ mentions: [{ mentioned: { tag: { id: "tag-1" } } }] }, ownerSet)?.owner, false);
t("S-D6 body '@Owner' with NO mentions array -> null (unknown), not true", messageMentions({ body: { content: "@Owner can you?" } }, ownerSet), null);
t("S-D owner ids not configured -> owner null", messageMentions({ mentions: [{ mentioned: { user: { id: OID } } }] }, new Set())?.owner, null);
{
  const line = (msgs: unknown[]) => JSON.stringify({ source: "teams", synthetic: false, chatId: "19:aaaa_bbbb@unq.gbl.spaces", capturedUtc: "2026-11-10T23:00:00Z", messages: msgs });
  const cfgT = { synthetic: false, subjectPrefix: undefined, notBeforeUtc: undefined, teams: { source: "teams", ownerSenderIds: [OID] } };
  const p = parseTeamsLog([
    line([{ id: "1", timestamp: "2026-11-10T10:00:00Z", from: { user: { id: "pat", displayName: "Pat" } }, body: { content: "Can you look?", contentType: "text" }, mentions: [{ mentioned: { user: { id: OID } } }] }]),
    line([{ id: "2", timestamp: "2026-11-10T10:01:00Z", from: { user: { id: "pat", displayName: "Pat" } }, body: { content: "No mentions key", contentType: "text" } }]),
  ].join("\n"), cfgT);
  t("AC-R3.11 parser sets mentionsOwner true from a Graph mention", p.messages.find((m) => m.messageId === "1")?.mentionsOwner, true);
  t("AC-R3.12 no mentions array -> the field is ABSENT (unknown), existing message shape unchanged", "mentionsOwner" in (p.messages.find((m) => m.messageId === "2") ?? {}), false);
}
t("statedOwnerIds: one agreeing value -> it; disagreeing -> none", [statedOwnerIds('{"ownerUserId":"A"}\n{"ownerUserId":"a"}').ids, statedOwnerIds('{"ownerUserId":"a"}\n{"ownerUserId":"b"}')], [["a"], { ids: [], disagree: 2 }]);
t("S-E1 19:<g>_<g>@unq.gbl.spaces -> one_to_one", chatKind("19:aaaa_bbbb@unq.gbl.spaces", 1), "one_to_one");
t("S-E2 19:<hex>@thread.v2, 3 non-owner senders -> group", chatKind("19:abcdef@thread.v2", 3), "group");
t("S-E3 19:meeting_<id>@thread.v2 -> meeting_chat", chatKind("19:meeting_abc@thread.v2", 5), "meeting_chat");
t("S-E4 19:<hex>@thread.v2, 1 non-owner sender -> unknown (not one_to_one)", chatKind("19:abcdef@thread.v2", 1), "unknown");
t("S-E5 @thread.tacv2 -> channel", chatKind("19:abc@thread.tacv2", 4), "channel");

let tid = 0;
const tm = (chatId: string, over: Partial<TeamsMessage> = {}): TeamsMessage => ({
  chatId,
  messageId: `t${++tid}`,
  at: `2026-11-10T10:${String(tid % 60).padStart(2, "0")}:00.000Z`,
  senderId: "pat",
  senderName: "Pat",
  senderIsApp: false,
  fromOwner: false,
  text: "Can you look at this?",
  ...over,
});
const ONE = "19:aaaa_bbbb@unq.gbl.spaces";
const GRP = "19:abcdef@thread.v2";
const MTG = "19:meeting_abc@thread.v2";
const owner = (chatId: string, over: Partial<TeamsMessage> = {}) => tm(chatId, { senderId: OID, senderName: "Owner", fromOwner: true, text: "On it.", ...over });
t("AC-R2.10 3 asks in a row in a 1:1, owner present earlier -> ONE needs_reply, the newest ask", (() => {
  const msgs = [owner(ONE), tm(ONE), tm(ONE), tm(ONE, { text: "Third: can you confirm?" })];
  const v = classifyChat(ONE, msgs, { ownerNames: NAMES });
  return [v.verdict, v.deciding?.id === msgs[3].messageId];
})(), ["needs_reply", true]);
t("AC-R2.11 owner posted after the last ask -> replied", classifyChat(ONE, [tm(ONE), owner(ONE)], { ownerNames: NAMES }).verdict, "replied");
t("AC-R2.12 a chat where the log has NO owner message -> cant_tell owner_messages (never a constant 'true')", [classifyChat(ONE, [tm(ONE)], { ownerNames: NAMES }).verdict, classifyChat(ONE, [tm(ONE)], { ownerNames: NAMES }).reason], ["cant_tell", "owner_messages"]);
t("AC-R3.10 a 1:1 chat ask is addressed (not not_addressed)", classifyChat(ONE, [owner(ONE), tm(ONE)], { ownerNames: NAMES }).verdict, "needs_reply");
t("OQ-5 group chat, 2 other people, no mention -> needs_reply", classifyChat(GRP, [owner(GRP), tm(GRP, { senderId: "p1" }), tm(GRP, { senderId: "p2", text: "Can you review?" })], { ownerNames: NAMES }).verdict, "needs_reply");
t("OQ-5 group chat, 3 other people, no mention -> fyi", classifyChat(GRP, [owner(GRP), tm(GRP, { senderId: "p1" }), tm(GRP, { senderId: "p3" }), tm(GRP, { senderId: "p2", text: "Can you review?" })], { ownerNames: NAMES }).verdict, "fyi");
t("OQ-5 group chat, 3 other people, ask @mentions the owner -> needs_reply", classifyChat(GRP, [owner(GRP), tm(GRP, { senderId: "p1" }), tm(GRP, { senderId: "p3" }), tm(GRP, { senderId: "p2", text: "Can you review?", mentionsOwner: true })], { ownerNames: NAMES }).verdict, "needs_reply");
t("OQ-5 group chat, 2 other people, ask @mentions SOMEONE ELSE -> fyi", classifyChat(GRP, [owner(GRP), tm(GRP, { senderId: "p1" }), tm(GRP, { senderId: "p2", text: "Can you review?", mentionsOwner: false, mentionsOther: true })], { ownerNames: NAMES }).verdict, "fyi");
t("OQ-5 meeting chat, ask with no mention and no name -> fyi", classifyChat(MTG, [owner(MTG), tm(MTG, { text: "Can someone send the deck?" })], { ownerNames: NAMES }).verdict, "fyi");
t("OQ-5 meeting chat, ask names the owner's first name -> needs_reply", classifyChat(MTG, [owner(MTG), tm(MTG, { text: "Owner, can you send the deck?" })], { ownerNames: ["Owner Name", "Owner"] }).verdict, "needs_reply");
t("OQ-5 meeting chat, ask @mentions the owner -> needs_reply", classifyChat(MTG, [owner(MTG), tm(MTG, { text: "Can you send the deck?", mentionsOwner: true })], { ownerNames: NAMES }).verdict, "needs_reply");
t("OQ-5 over-match: a first name inside another word does not count", classifyChat(MTG, [owner(MTG), tm(MTG, { text: "Can the Owners group send it?" })], { ownerNames: ["Owner"] }).verdict, "fyi");
t("S-C8 a Teams app recap in a meeting chat -> minutes", classifyChat(MTG, [tm(MTG, { senderIsApp: true, senderId: "app", text: "Meeting recap: decisions and action items" })], { ownerNames: NAMES }).verdict, "minutes");

// ── Counts / reconciliation (AC-R7.5/7.6) ──────────────────────────────────────────────────────────
{
  const vs = classifyEmailConversations(MB, [em({ conversationId: "k1" }), em({ conversationId: "k2", toRecipients: "dl@work.example" }), em({ conversationId: "k3", headerNames: ["list-id"] }), em({ conversationId: "k4", bodyText: "fyi" })], ctx());
  const c = verdictCounts(vs);
  t("AC-R7.6 sum of every verdict count == number of conversations", Object.values(c.byVerdict).reduce((a, b) => a + b, 0), c.total);
  t("AC-R7.5 counts by verdict and reason NAMES only", [c.byVerdict.needs_reply, c.byVerdict.not_addressed, c.byVerdict.automated, c.byVerdict.fyi, c.byReason], [1, 1, 1, 1, { "not_addressed:not_on_recipients": 1, "automated:bulk_header": 1 }]);
}

// ── To-dos: owner as doer (AC-R6) ──────────────────────────────────────────────────────────────────
const seg = (over: Partial<TodoSegment> = {}): TodoSegment => ({ text: "x", fromOwner: false, reach: "direct", ownerAloneOnTo: true, mentionsOwner: false, ...over });
t("AC-R6.1 verdicts never a to-do source: not_addressed / automated / invite / minutes", ["not_addressed", "automated", "invite", "minutes", "needs_reply", "fyi", "replied"].map((v) => conversationIsTodoSource({ verdict: v as never, reason: null })), [false, false, false, false, true, true, true]);
t("AC-R6.1 cant_tell for missing Sent Items is still a to-do source; for no owner address it is not", [conversationIsTodoSource({ verdict: "cant_tell", reason: "no_sent_items" }), conversationIsTodoSource({ verdict: "cant_tell", reason: "no_owner_address" })], [true, false]);
t("AC-R6.3 grounded assignee who is NOT the owner -> assigned_to_other", doerVerdict({ assignee: "Dana", evidence: "Dana will send the deck by Friday" }, seg(), NAMES), "assigned_to_other");
t("AC-R6.4 assignee null in a direct email -> keep; in a 1:1 chat -> keep", [doerVerdict({ assignee: null, evidence: "Please send the deck by Friday" }, seg(), NAMES), doerVerdict({ assignee: null, evidence: "Please send the deck by Friday" }, seg({ reach: "one_to_one" }), NAMES)], ["keep", "keep"]);
t("AC-R6.5 assignee null in a group email: 'you' + owner alone on To -> keep; else doer_unclear", [
  doerVerdict({ assignee: null, evidence: "Can you send the deck by Friday" }, seg({ reach: "group", ownerAloneOnTo: true }), NAMES),
  doerVerdict({ assignee: null, evidence: "Can you send the deck by Friday" }, seg({ reach: "group", ownerAloneOnTo: false }), NAMES),
  doerVerdict({ assignee: null, evidence: "Send the deck by Friday please" }, seg({ reach: "group", ownerAloneOnTo: true }), NAMES),
], ["keep", "doer_unclear", "doer_unclear"]);
t("AC-R6.5 group chat: @mention of the owner -> keep; none -> doer_unclear", [doerVerdict({ assignee: null, evidence: "Can you send the deck" }, seg({ reach: "group", mentionsOwner: true }), NAMES), doerVerdict({ assignee: null, evidence: "Can you send the deck" }, seg({ reach: "group", ownerAloneOnTo: false }), NAMES)], ["keep", "doer_unclear"]);
t("OQ-3 CC-only: not a to-do unless the owner is named", [doerVerdict({ assignee: null, evidence: "Can you send the deck by Friday" }, seg({ reach: "cc_only" }), NAMES), doerVerdict({ assignee: null, evidence: "Owner Name can you send the deck" }, seg({ reach: "cc_only" }), NAMES)], ["doer_unclear", "keep"]);
t("AC-R6.6 owner's own first-person commitment -> keep; an instruction from the owner -> not_owner_commitment", [doerVerdict({ assignee: null, evidence: "I'll send the deck Friday" }, seg({ fromOwner: true }), NAMES), doerVerdict({ assignee: null, evidence: "Dana please send the deck" }, seg({ fromOwner: true }), NAMES)], ["keep", "not_owner_commitment"]);
t("AC-R6.7 assignee equal to the owner's full or first name (config) -> owner", [assigneeIsOwner("Owner Name", NAMES), assigneeIsOwner("owner", NAMES), assigneeIsOwner("Dana", NAMES), assigneeIsOwner("Owner", [])], [true, true, false, false]);

// ── Config switches (AC-R9.1) ───────────────────────────────────────────────────────────────────────
const base = { enabled: true, ownerLogins: ["me@eds.example"], driveUser: "drive@eds.example", mailbox: MB, synthetic: false };
const cc = (c: unknown) => parseFeedsConfig(JSON.stringify({ ...base, correspondence: c }))!.correspondence;
t("AC-R9.1 conversations / emailBell OFF unless literally true (absent, 'true', 1, false)", [undefined, "true", 1, false, true].map((v) => [cc({ conversations: v }).conversations, cc({ emailBell: v }).emailBell]), [[false, false], [false, false], [false, false], [false, false], [true, true]]);
t("OQ-4 ownerAliases: whole addresses only, lower-cased; ownerNames from config", [cc({ ownerAliases: ["Alias@Work.Example", "not an address", 3] }).ownerAliases, cc({ ownerNames: ["Owner Name", "", "O"] }).ownerNames], [["alias@work.example"], ["Owner Name"]]);

// ── P: PIN of Iris's live email screen (owner: "must NOT change"; AC-R1.1/1.2/1.4/1.5) ─────────────
// A fixed fixture of synthetic messages covering the S-A..S-D rows, run through screenMessage in all three modes,
// asksSomething, newTextOnly and the alert directive. The snapshot is committed (scripts/fixtures/needs-you-pin.json);
// any change to the live behaviour fails here. Extra mapper fields (toRecipients...) must change nothing.
const pinMsgs: InboundMessage[] = [];
const subjects = ["Budget numbers", "Re: Budget numbers", "Fw: Meeting Minutes: Budget sync", "Accepted: Q3 review", "Invitation: Q3 review", "Updated invitation: Q3", "Meeting request: sync", "Re: quick invite question", "Team invite list", "Invitation to speak at our panel", "Summary of the budget", "Meeting recap: Budget sync", "Q3 review", "Canceled: Q3 review"];
const bodies = ["Can you send the numbers?", "Thanks, all set.", "Owner, can you take item 3 by Friday?", "Microsoft Teams meeting\nJoin the meeting now", "Sounds good.\n> Can you send it?\nOn Mon, Nov 10, 2026 at 9:14 AM Dana <dana@work.example> wrote:\n> old", "Please review", "FYI only"];
const froms = ["pat@work.example", "noreply@vendor.example", OWNER, "fred@fireflies.ai"];
let pi = 0;
for (const s of subjects) for (const b of bodies) {
  pi++;
  pinMsgs.push({ id: `pin-${pi}`, subject: s, bodyText: b, fromAddress: froms[pi % froms.length], fromName: "Pat", conversationId: `pc-${pi % 5}`, receivedDateTime: "2026-11-10T10:00:00Z", headerNames: pi % 7 === 0 ? ["list-unsubscribe"] : pi % 11 === 0 ? ["x-ms-exchange-calendar-originator-id"] : [], precedence: pi % 13 === 0 ? "bulk" : null, autoSubmitted: pi % 17 === 0 ? "auto-generated" : null, inferenceClassification: pi % 19 === 0 ? "other" : undefined });
}
const MODES: InboundEmailMode[] = ["needs-reply", "people", "all"];
const pinOf = (msgs: InboundMessage[]) => msgs.map((m) => ({ id: m.id, screen: MODES.map((mode) => screenMessage(m, mode, OWNER)), asks: asksSomething(m), newText: newTextOnly(m.bodyText ?? ""), directive: inboundEmailDirective(m, "Mon 10:00") }));
const pinNow = pinOf(pinMsgs);
const PIN_FILE = new URL("./fixtures/needs-you-pin.json", import.meta.url).pathname;
if (process.env.NEEDS_YOU_WRITE_PIN === "1") {
  (await import("node:fs")).writeFileSync(PIN_FILE, JSON.stringify(pinNow, null, 1));
  console.log(`wrote pin snapshot (${pinNow.length} messages)`);
}
const pinSaved = JSON.parse(readFileSync(PIN_FILE, "utf8"));
t(`AC-R1.2 PIN: screenMessage x3 modes, asksSomething, newTextOnly, directive identical on ${pinMsgs.length} synthetic messages`, JSON.stringify(pinNow) === JSON.stringify(pinSaved), true);
t("AC-R1.2 PIN fixture covers >= 40 messages", pinMsgs.length >= 40, true);
const withExtras = pinMsgs.map((m, i) => ({ ...m, toRecipients: i % 2 ? OWNER : "dl@work.example", ccRecipients: "pat@work.example", contentClass: i % 3 ? "urn:content-classes:calendarmessage" : null }));
t("AC-R1.4 the optional mapper fields change NO live verdict, ask or directive", JSON.stringify(pinOf(withExtras)) === JSON.stringify(pinSaved), true);
{
  const src = readFileSync(new URL("../src/features/huddle/lib/correspondence/needs-you.ts", import.meta.url).pathname, "utf8").replace(/\/\/.*$/gm, "");
  t("AC-R1.5 the classifier never calls screenMessage and never hands a subject to asksSomething", [/screenMessage\s*\(/.test(src), /asksSomething\(\{\s*subject:\s*""/.test(src), (src.match(/asksSomething\(/g) ?? []).length], [false, true, 1]);
  const prev = readFileSync(new URL("../scripts/proposals-preview.ts", import.meta.url).pathname, "utf8").replace(/\/\/.*$/gm, "");
  t("AC-R1.6 the preview no longer decides 'open' with screenMessage / INBOUND_EMAIL_MODE_DEFAULT", [/screenMessage/.test(prev), /INBOUND_EMAIL_MODE_DEFAULT/.test(prev)], [false, false]);
}
t("mapFeedMessage: a record without the new fields maps with NO new keys (exactly as before)", Object.keys(mapFeedMessage({ id: "x", subject: "s" }, MB)).filter((k) => ["toRecipients", "ccRecipients", "contentClass"].includes(k)), []);
t("mapFeedMessage: carries toRecipients / ccRecipients when present", [mapFeedMessage({ id: "x", toRecipients: "a@work.example;b@work.example", ccRecipients: "" }, MB).toRecipients, mapFeedMessage({ id: "x", ccRecipients: "" }, MB).ccRecipients], ["a@work.example;b@work.example", ""]);

// ── Q: the per-conversation proposals processor (AC-R6.1/6.2/6.3/6.6/6.8/6.9) ──────────────────────
{
  type Up = Parameters<ProposalStore["upsert"]>[0];
  const memProps = () => {
    const rows: Up[] = [];
    const refs = new Map<string, string>();
    const store = {
      rows,
      async upsert(p: Up) {
        const rk = [p.ref.source, p.ref.sourceItemId, p.normTitle].join("|");
        if (refs.has(rk)) return { kind: "seen" as const, id: refs.get(rk)! };
        rows.push(p);
        refs.set(rk, p.id);
        return { kind: "created" as const, id: p.id };
      },
      async priorRelated() {
        return [];
      },
    };
    return store as unknown as ProposalStore & { rows: Up[] };
  };
  const eItem = (m: FeedInboundMessage): SourceItem => ({ source: "email", sourceItemId: m.id.replace(/^feed:/, ""), identityBasis: "provider_id", threadId: m.conversationId ?? null, at: m.receivedDateTime ?? null, contentHash: "h", drivePath: null, driveItemId: null, fileEtag: null, internetMessageId: null, email: m });
  const tItem = (m: TeamsMessage): SourceItem => ({ source: "teams", sourceItemId: `${m.chatId}:${m.messageId}`, identityBasis: "provider_id", threadId: m.chatId, at: m.at, contentHash: "h", drivePath: null, driveItemId: null, fileEtag: null, internetMessageId: null, teams: m });
  // The stub model returns the to-dos it is told to, with evidence copied from the input when present.
  const stubModel = (tasks: Array<{ task: string; evidence: string; assignee: string | null }>) => {
    const calls: string[] = [];
    const extract = async (_i: string, input: string) => {
      calls.push(input);
      return { tasks: tasks.filter((x) => input.includes(x.evidence)).map((x) => ({ ...x, due_text: null })) };
    };
    return { calls, extract };
  };
  const runProc = async (items: SourceItem[], tasks: Parameters<typeof stubModel>[0], c = ctx()) => {
    const store = memProps();
    const model = stubModel(tasks);
    const proc = conversationProposalsProcessor({ store, extract: model.extract, openTitles: async () => null, tz: "America/New_York", owner: () => "me@eds.example", mailbox: () => MB, needsYou: async () => c });
    for (const it of items) await proc.process(it, { owner: "me@eds.example", nowMs: 0, batch: items });
    return { store, model };
  };
  const conv = [
    em({ conversationId: "q1", at: "2026-11-10T09:00:00Z", fromAddress: "a@work.example", bodyText: "Please send the quarterly budget deck by Friday." }),
    em({ conversationId: "q1", at: "2026-11-10T10:00:00Z", fromAddress: "b@work.example", subject: "Re: Budget numbers", bodyText: "Dana will update the hiring plan spreadsheet." }),
    em({ conversationId: "q1", at: "2026-11-10T11:00:00Z", fromAddress: "a@work.example", subject: "Re: Budget numbers", bodyText: "Also please review the vendor contract draft." }),
  ];
  const TASKS = [
    { task: "Send the quarterly budget deck", evidence: "Please send the quarterly budget deck by Friday", assignee: null },
    { task: "Update the hiring plan spreadsheet", evidence: "Dana will update the hiring plan spreadsheet", assignee: "Dana" },
    { task: "Review the vendor contract draft", evidence: "please review the vendor contract draft", assignee: null },
  ];
  const r1 = await runProc(conv.map(eItem), TASKS);
  t("AC-R6.2 3 messages of ONE conversation -> ONE extraction call", r1.model.calls.length, 1);
  t("AC-R6.3 the item assigned to Dana is dropped; the owner's two remain", r1.store.rows.map((r) => r.title).sort(), ["Review the vendor contract draft", "Send the quarterly budget deck"]);
  t("AC-R6.8 every to-do shares ONE source_item_id = the conversation key", [...new Set(r1.store.rows.map((r) => r.ref.sourceItemId))], [`${MB}:conv:q1`]);
  const again = await (async () => {
    const store = r1.store;
    const proc = conversationProposalsProcessor({ store, extract: stubModel(TASKS).extract, openTitles: async () => null, tz: "America/New_York", owner: () => "me@eds.example", mailbox: () => MB, needsYou: async () => ctx() });
    const items = [...conv, em({ conversationId: "q1", at: "2026-11-10T12:00:00Z", fromAddress: "a@work.example", subject: "Re: Budget numbers", bodyText: "thanks" })].map(eItem);
    for (const it of items) await proc.process(it, { owner: "me@eds.example", nowMs: 0, batch: items });
    return store.rows.length;
  })();
  t("AC-R6.9 re-processing the conversation after a new message re-proposes nothing (refs keyed on the conversation)", again, 2);
  for (const [label, m] of [
    ["not_addressed", em({ conversationId: "q2", toRecipients: "dl-all@work.example", bodyText: "Please send the quarterly budget deck by Friday." })],
    ["automated", em({ conversationId: "q3", headerNames: ["list-unsubscribe"], bodyText: "Please send the quarterly budget deck by Friday." })],
    ["invite", em({ conversationId: "q4", headerNames: ["x-ms-exchange-calendar-originator-id"], bodyText: "Please send the quarterly budget deck by Friday." })],
    ["minutes", em({ conversationId: "q5", subject: "Meeting Minutes: Budget sync", bodyText: "Please send the quarterly budget deck by Friday." })],
  ] as const) {
    const r = await runProc([eItem(m)], TASKS);
    t(`AC-R6.1 a ${label} conversation -> ZERO extraction calls`, r.model.calls.length, 0);
  }
  const own = await runProc([eItem(em({ conversationId: "q6", fromAddress: OWNER, toRecipients: "pat@work.example", bodyText: "I'll send the deck Friday to the whole team." }))], [{ task: "Send the deck", evidence: "I'll send the deck Friday to the whole team", assignee: null }]);
  t("AC-R6.6 the owner's own first-person commitment is a source and is proposed", own.store.rows.map((r) => r.title), ["Send the deck"]);
  const ccOnly = await runProc([eItem(em({ conversationId: "q7", toRecipients: "pat@work.example", ccRecipients: OWNER, bodyText: "Can you send the quarterly budget deck by Friday?" }))], [{ task: "Send the quarterly budget deck", evidence: "Can you send the quarterly budget deck by Friday", assignee: null }]);
  t("OQ-3 CC-only: extraction runs (reply list) but the unnamed to-do is NOT proposed (doer_unclear)", [ccOnly.model.calls.length, ccOnly.store.rows.length], [1, 0]);
  const replied = await runProc([eItem(em({ conversationId: "q8", fromAddress: OWNER, toRecipients: "pat@work.example", at: "2026-11-10T12:00:00Z", bodyText: "I will send the signed contract tomorrow morning." })), eItem(em({ conversationId: "q8", at: "2026-11-10T09:00:00Z", bodyText: "Can you sign the contract?" }))], [{ task: "Send the signed contract", evidence: "I will send the signed contract tomorrow morning", assignee: null }]);
  t("AC-R6.10 a commitment in a thread now 'replied' is still proposed", replied.store.rows.length, 1);
  const chat = [owner(ONE, { text: "Sure." }), tm(ONE, { text: "Please send the quarterly budget deck by Friday." }), tm(ONE, { text: "And please review the vendor contract draft." })];
  const tr = await runProc(chat.map(tItem), TASKS);
  t("AC-R6.2/6.4 a 1:1 chat: ONE extraction, null-assignee asks kept for the owner", [tr.model.calls.length, tr.store.rows.length, tr.store.rows[0]?.ref.sourceItemId], [1, 2, ONE]);
  const big = [owner(GRP), tm(GRP, { senderId: "p1" }), tm(GRP, { senderId: "p3" }), tm(GRP, { senderId: "p2", text: "Please send the quarterly budget deck by Friday." })];
  const gr = await runProc(big.map(tItem), TASKS);
  t("AC-R6.5 a group chat (3 others), no @mention: extraction runs (fyi chat) but the doer is unclear -> not proposed", gr.store.rows.length, 0);
}

// ── Z: zero-call when the switch is OFF (AC-R9.2) ──────────────────────────────────────────────────
{
  const src = readFileSync(new URL("../src/features/huddle/lib/proposals/proposals.server.ts", import.meta.url).pathname, "utf8");
  t("AC-R9.2 the conversation processor is only built behind correspondence.conversations === true; else the original processor", [/if \(cfg\.correspondence\.conversations === true\) \{[\s\S]*conversationProposalsProcessor\(/.test(src), /return proposalsProcessor\(\{ \.\.\.d, owner/.test(src)], [true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
