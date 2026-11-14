// WHAT:       Verifier loop 6: Teams HTML bodies through htmlToText before (0396f71a hand scanner) and after (ddc7b55d
//             parse5), plus asksSomething on each, and the parsed TeamsMessage text via parseTeamsLog.
// WHY:        Challenge the radius: teams-log.ts bodyText() reuses htmlToText, so parse5 changes Teams text, which feeds
//             the open/answered decision (flag-gated, teams-log is not on main).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-6.md
// All data synthetic.
import { htmlToText as now } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as old } from "./verify6-old/onedrive-feed";
import { asksSomething } from "../src/features/huddle/lib/email/inbound-email";

const rows: [string, string][] = [
  ["mention", `<p>Hi <at id="0">Dana Kim</at>, can you send the deck?</p>`],
  ["reply-quote", `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1700000000000"><strong itemprop="mri" itemid="8:orgid:x">Dana Kim</strong><span itemprop="time" itemid="1700000000000"></span><p itemprop="preview">Can you send the deck?</p></blockquote><p>Done, sent it.</p>`],
  ["attachment-only", `<attachment id="abc123"></attachment>`],
  ["attachment-selfclose-then-ask", `<p>Draft attached</p><attachment id="abc123"/><p>Can you check it?</p>`],
  ["nested-div", `<div><div>Can you <b>review</b> this?</div></div>`],
  ["entity-angle", `<p>&lt;not a tag&gt; can you confirm?</p>`],
  ["code", `<pre><code>if (a &lt; b) ok</code></pre><p>Can you merge?</p>`],
  ["nbsp-trailing", `<p>Thanks!</p><p>&nbsp;</p>`],
  ["system-event", `<systemEventMessage/>`],
  ["emoji-only", `<emoji id="1f44d_thumbsup" alt="👍" title="Thumbs up"></emoji>`],
  ["link", `<p>Can you approve? <a href="https://x.example/a?b=1">https://x.example/a?b=1</a></p>`],
  ["raw-lt-text", `<p>Is 3 < 5 and can you check?</p>`],
  ["unclosed-p-list", `<p>Two things<ul><li>Can you send the deck?<li>Thanks</ul>`],
  ["stray-close", `</div><p>Can you sign?</p></span>`],
  ["curly", `<p>Can you send Dana&rsquo;s deck?</p>`],
];
let diff = 0;
for (const [id, html] of rows) {
  const a = old(html), b = now(html);
  const qa = asksSomething({ subject: "", bodyText: a } as never), qb = asksSomething({ subject: "", bodyText: b } as never);
  const same = a === b && qa === qb;
  if (!same) diff++;
  console.log(`${same ? "same" : "DIFF"} ${id.padEnd(30)} old=${JSON.stringify(a)} new=${JSON.stringify(b)} ask old/new=${qa}/${qb}`);
}
console.log(`rows=${rows.length} differ=${diff}`);
