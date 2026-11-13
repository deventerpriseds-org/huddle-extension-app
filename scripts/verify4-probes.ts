// WHAT:       Verifier loop-4 NEW-spelling probes for the loop-3 fixes D1 (hidden text), D2 (newTextOnly),
//             D3/D4 (Teams), D5/D6/M2 (proposal validator), each run against this branch AND origin/main's copy
//             (main copies are written to $MAIN_DIR by the caller: git show origin/main:<file>).
// WHY:        Tier 1 re-derivation: the fixes were mutation-proved on the implementer's inputs; this tries others.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-4.md
// Synthetic .example data only (public repo).
import { htmlToText, parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { newTextOnly, asksSomething } from "../src/features/huddle/lib/email/inbound-email";
import { parseTeamsLog, captureCoverage, teamsParseNote } from "../src/features/huddle/lib/external-feeds/teams-log";
import { validateCandidates } from "../src/features/huddle/lib/proposals/proposals";

const MAIN = process.env.MAIN_DIR ?? "/tmp/claude-0/v4/main";
const mainFeed = await import(`${MAIN}/onedrive-feed.ts`);
const mainMail = await import(`${MAIN}/inbound-email.ts`);
const P = (id: string, v: unknown) => console.log(`PROBE ${id} ${JSON.stringify(v)}`);

// ------------------------------------------------------------ D1 new spellings (branch vs main)
const H: [string, string][] = [
  ["W1 unclosed hidden span inside <p>, next <p> start (no </p>) closes it in a browser",
    `<p><span style="display:none">preheader text<p>Please approve the budget by Friday?</p>`],
  ["W2 unclosed hidden span inside <p>, then <ul> (p-closer)", `<p><span style="display:none">pre<ul><li>Can you sign the NDA today?</li></ul>`],
  ["W3 unclosed hidden span inside <li>, next <li>", `<ul><li><span style="display:none">x<li>Can you call the vendor?</li></ul>`],
  ["W4 mso conditional ask + same ask in mso-hide:all (non-Outlook copy)",
    `<!--[if mso]><p>Can you sign the NDA?</p><![endif]--><div style="mso-hide:all">Can you sign the NDA?</div>`],
  ["W5 aria-hidden (visible on screen)", `<p aria-hidden="true">Can you approve the PO?</p>`],
  ["W6 data-hidden attribute", `<div data-hidden="x">Can you approve the PO?</div>`],
  ["W7 style text inside another attribute value", `<div title=' style="display:none"'>Can you approve the PO?</div>`],
  ["W8 void tags inside hidden div then visible ask", `<div style="display:none">pre<br>more<hr><img src="x.example"><wbr></div><p>Can you sign today?</p>`],
  ["W9 Outlook <o:p> inside hidden span", `<p class="MsoNormal"><span style="display:none">pre<o:p></o:p></span>Can you review the memo?<o:p></o:p></p>`],
  ["W10 hidden <h2> followed by <h3> start", `<h2 style="display:none">pre<h3>Can you RSVP?</h3>`],
  ["W11 hidden span with </div> stray then ask", `<div><span style="display:none">pre</div><div>Can you RSVP by Monday?</div>`],
  ["W12 opacity:0 inside span then sibling", `<span style="opacity:0">x</span><span>Can you confirm?</span>`],
  ["W13 HIDDEN 'hidden' attribute uppercase", `<div HIDDEN>Can you buy gift cards?</div><p>FYI only.</p>`],
  ["W14 display:none via spaces before colon", `<div style="display :none">Can you buy gift cards?</div><p>FYI only.</p>`],
  ["W15 display:none with comment inside style", `<div style="display:/*x*/none">Can you buy gift cards?</div><p>FYI only.</p>`],
  ["W16 font-size:0 wrapper, child <b> sized by attribute-less tag", `<div style="font-size:0"><b>Can you buy gift cards?</b></div><p>FYI only.</p>`],
  ["W17 hidden <td> unclosed then <tr>", `<table><tr><td style="display:none">x<tr><td>Can you sign?</td></tr></table>`],
  ["W18 hidden div containing table with </td> etc", `<div style="display:none"><table><tr><td>x</td></tr></table></div><p>Can you sign?</p>`],
];
for (const [id, html] of H) P(`D1 ${id}`, { branch: htmlToText(html), main: mainFeed.htmlToText(html) });

// ------------------------------------------------------------ D2 new spellings (branch vs main)
const N: [string, string][] = [
  ["X1 hard-wrapped English line with a digit starting 'On', next line ends 'wrote:'",
    "Status below.\nOn Nov 12 the auditor sent these questions and Pat\nalso wrote:\nCan you send the ledger by Monday?"],
  ["X2 'On 3 occasions' wrap", "On 3 occasions the client\ncomplained, and today she wrote:\nCan you call her back?"],
  ["X3 German opener with English verb and digit", "Am 12. Nov the team wrote:\nCan you approve the PO?"],
  ["X4 Outlook header with Sent on 5th line", "Ask below.\nFrom: Pat\nTo: Owner\nCc: X\nSubject: Y\nSent: Monday\nCan you sign?"],
  ["X5 -----Original Message----- control", "Thanks!\n-----Original Message-----\nCan you sign?"],
  ["X6 'De:' French From then English 'Date:' line", "Résumé\nDe : Marketing\nDate : demain\nCan you pull this?"],
  ["X7 Italian Da: + Data: (English 'Da:' unlikely)", "Notes\nDa: Pat\nData: oggi\nCan you sign?"],
  ["X8 Portuguese 'De:' + 'Data:' (pt pair includes Data)", "Request\nDe: Marketing\nData: Q3 revenue by region\nCan you pull this by Friday?"],
  ["X9 Spanish 'De:' + English 'Date:' header (Outlook ES mixed)", "Hola\nDe: Pat\nDate: lunes\nCan you sign?"],
];
for (const [id, body] of N) {
  const b = newTextOnly(body), m = mainMail.newTextOnly(body);
  P(`D2 ${id}`, { same: b === m, branch: b, main: m, asksBranch: asksSomething({ subject: "Re: status", bodyText: body } as never), asksMain: mainMail.asksSomething({ subject: "Re: status", bodyText: body }) });
}

// ------------------------------------------------------------ D3 / D4 new spellings
const live = parseFeedsConfig(JSON.stringify({ enabled: true, ownerLogins: ["owner@huddle.example"], driveUser: "owner@work.example", mailbox: "owner@work.example", synthetic: false, teams: { ownerSenderIds: ["00000000-0000-0000-0000-00000000a0a0"] } }))!;
const tcfg = { synthetic: live.synthetic, subjectPrefix: live.subjectPrefix, notBeforeUtc: live.notBeforeUtc, teams: live.teams };
const OWNER = "00000000-0000-0000-0000-00000000a0a0";
const user = (id: string) => ({ user: { id, displayName: "x", userIdentityType: "aadUser" } });
const msg = (id: string, at: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, messageType: "message", createdDateTime: at, from: user(OWNER), body: { content, contentType: "html" }, attachments: [], ...extra,
});
const line = (msgs: unknown[], cap = "2026-11-12T23:00:05Z") => JSON.stringify({ source: "teams", synthetic: false, chatId: "19:c1@thread.example", capturedAt: cap, messages: msgs });
const D3: [string, string][] = [
  ["custom emoji element (Graph <customemoji>)", `<p><customemoji id="abc" alt="partyparrot" source="https://x.example/e.png"></customemoji></p>`],
  ["sticker img", `<p><img itemtype="http://schema.skype.com/Sticker" src="https://x.example/s.png"></p>`],
  ["IMG upper case", `<P><IMG SRC="https://x.example/a.png"></P>`],
  ["plain-text body with only an emoji char", `\u{1F44D}`],
  ["video card (<video>)", `<video src="https://x.example/v.mp4"></video>`],
];
for (const [id, content] of D3) {
  const r = parseTeamsLog(line([msg("9", "2026-11-12T15:00:00Z", content, id.startsWith("plain") ? { body: { content, contentType: "text" } } : {})]), tcfg);
  P(`D3 ${id}`, { kept: r.messages.length, skipped: r.skipped });
}
const mk = (cap: string, n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ source: "teams", synthetic: false, chatId: `19:c${i}@thread.example`, capturedAt: cap, messages: [] })).join("\n");
const cov = (t: string) => { const r = parseTeamsLog(t, tcfg); return { days: r.captureChats, cov: captureCoverage(r.captureChats), note: teamsParseNote(r) }; };
P("D4 DST end: 2026-10-31 23:00 EDT (03:00Z Nov 1) and 2026-11-01 18:00 EST (23:00Z)", cov(mk("2026-11-01T03:00:00Z", 12) + "\n" + mk("2026-11-01T23:00:00Z", 12)).days);
P("D4 DST start: 2026-03-08 06:30Z (01:30 EST) and 07:30Z (03:30 EDT) same Eastern day", cov(mk("2026-03-08T06:30:00Z", 2) + "\n" + mk("2026-03-08T07:30:00Z", 2)).days);
P("D4 epoch-ms capturedAt", cov(mk(String(Date.UTC(2026, 10, 12, 23)), 2)).days);
P("D4 mixed: 12 timed yesterday, 3 untimed today -> note", cov(mk("2026-11-11T23:00:00Z", 12) + "\n" + Array.from({ length: 3 }, (_, i) => JSON.stringify({ source: "teams", synthetic: false, chatId: `19:u${i}@thread.example`, messages: [] })).join("\n")).note);

