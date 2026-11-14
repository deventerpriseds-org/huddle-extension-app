// WHAT:       Verifier loop 6: the LIVE work-email ask decision end to end -- asksSomething({bodyText: htmlToText(html)})
//             -- branch (ddc7b55d, parse5) vs origin/main, on bodies whose line structure changes because parse5 supplies
//             implied end tags (</p>, </li>, </tr>) that main's regex only saw when the source wrote them.
// WHY:        newTextOnly is line-based (attribution / header rules), so new line boundaries can change what it cuts.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-6.md
// All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { asksSomething, newTextOnly } from "../src/features/huddle/lib/email/inbound-email";
import { asksSomething as mainAsks, newTextOnly as mainNTO } from "./verify5-main/inbound-email";

const rows: [string, string][] = [
  ["p-unclosed-en-sentence", `<p>Status below.<p>On Friday the auditor wrote:<p>Can you send the ledger by Monday?`],
  ["p-closed-en-sentence(control)", `<p>Status below.</p><p>On Friday the auditor wrote:</p><p>Can you send the ledger by Monday?</p>`],
  ["li-unclosed-en-sentence", `<ul><li>On Monday the board wrote:<li>Can you approve the budget?</ul>`],
  ["tr-unclosed-en-sentence", `<table><tr><td>On Monday the board wrote:<tr><td>Can you approve the budget?</table>`],
  ["p-unclosed-from-sent", `<p>Hi<p>From: the team<p>Sent: Monday<p>Can you approve the budget?`],
  ["p-unclosed-gmail-history", `<p>Thanks<p>On Mon, Nov 10, 2025 at 9:14 AM Dana Kim &lt;dana@corp.example&gt; wrote:<p>Can you send the old ledger?`],
  ["div-nested-no-break", `<div>On Friday the auditor wrote:<div>Can you send the ledger?</div></div>`],
  ["p-unclosed-plain-ask", `<p>Hello<p>Can you send the ledger?<p>Thanks`],
];
let diff = 0;
for (const [id, html] of rows) {
  const b = htmlToText(html), m = mainHtml(html);
  const ab = asksSomething({ subject: "Status", bodyText: b, bodyPreview: null }), am = mainAsks({ subject: "Status", bodyText: m, bodyPreview: null });
  const nb = newTextOnly(b), nm = mainNTO(m);
  const same = ab === am && nb.replace(/\s+/g, " ").trim() === nm.replace(/\s+/g, " ").trim();
  if (!same) diff++;
  console.log(`${same ? "same" : "DIFF"} ${id.padEnd(32)} asks branch/main=${ab}/${am}\n     branch new text=${JSON.stringify(nb)}\n     main   new text=${JSON.stringify(nm)}`);
}
console.log(`rows=${rows.length} differ=${diff}`);
