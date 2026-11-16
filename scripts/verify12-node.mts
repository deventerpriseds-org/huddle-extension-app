// WHAT:       Verifier loop 12: visibleHtml under NODE (production runtime) on NEW real-looking bodies the implementer's
//             timing suite does not use -- cold first call + warm median of 3 -- for one tree (TREE=<dir with src/>).
// WHY:        Loop 11 refuted claim 1 on Node speed (prefixed body rebuilt per element). 13bce386 hoists it; re-derive.
// SUPERSEDES: verify11-node.mts for loop 12 (that file stays as the loop-11 record). SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-12.md
// Run: TREE=<dir> [ROW=<id>] node --experimental-strip-types scripts/verify12-node.mts      All data synthetic.
const { visibleHtml } = await import(`${process.env.TREE}/src/features/huddle/lib/external-feeds/html-visible.ts`);
const S = (s: string, n: number) => s.repeat(n);
const PRE = '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Preheader ZZHID</div>';
const ASK = "<p>Can you approve the budget?</p>";
// Gmail thread: each reply quotes the whole previous thread (nested gmail_quote blockquotes), 30 replies deep.
let thread = "<div dir=\"ltr\">First message body with a <a href=\"https://example.test/a\">link</a>.</div>";
for (let i = 0; i < 30; i++)
  thread = `<div dir="ltr">Reply ${i}: ${S("Some reasonable sentence about the plan. ", 20)}</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Nov ${i + 1}, 2026 at 9:${String(i).padStart(2, "0")} AM Person &lt;p${i}@example.test&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${thread}</blockquote></div>`;
const gmail = PRE + ASK + thread;
// Newsletter: nested layout tables, inline styles, many images with alt holding `>`, hidden spacer spans.
const card = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px"><tr><td style="padding:12px 24px;font-family:Arial,sans-serif;font-size:14px;line-height:20px;color:#333333"><img src="https://example.test/i.png" width="560" alt="Chart: sales > target" style="display:block;border:0"><h2 style="margin:0 0 8px">Headline</h2><p style="margin:0">Body copy of the story with a <a href="https://example.test/s?u=1&amp;t=2" style="color:#0066cc">read more &gt;</a></p><span style="display:none;font-size:0;max-height:0">ZZHID spacer</span></td></tr></table>';
const newsletter = PRE + '<center><table width="100%"><tr><td>' + S(card, 1500) + "</td></tr></table></center>" + ASK;
// Big table where EVERY cell tag holds a `>` in an attribute (every start tag is rewritten: max tagEdits).
const gtTable = PRE + "<table>" + S('<tr><td title="x>y" data-v="1>0">cell</td><td title="a > b">v</td></tr>', 12000) + "</table>" + ASK;
// Outlook body full of conditional comments + VML (many cuts) plus divRplyFwdMsg reply header and quoted history.
const outlook =
  '<html><head><style><!-- @font-face{font-family:"Cambria Math"} p.MsoNormal{margin:0in} --></style></head><body><div class=WordSection1>' +
  PRE + ASK +
  S('<p class=MsoNormal>Status line <b>ok</b><o:p></o:p></p><!--[if !supportLists]--><span style=\'mso-list:Ignore\'>1.<span style=\'font:7.0pt "Times New Roman"\'>&nbsp; </span></span><!--[endif]--><p class=MsoListParagraph>Item text here<o:p></o:p></p>\n', 4000) +
  '<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Someone<br><b>Sent:</b> Monday<br></font></div>' +
  S("<p class=MsoNormal>Quoted older history line.<o:p></o:p></p>", 6000) + "</div></body></html>";
// 1.4 MB plain-ish body with many short elements (worst element count per byte).
const manyEls = PRE + S("<span>a</span><i>b</i><br>", 70000) + ASK;
const rows: [string, string][] = [["gmail-thread-30", gmail], ["newsletter-1500", newsletter], ["gt-attr-table-12k", gtTable], ["outlook-lists-reply", outlook], ["many-elements-1.6MB", manyEls]];
const which = process.env.ROW;
for (const [id, h] of rows) {
  if (which && which !== id) continue;
  let t = performance.now();
  const v = visibleHtml(h);
  const cold = performance.now() - t;
  const ms: number[] = [];
  for (let i = 0; i < 3; i++) { t = performance.now(); visibleHtml(h); ms.push(performance.now() - t); }
  ms.sort((x, y) => x - y);
  console.log(`${id.padEnd(22)} ${String(Math.round(h.length / 1024)).padStart(5)}KB first=${Math.round(cold)}ms warm=${Math.round(ms[1])}ms hiddenCut=${!v.includes("ZZHID")} askKept=${v.includes("Can you approve the budget?")}`);
}
