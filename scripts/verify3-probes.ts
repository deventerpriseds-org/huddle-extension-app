// WHAT:       Verifier loop-3 probes for claude_task-proposals (flags, live email HTML path, newTextOnly,
//             real Teams Graph shape, empty-skip, capture coverage, sent.json contract, conversationId settle).
// WHY:        Independent verification; each probe prints PROBE <id> <observed> so the report quotes output.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-3.md
// Synthetic .example data only (public repo).
import {
  parseFeedsConfig,
  htmlToText,
  mapFeedMessage,
  validateSentSnapshot,
  mapSentRecords,
  latestSentByConversation,
  sentReplySettles,
  validateEmailSnapshot,
} from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { parseTeamsLog, captureCoverage, teamsParseNote } from "../src/features/huddle/lib/external-feeds/teams-log";
import { newTextOnly } from "../src/features/huddle/lib/email/inbound-email";
import { decideChatThread } from "../src/features/huddle/lib/correspondence/bell";
import { activeProcessors, runIngestPass } from "../src/features/huddle/lib/correspondence/ingest-pass";

const P = (id: string, v: unknown) => console.log(`PROBE ${id} ${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`);

// ---------------------------------------------------------------- (c) flags
const base = {
  enabled: true,
  ownerLogins: ["owner@huddle.example"],
  driveUser: "owner@work.example",
  mailbox: "owner@work.example",
  synthetic: false,
};
const variants: [string, unknown][] = [
  ["absent", undefined],
  ["false", false],
  ['"true"', "true"],
  ["0", 0],
  ["null", null],
  ["[]", []],
  ["[{}]", [{}]],
  ["{}", {}],
  ["true", true],
  ['{"enabled":"false"}', { enabled: "false" }],
  ['{"enabled":0}', { enabled: 0 }],
  ['{"enabled":false}', { enabled: false }],
  ['"on"', "on"],
  ["1", 1],
];
for (const key of ["teams", "sent"] as const) {
  for (const [label, v] of variants) {
    const j: Record<string, unknown> = { ...base };
    if (v !== undefined) j[key] = v;
    const c = parseFeedsConfig(JSON.stringify(j));
    P(`C-${key}=${label}`, c ? { enabled: c[key].enabled, path: c[key].path } : null);
  }
}
for (const [label, v] of variants) {
  const j: Record<string, unknown> = { ...base };
  if (v !== undefined) j.correspondence = v;
  const c = parseFeedsConfig(JSON.stringify(j));
  P(`C-correspondence=${label}`, c ? { ingest: c.correspondence.ingest, bell: c.correspondence.bell, proposals: c.correspondence.proposals } : null);
}
for (const [label, v] of variants) {
  const j: Record<string, unknown> = { ...base, correspondence: { ingest: v, bell: v, proposals: v } };
  const c = parseFeedsConfig(JSON.stringify(j));
  P(`C-correspondence.flags=${label}`, c ? { ingest: c.correspondence.ingest, bell: c.correspondence.bell, proposals: c.correspondence.proposals } : null);
}
// The live-config shape (no new keys): pass must make zero calls.
{
  const c = parseFeedsConfig(JSON.stringify(base))!;
  let calls = 0;
  const spy = new Proxy({}, { get: () => () => { calls++; throw new Error("called"); } }) as any;
  runIngestPass(c, { ledger: spy, cursor: spy, readTeams: spy, recordTeamsStatus: spy, readEmail: spy, processors: [], now: () => 0, log: () => calls++ } as any).then((r) =>
    P("C-live-config-pass", { ran: r.ran, reason: (r as any).reason, calls }),
  );
  // ingest:true but teams absent and sources default -> email only? (what does the pass read)
  const c2 = parseFeedsConfig(JSON.stringify({ ...base, correspondence: { ingest: true } }))!;
  P("C-ingest-only-sources", { sources: c2.correspondence.sources, teamsEnabled: c2.teams.enabled, emailEnabled: c2.email.enabled });
  P("C-activeProcessors-flags-off", activeProcessors(c, [{ name: "bell" } as any, { name: "proposals" } as any]).length);
}
// Real default path with a space
{
  const c = parseFeedsConfig(JSON.stringify({ ...base, teams: true }))!;
  P("E-default-teams-path", c.teams);
  const c2 = parseFeedsConfig(JSON.stringify({ ...base, teams: { path: "/automation/Teams Chats/teams-chats.jsonl" } }))!;
  P("E-explicit-space-path", c2.teams.enabled);
  const enc = c.teams.path.split("/").map((s) => encodeURIComponent(s)).join("/");
  P("E-graph-path-encoding", enc);
}

