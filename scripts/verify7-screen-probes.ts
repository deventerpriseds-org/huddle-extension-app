// WHAT:       Verifier loop 7: the LIVE work-email ask decision end to end -- asksSomething({bodyText: htmlToText(html)})
//             -- branch (3b3f0c42, parse5 + source-only tags) vs origin/main (7ba8f7a4 copies in scripts/verify5-main/),
//             on NEW malformed shapes where the line structure the branch emits could still differ from main's regex.
// WHY:        loop 6 found implied end tags flipping the ask decision; the fix re-emits only tags the source wrote.
//             This probes the residual places where "a tag the source wrote" and "a tag main's regex matched" differ:
//             tags WITH attributes or whitespace (<br clear=all>, </p >), </br>, stray end tags the parser ignores,
//             and foster-parented content that the browser (and parse5) moves ABOVE a table.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-7.md
// All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { asksSomething, newTextOnly } from "../src/features/huddle/lib/email/inbound-email";
import { asksSomething as mainAsks, newTextOnly as mainNTO } from "./verify5-main/inbound-email";

const ASK = "Can you approve the budget?";
const ATT = "On Monday the board wrote:";
const rows: [string, string][] = [
  // loop-6 shapes, re-run
  ["L6 p-unclosed", `<p>Status below.<p>On Friday the auditor wrote:<p>Can you send the ledger by Monday?`],
  ["L6 li-unclosed", `<ul><li>${ATT}<li>${ASK}</ul>`],
  ["L6 tr-unclosed", `<table><tr><td>${ATT}<tr><td>${ASK}</table>`],
  ["L6 from-sent", `<p>Hi<p>From: the team<p>Sent: Monday<p>${ASK}`],
  // new malformed shapes
  ["h2-unclosed-then-p", `<h2>${ATT}<p>${ASK}`],
  ["p-closed-by-table", `<p>${ATT}<table><tr><td>${ASK}</td></tr></table>`],
  ["p-closed-by-div", `<p>${ATT}<div>${ASK}</div>`],
  ["li-closed-by-li-in-ol", `<ol><li>${ATT}<li>${ASK}</ol>`],
  ["dt-dd-unclosed", `<dl><dt>${ATT}<dd>${ASK}</dl>`],
  ["option-unclosed", `<select><option>${ATT}<option>${ASK}</select>`],
  ["stray-end-li", `Hello ${ATT}</li>${ASK}`],
  ["stray-end-div", `Hello ${ATT}</div>${ASK}`],
  ["stray-end-tr", `Hello ${ATT}</tr>${ASK}`],
  ["stray-end-h3", `Hello ${ATT}</h3>${ASK}`],
  ["stray-end-p", `Hello ${ATT}</p>${ASK}`],
  ["end-br", `Hello<br>${ATT}</br>${ASK}`],
  ["br-with-attr", `Hello<br>${ATT}<br clear="all">${ASK}`],
  ["br-with-style", `Hello<br>${ATT}<br style="mso-x:1">${ASK}`],
  ["br-uppercase-attr", `Hello<BR>${ATT}<BR CLASS="x">${ASK}`],
  ["end-p-space", `<p>Hello</p><p>${ATT}</p ><p>${ASK}</p >`],
  ["end-div-newline", `<div>Hello</div><div>${ATT}</div\n><div>${ASK}</div\n>`],
  ["end-tag-with-attr", `<p>${ATT}</p class="x"><p>${ASK}</p>`],
  ["foster-p-after-row", `<table><tr><td>${ASK}</td></tr><p>${ATT}</p></table>`],
  ["foster-text-br-after-row", `<table><tr><td>${ASK}</td></tr>${ATT}<br></table>`],
  ["foster-div-after-row", `<table><tr><td>${ASK}</td></tr><div>${ATT}</div></table>`],
  ["nested-p-in-button", `<button><p>${ATT}</button>${ASK}`],
  ["misnested-b-p", `<b><p>${ATT}</b>${ASK}</p>`],
  ["blockquote-unclosed-mid", `<p>${ASK}</p><blockquote>old<p>older`],
  ["blockquote-stray-close", `<p>Hello</p></blockquote><p>${ASK}</p>`],
  ["div-id-reply-unclosed", `<p>${ASK}</p><div id="divRplyFwdMsg">From: x<p>old ask?`],
  ["plain-text-only", `${ATT}\n${ASK}`],
  ["image-then-ask", `<img src="x">${ATT}<img src="y"><p>${ASK}</p>`],
  ["frameset-junk", `<frameset><p>${ATT}</p></frameset><p>${ASK}</p>`],
  ["svg-text", `<svg><text>${ATT}</text></svg><p>${ASK}</p>`],
  // reverse direction: main CUT quoted history at a stray end tag's newline; the branch (parser ignores the stray
  // tag) keeps the history and its old ask -> a NEW alert main does not raise
  ["rev-stray-div-gmail-attr", `Thanks, will do.</div>On Mon, Nov 10, 2025 at 9:14 AM Dana Kim &lt;dana@corp.example&gt; wrote:</div>Can you send the old ledger?`],
  ["rev-stray-p-from-sent", `Noted.</p>From: Dana Kim</p>Sent: Monday</p>Can you send the old ledger?`],
  ["rev-end-br-attr-line", `Noted.</br>On Mon, Nov 10, 2025 at 9:14 AM Dana Kim wrote:</br>Can you send the old ledger?`],
  // realistic Gmail reply with <br clear=all> before the signature (no flip expected)
  ["gmail-reply-real-shape", `<div dir="ltr">${ASK}<br clear="all"><br>-- <br><div>Pat</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Nov 10, 2025 at 9:14 AM Dana Kim &lt;dana@corp.example&gt; wrote:<br></div><blockquote class="gmail_quote">old?</blockquote></div>`],
  ["math-p-breakout", `<math><mi><p>${ATT}</p></mi></math>${ASK}`],
];
let diff = 0, flips = 0;
for (const [id, html] of rows) {
  const b = htmlToText(html), m = mainHtml(html);
  const ab = asksSomething({ subject: "Status", bodyText: b, bodyPreview: null }), am = mainAsks({ subject: "Status", bodyText: m, bodyPreview: null });
  const nb = newTextOnly(b), nm = mainNTO(m);
  const linesSame = nb.split("\n").map((s) => s.trim()).filter(Boolean).join("|") === nm.split("\n").map((s) => s.trim()).filter(Boolean).join("|");
  const same = ab === am && linesSame;
  if (!same) diff++;
  if (ab !== am) flips++;
  console.log(`${ab !== am ? "FLIP" : same ? "same" : "LINES"} ${id.padEnd(26)} asks branch/main=${ab}/${am}\n     branch new text=${JSON.stringify(nb)}\n     main   new text=${JSON.stringify(nm)}`);
}
console.log(`rows=${rows.length} differ=${diff} ask-decision-flips=${flips}`);