// ------------------------------------------------------------ D5 / D6 / M2 new spellings
const ctx = { atIso: "2026-11-12T15:00:00Z", tz: "America/New_York" };
const run = (id: string, src: string, task: Record<string, unknown>) => {
  const r = validateCandidates({ tasks: [task] }, src, ctx);
  const a = r.accepted[0];
  P(id, a ? { ACCEPTED: a.title, dueText: a.dueText, due: a.dueDate } : { rejected: r.rejected });
};
const C = (s: string) => ({ task: "Send the contract to the client", evidence: s });
run("D5 n1 'do not, repeat, do not send'", "Do not, repeat, do not send the contract to the client.", C("send the contract to the client"));
run("D5 n2 'not to send' (told not to)", "Legal asked us not to send the contract to the client yet.", C("send the contract to the client yet"));
run("D5 n3 'hold off on sending'", "Please hold off on sending the contract to the client.", C("sending the contract to the client"));
run("D5 n4 'don't' with curly apostrophe", "Please don’t send the contract to the client.", C("send the contract to the client"));
run("D5 n5 'stop sending'", "Stop sending the contract to the client.", C("sending the contract to the client"));
run("D5 n6 'nobody should send'", "Nobody should send the contract to the client today.", C("send the contract to the client today"));
run("D5 n7 'shouldn't send'", "We shouldn't send the contract to the client today.", C("send the contract to the client today"));
run("D5 n8 'no need to send'", "No need to send the contract to the client.", C("send the contract to the client"));
run("D5 n9 'cannot send'", "We cannot send the contract to the client until legal signs.", C("send the contract to the client until legal signs"));
run("D5 pos1 'avoid delays, send'", "To avoid delays, send the contract to the client today.", C("send the contract to the client today"));
run("D5 pos2 'don't forget to send'", "Don't forget to send the contract to the client today.", C("send the contract to the client today"));
run("D5 pos3 'not only ... send'", "If it is not signed, send the contract to the client again.", C("send the contract to the client again"));
run("D6 n1 title adds 'urgently'", "Please send the deck to finance.", { task: "Urgently send the deck to finance", evidence: "send the deck to finance" });
run("D6 n2 title swaps object 'budget' -> deck", "Please send the budget to finance.", { task: "Send the deck to finance", evidence: "send the budget to finance" });
run("D6 n3 title adds name", "Please send the deck to finance.", { task: "Send the deck to Dana in finance", evidence: "send the deck to finance" });
run("D6 n4 stopword-only addition 'not' (Send ... not)", "Please send the deck to finance.", { task: "Do not send the deck to finance", evidence: "send the deck to finance" });
run("D6 n5 title is shorter (subset)", "Please send the signed deck to finance today.", { task: "Send the deck", evidence: "send the signed deck to finance today" });
run("D6 n6 plural/singular", "Please send the decks to finance.", { task: "Send the deck to finance", evidence: "send the decks to finance" });
run("M2 n1 'Friday-ish'", "Send the deck to finance by Friday.", { task: "Send the deck to finance", evidence: "Send the deck to finance by Friday", due_text: "Friday-ish" });
run("M2 n2 'the 14th'", "Send the deck to finance by the 14th.", { task: "Send the deck to finance", evidence: "Send the deck to finance by the 14th", due_text: "the 14th" });
run("M2 n3 'Nov 14'", "Send the deck to finance by Nov 14.", { task: "Send the deck to finance", evidence: "Send the deck to finance by Nov 14", due_text: "Nov 14" });
run("M2 n4 'march' (verb) w/o day", "We march on.", { task: "March on", evidence: "We march on", due_text: "march" });
run("M2 n5 'mon' alone", "Send the deck to finance by mon.", { task: "Send the deck to finance", evidence: "Send the deck to finance by mon", due_text: "mon" });
run("M2 n6 'next time'", "Send the deck to finance next time.", { task: "Send the deck to finance", evidence: "Send the deck to finance next time", due_text: "next time" });
run("M2 n7 'this week'", "Send the deck to finance this week.", { task: "Send the deck to finance", evidence: "Send the deck to finance this week", due_text: "this week" });
run("M2 n8 'may 3'", "You may send the deck to finance in 3 days.", { task: "Send the deck to finance", evidence: "You may send the deck to finance in 3 days", due_text: "may 3" });