// ---------------------------------------------------------------- (d) live email path: htmlToText
const H: [string, string][] = [
  // Visible-text-loss attempts
  ["V1 malformed: unclosed hidden span, stray </span> later (browser shows the ask)",
    `<p><span style="display:none">preview text</p><p>Please approve the budget by Friday.</p><p>Thanks</span></p>`],
  ["V2 title attribute containing the word hidden",
    `<p><a href="https://x.example" title="a hidden gem">Read the proposal</a> and tell me if you agree?</p>`],
  ["V3 class attribute 'hidden md-show' (tailwind-style responsive class)",
    `<div class="hidden md-show">Can you review the contract today?</div>`],
  ["V4 MJML column: font-size:0 wrapper, text div 13px",
    `<div class="mj-column-per-100" style="font-size:0px;text-align:left;display:inline-block;"><table><tr><td style="font-size:0px;padding:10px 25px;"><div style="font-family:Arial;font-size:13px;line-height:1;">Can you confirm the venue by Monday?</div></td></tr></table></div>`],
  ["V5 font-size:0 wrapper, child sized by legacy <font size=3>",
    `<td style="font-size:0"><font size="3" face="Arial">Could you sign the NDA today?</font></td>`],
  ["V6 font-size:0 wrapper, child sized by CSS class only (head style)",
    `<html><head><style>.t{font-size:14px}</style></head><body><div style="font-size:0"><span class="t">Can you join the 3pm call?</span></div></body></html>`],
  ["V7 max-height:0 without overflow:hidden (text renders)",
    `<div style="max-height:0">Can you send the deck?</div>`],
  ["V8 Outlook mso conditional + normal body",
    `<!--[if mso]><table><tr><td><![endif]--><p class="MsoNormal">Can you send the Q3 deck by Friday?</p><!--[if mso]></td></tr></table><![endif]-->`],
  ["V9 non-mso downlevel-revealed block",
    `<!--[if !mso]><!--><div>Can you approve the PO?</div><!--<![endif]-->`],
  ["V10 nested tables, unclosed <td>/<tr>",
    `<table><tr><td>Hi Pat,<td>Can you send the invoice?<tr><td>Thanks</table>`],
  ["V11 Gmail reply: ask above gmail_quote",
    `<div dir="ltr">Can you resend the file?</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Nov 10 Pat wrote:<br></div><blockquote class="gmail_quote">old text</blockquote></div>`],
  ["V12 inline-reply: unclosed blockquote then new ask below (malformed)",
    `<blockquote>old question?<p>My answers inline below. Can you confirm the date?</p>`],
  ["V13 visibility:hidden parent, child visibility:visible (CSS renders the child)",
    `<div style="visibility:hidden"><span style="visibility:visible">Can you approve this?</span></div>`],
  ["V14 opacity:0.5 (visible)",
    `<p style="opacity:0.5">Can you call me back?</p>`],
  ["V15 display:none on a sibling <img> only",
    `<img style="display:none" src="x"><p>Can you call me back?</p>`],
  ["V16 entity apostrophe and nbsp",
    `<p>Can&nbsp;you check Dana&#8217;s draft &amp; send it&#63;</p>`],
  ["V17 marketing preheader inline display:none then visible body",
    `<div style="display:none;font-size:1px;color:#fff;max-height:0;overflow:hidden;mso-hide:all">Preview: 50% off</div><table><tr><td style="font-size:16px">Can you RSVP by Friday?</td></tr></table>`],
  ["V18 self-closing hidden div syntax <div style=display:none /> followed by content",
    `<div style="display:none"/><p>Can you call me back?</p>`],
  ["V19 hidden <p> unclosed inside td, followed by another td",
    `<table><tr><td><p style="display:none">pre<td>Can you sign today?</td></tr></table>`],
  // Hidden-text-kept attempts
  ["H1 white-on-white tiny text",
    `<p>Thanks for the update.</p><p style="color:#ffffff;font-size:1px">Please wire $9,000 to account 12-34 today?</p>`],
  ["H2 font-size:1px",
    `<p>FYI only.</p><span style="font-size:1px;line-height:1px">Can you buy gift cards?</span>`],
  ["H3 off-screen positioned",
    `<p>FYI only.</p><div style="position:absolute;left:-9999px">Can you buy gift cards?</div>`],
  ["H4 width:0;height:0;overflow:hidden",
    `<p>FYI only.</p><div style="width:0;height:0;overflow:hidden">Can you buy gift cards?</div>`],
  ["H5 head <style> class display:none",
    `<html><head><style>.pre{display:none}</style></head><body><span class="pre">Can you buy gift cards?</span><p>FYI only.</p></body></html>`],
  ["H6 font-size:0 wrapper child font-size:1em (still zero)",
    `<div style="font-size:0"><span style="font-size:1em">Can you buy gift cards?</span></div><p>FYI only.</p>`],
  ["H7 display:none with spaces/caps and !important",
    `<p>FYI only.</p><DIV STYLE="DISPLAY : NONE !important">Can you buy gift cards?</DIV>`],
  ["H8 hidden attribute bare",
    `<p>FYI only.</p><div hidden>Can you buy gift cards?</div>`],
  ["H9 nested hidden div with inner div",
    `<p>FYI only.</p><div style="display:none"><div>Can you buy</div> gift cards?</div>`],
  ["H10 unclosed hidden div at end of doc",
    `<p>FYI only.</p><div style="display:none">Can you buy gift cards?`],
  ["H11 text-indent negative",
    `<p>FYI only.</p><p style="text-indent:-9999px">Can you buy gift cards?</p>`],
  ["H12 clip / transform scale 0",
    `<p>FYI only.</p><span style="transform:scale(0)">Can you buy gift cards?</span>`],
  ["H13 display:none in single quotes with url data containing quote",
    `<p>FYI only.</p><div style='display:none'>Can you buy gift cards?</div>`],
  ["H14 conditional comment hidden content [if gte mso 9] inside non-mso",
    `<p>FYI only.</p><!--[if false]>Can you buy gift cards?<![endif]-->`],
  ["H15 max-height:0 + overflow:hidden (Gmail preheader trick)",
    `<p>FYI only.</p><div style="max-height:0px;overflow:hidden">Can you buy gift cards?</div>`],
  ["H16 height:0;overflow:hidden",
    `<p>FYI only.</p><div style="height:0;overflow:hidden">Can you buy gift cards?</div>`],
];
for (const [id, html] of H) P(`D-html ${id}`, htmlToText(html));

// ---------------------------------------------------------------- (d) newTextOnly English over-cut
const N: [string, string][] = [
  ["N1 English 'On ... wrote back with ...:' then the real asks",
    "Quick update.\nOn Friday the auditor wrote back with these questions:\n1. Can you send the ledger by Monday?\n2. Who signed the PO?"],
  ["N2 English line starting 'Am' ending 'wrote:'",
    "Am I right about what legal wrote:\nCan you check clause 3 before we sign?"],
  ["N3 two-line English sentence starting 'On'",
    "On Friday after the board meeting,\nthe vendor wrote back with three questions:\nCan you approve the change order?"],
  ["N4 request template From:/Data: lines",
    "Request details\nFrom: Marketing\nData: Q3 revenue by region\nCan you pull this by Friday?"],
  ["N5 control: real English Outlook header",
    "Can you send it?\n\nFrom: Pat <pat@x.example>\nSent: Monday\nTo: me\nSubject: old\nold question?"],
  ["N6 control: real Gmail attribution",
    "Sure thing.\n\nOn Mon, Nov 10, 2026 at 9:00 AM Pat <pat@x.example> wrote:\n> Can you send it?"],
  ["N7 'Den' English (den = room)",
    "Den lighting: the electrician wrote: \nCan you pick a fixture by Thursday?"],
  ["N8 'El' English (El Paso)",
    "El Paso office update - Maria wrote the following:\nCan you approve the lease?"],
  ["N9 'Il' unlikely; 'Op' (Op-ed)",
    "Op-ed draft: the editor wrote these notes:\nCan you revise the intro?"],
];
for (const [id, body] of N) P(`D-ntxt ${id}`, newTextOnly(body));

// ---------------------------------------------------------------- (e) real Teams Graph shape
const live = parseFeedsConfig(JSON.stringify({ ...base, teams: { ownerSenderIds: ["00000000-0000-0000-0000-00000000a0a0"] } }))!;
const tcfg = { synthetic: live.synthetic, subjectPrefix: live.subjectPrefix, notBeforeUtc: live.notBeforeUtc, teams: live.teams };
const user = (id: string, name: string) => ({ user: { "@odata.type": "#microsoft.graph.teamworkUserIdentity", id, displayName: name, userIdentityType: "aadUser", tenantId: "00000000-0000-0000-0000-000000000000" } });
const OWNER = "00000000-0000-0000-0000-00000000A0A0"; // upper-case on purpose
const PAT = "00000000-0000-0000-0000-00000000b0b0";
const msg = (id: string, at: string, from: unknown, content: string, extra: Record<string, unknown> = {}) => ({
  id, etag: id, messageType: "message", createdDateTime: at, lastModifiedDateTime: at, chatId: "19:c1@thread.example",
  importance: "normal", locale: "en-us", webUrl: null, from, body: { content, contentType: "html", messageBodyContentType: "html" },
  attachments: [], mentions: [], citations: [], reactions: [], ...extra,
});
const line = (msgs: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ source: "teams", chatId: "19:c1@thread.example", status: "Pending", capturedAt: "2026-11-12T23:00:05.123Z", messages: msgs, ...extra });
// 1) today's real lines: no synthetic key -> skipped
{
  const r = parseTeamsLog(line([msg("1", "2026-11-12T14:00:00Z", user(PAT, "Pat Example"), "<p>Can you send the deck?</p>")]), tcfg);
  P("E-real-line-no-synthetic", { kept: r.messages.length, skipped: r.skipped, rejected: r.rejected ?? null });
}
// 2) with synthetic:false + full Graph shape incl. system event, edited, deleted, app sender, absent from
{
  const msgs = [
    msg("1", "2026-11-12T14:00:00Z", user(PAT, "Pat Example"), "<p>Can you send the Q3 deck by Friday?</p>"),
    msg("2", "2026-11-12T14:01:00Z", null, "<systemEventMessage/>", { messageType: "systemEventMessage", eventDetail: { "@odata.type": "#microsoft.graph.membersAddedEventMessageDetail" } }),
    msg("3", "2026-11-12T14:02:00Z", user(PAT, "Pat Example"), "<p>edited text?</p>", { lastEditedDateTime: "2026-11-12T14:03:00Z" }),
    msg("4", "2026-11-12T14:04:00Z", user(PAT, "Pat Example"), "", { deletedDateTime: "2026-11-12T14:05:00Z" }),
    msg("5", "2026-11-12T14:06:00Z", { application: { "@odata.type": "#microsoft.graph.teamworkApplicationIdentity", id: "app-1", displayName: "Bot", applicationIdentityType: "bot" }, device: null, user: null }, "<p>Approve request?</p>"),
    msg("6", "2026-11-12T14:07:00Z", { application: null, device: null, user: user(OWNER, "Owner Example").user }, "<p>Sure, sending now</p>"),
  ];
  const r = parseTeamsLog(line(msgs, { synthetic: false }), tcfg);
  P("E-graph-shape", { kept: r.messages.map((m) => ({ id: m.messageId, fromOwner: m.fromOwner, isApp: m.senderIsApp, text: m.text })), skipped: r.skipped });
  P("E-graph-shape-decision", decideChatThread(r.messages, r.messages.some((m) => m.fromOwner === true)).state);
}
// 3) EMPTY skip: can it drop a REAL message?
{
  const E: [string, string, Record<string, unknown>][] = [
    ["image-only inline (hostedContents, attachments [])", `<p><img src="https://graph.microsoft.com/v1.0/chats/19:c1/messages/7/hostedContents/aaa/$value" alt="image" width="250" height="150"></p>`, {}],
    ["emoji-only", `<p><emoji id="1f44d_thumbsup" alt="\u{1F44D}" title="Thumbs up"></emoji></p>`, {}],
    ["emoji literal", `<p>\u{1F44D}</p>`, {}],
    ["mention-only", `<p><at id="0">Pat Example</at></p>`, { mentions: [{ id: 0, mentionText: "Pat Example" }] }],
    ["adaptive card", `<attachment id="74d20c7f"></attachment>`, { attachments: [{ id: "74d20c7f", contentType: "application/vnd.microsoft.card.adaptive", content: "{}" }] }],
    ["giphy", `<p><img alt="GIF" src="https://media.giphy.example/x.gif" itemtype="http://schema.skype.com/Giphy"></p>`, {}],
    ["file-only", `<attachment id="f1"></attachment>`, { attachments: [{ id: "f1", contentType: "reference", name: "deck.pptx" }] }],
    ["code block only whitespace", `<p>&nbsp;</p>`, {}],
  ];
  for (const [id, content, extra] of E) {
    const r = parseTeamsLog(line([msg("9", "2026-11-12T15:00:00Z", user(OWNER, "Owner Example"), content, extra)], { synthetic: false }), tcfg);
    P(`E-empty ${id}`, { kept: r.messages.length, text: r.messages[0]?.text ?? null, skipped: r.skipped });
  }
  // Consequence: Pat asks, owner answers with only a thumbs-up emoji / only a screenshot
  for (const [id, content] of [["emoji", `<p><emoji id="1f44d_thumbsup" alt="\u{1F44D}" title="Thumbs up"></emoji></p>`], ["screenshot", `<p><img src="https://graph.microsoft.com/v1.0/x/hostedContents/a/$value"></p>`]] as const) {
    const msgs = [
      msg("10", "2026-11-12T09:00:00Z", user(OWNER, "Owner Example"), "<p>Morning</p>"),
      msg("11", "2026-11-12T14:00:00Z", user(PAT, "Pat Example"), "<p>Can you send the Q3 deck?</p>"),
      msg("12", "2026-11-12T14:05:00Z", user(OWNER, "Owner Example"), content),
    ];
    const r = parseTeamsLog(line(msgs, { synthetic: false }), tcfg);
    P(`E-empty-consequence owner replies ${id}-only`, { kept: r.messages.map((m) => m.messageId), decision: decideChatThread(r.messages, true).state });
  }
}
// 4) coverage drop flag
{
  const mk = (day: string, n: number, cap = "capturedAt") =>
    Array.from({ length: n }, (_, i) => JSON.stringify({ source: "teams", synthetic: false, chatId: `19:c${i}@thread.example`, [cap]: day, messages: [] })).join("\n");
  const cov = (text: string) => { const r = parseTeamsLog(text, tcfg); return { captureChats: r.captureChats, cov: captureCoverage(r.captureChats) }; };
  P("E-cov normal 12 vs 12", cov(mk("2026-11-11T23:00:00Z", 12) + "\n" + mk("2026-11-12T23:00:00Z", 12)).cov.drop);
  P("E-cov 12 then same-day rerun 3 chats at 18:00 EST (23:00Z) + rerun 19:30 EST (00:30Z next day)",
    cov(mk("2026-11-12T23:00:00Z", 12) + "\n" + mk("2026-11-13T00:30:00Z", 3)));
  P("E-cov rerun same UTC day (subset) unions, no flag", cov(mk("2026-11-12T23:00:00Z", 12) + "\n" + mk("2026-11-12T23:30:00Z", 3)).cov.drop);
  P("E-cov newest lines have no capturedAt (flow regression) -> drop invisible",
    cov(mk("2026-11-11T23:00:00Z", 12) + "\n" + mk("2026-11-12T23:00:00Z", 12, "capturedTime")));
  P("E-cov newest capture only 1 chat, previous 12, but newest missing capturedAt",
    cov(mk("2026-11-11T23:00:00Z", 12) + "\n" + mk("x", 1, "capturedTime")).cov);
  P("E-cov Friday 12 vs Saturday 2 (if flow ran on weekend writing only active chats)",
    cov(mk("2026-11-13T23:00:00Z", 12) + "\n" + mk("2026-11-14T23:00:00Z", 2)).cov.drop);
  P("E-cov previous 9 latest 0-ish", cov(mk("2026-11-11T23:00:00Z", 9) + "\n" + mk("2026-11-12T23:00:00Z", 1)).cov.drop);
  P("E-cov zoneless capturedAt 2026-11-12T23:30 is UTC", cov(mk("2026-11-12T23:30:00", 2)).captureChats);
  P("E-cov offset capturedAt 18:00-05:00 -> UTC day", cov(mk("2026-11-12T19:30:00-05:00", 2)).captureChats);
  const note = teamsParseNote(parseTeamsLog(mk("2026-11-11T23:00:00Z", 12) + "\n" + mk("2026-11-12T23:00:00Z", 3), tcfg));
  P("E-cov note", note);
}

// ---------------------------------------------------------------- (e) sent.json contract + conversationId settle
{
  const now = Date.parse("2026-11-12T23:10:00Z");
  const sentDoc = {
    schema_version: "1.0", feed_type: "sent_snapshot", source: "power-automate-outlook", mailbox: "owner@work.example",
    synthetic: false, complete: true, published_utc: "2026-11-12T23:00:00Z", window_start_utc: "2026-11-11T23:00:00Z",
    snapshot: { value: [
      { id: "s1", conversationId: "CONV-1", sentDateTime: "2026-11-12T15:00:00Z", subject: "RE: deck", toRecipients: "pat@x.example" },
      { id: "s2", conversationId: "CONV-2", receivedDateTime: "2026-11-12T16:00:00Z" },
      { id: "s3", sentDateTime: "2026-11-12T16:00:00Z" },
    ] },
  };
  const v = validateSentSnapshot(sentDoc, live, now);
  P("E-sent-validate", v.ok ? { ok: true, n: v.snapshot.records.length } : v);
  const v2 = validateSentSnapshot({ ...sentDoc, snapshot: undefined, value: sentDoc.snapshot.value }, live, now);
  P("E-sent-validate top-level value", v2.ok ? { ok: true, n: v2.snapshot.records.length } : v2);
  if (v.ok) {
    const m = mapSentRecords(v.snapshot.records, live);
    P("E-sent-map", m);
    // real emails.json record shape
    const rec = {
      attachments: [], body: "<html><body><p>Can you send the Q3 deck?</p></body></html>", bodyPreview: "Can you send the Q3 deck?",
      conversationId: "CONV-1", from: "pat@x.example", hasAttachments: false, id: "AAMk-1", importance: "normal",
      internetMessageHeaders: [], internetMessageId: "<a@x.example>", isHtml: true, isRead: false,
      receivedDateTime: "2026-11-12T14:00:00Z", subject: "deck", toRecipients: "owner@work.example",
    };
    const im = mapFeedMessage(rec, "owner@work.example");
    P("E-emails-record-map", { id: im.id, conv: im.conversationId, from: im.fromAddress, body: im.bodyText });
    const latest = latestSentByConversation(m.sent);
    P("E-settle-later-sent", sentReplySettles({ conversation_id: im.conversationId, received_at: im.receivedDateTime }, latest));
    P("E-settle-earlier-sent", sentReplySettles({ conversation_id: "CONV-2", received_at: "2026-11-12T17:00:00Z" }, latest));
    P("E-settle-received_at as Date", sentReplySettles({ conversation_id: "CONV-1", received_at: new Date("2026-11-12T14:00:00Z") }, latest));
  }
  // emails.json real envelope sanity (existing validator)
  const emailDoc = { ...sentDoc, feed_type: "email_snapshot" };
  const ve = validateEmailSnapshot(emailDoc, live, now);
  P("E-email-validate", ve.ok ? { ok: true } : ve);
}
