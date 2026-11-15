// WHAT:       Verifier loop 9: NEW quote / attribute shapes for claim 1d (built independently of the loop-8 set), shared
//             by the Chromium recorder (verify9-chromium-record.mjs) and the probe (verify9-quote-probes.ts).
// WHY:        1c0171d7 lets a quote open a quoted run only right after `=` (optionally whitespace). A browser opens a
//             quoted value only in the "before attribute value" state, i.e. right after an attribute NAME and `=`.
//             These shapes put `=` + quote where the browser is NOT in that state (inside an unquoted value, a second
//             `=`, an attribute name that starts with `=`, a tag name), plus controls the fix must keep right.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-9.md
// All data synthetic.
export const ASK = "Can you approve the budget?";

export const SHAPES9 = [
  // --- `=` + quote where the browser is NOT before an attribute value (expected: branch differs from Chromium) ---
  ["eq-in-unquoted-value-sq", `<p><a href=https://files.example/view?id='q4>Q4 file</a> Can you approve the budget? It's due Friday.</p>`],
  ["eq-in-unquoted-value-dq", `<p><a href=https://files.example/view?id="q4>Q4 file</a> Can you approve the budget? He said "yes" already.</p>`],
  ["double-eq-sq", `<p><span title=='x>Dana's note:</span> Can you approve the budget? it's urgent</p>`],
  ["attr-name-starts-eq", `<p><b class="hi" ='x>Lee's list</b> Can you approve the budget? it's due</p>`],
  ["after-quoted-value-eq", `<p><b class="hi"='x>Lee's list</b> Can you approve the budget? it's due</p>`],
  ["tag-name-eq", `<p><b='x>Lee's list</b> Can you approve the budget? it's due</p>`],
  ["eq-in-unquoted-ws-sq", `<p><img src=cid:logo alt=a= 'b>Pat's update: Can you approve the budget? it's late</p>`],
  ["end-tag-eq-sq", `<p><b>Hi</b x='y> there. Can you approve the budget? it's due</p>`],
  ["after-quoted-value-eq-ask", `<p><b class="hi"='x>Can you approve the budget? it's due</b></p>`],
  ["double-eq-ask", `<div><span title=='x>Can you approve the budget? it's urgent</span></div>`],
  ["ask-only-after-swallow", `<p><a href=x.example/?a='1>link</a></p><p>Can you approve the budget? it's due today</p>`],
  // --- the browser DOES open a quoted value (branch should match Chromium; main differs) ---
  ["ws-before-and-after-eq", `<p><img alt = 'a > b' src=x>Can you approve the budget?</p>`],
  ["newline-after-eq", `<p><img alt=\n"a > b">Can you approve the budget?</p>`],
  ["tab-after-eq-sq", `<p><img alt=\t'a > b'>Can you approve the budget?</p>`],
  ["unterminated-dq-to-later-dq", `<p><span title="x>Hidden by the parser</span> more</p><p class="y">Can you approve the budget?</p>`],
  ["gt-in-sq-title", `<p><a title='1 > 0' href="x">ok</a> Can you approve the budget?</p>`],
  ["empty-values", `<p><b x="" y='' z=>Can you approve the budget?</b></p>`],
  // --- quotes that are ordinary characters (all three should agree) ---
  ["backtick-value", "<p><b x=`it's`>Can you approve the budget? it's due</b></p>"],
  ["quote-in-name", `<p><b x"y=1>Can you approve the budget? he said "now"</b></p>`],
  ["quote-after-quoted-value", `<p><b x="1"'y>Can you approve the budget? it's due</b></p>`],
  ["unquoted-style-with-sq-inside", `<p><span style=font-family:'Segoe UI'>Can you approve the budget? it's due</span></p>`],
  ["onclick-unquoted", `<p><a onclick=alert('x') href=#>Open</a> Can you approve the budget? it's due</p>`],
  ["entity-quote-in-value", `<p><b title=&quot;x>Can you approve the budget? it&#39;s due</b></p>`],
  ["slash-quote", `<p><br/'>Can you approve the budget? it's due</p>`],
  // --- realistic Outlook / Gmail attribute forms (controls) ---
  ["outlook-msonormal", `<p class=MsoNormal><span style='font-size:11.0pt;font-family:"Calibri",sans-serif'>Can you approve the budget?<o:p></o:p></span></p>`],
  ["gmail-dir-ltr", `<div dir="ltr"><div class="gmail_default" style="font-family:arial,sans-serif">Can you approve the budget? It's due.</div></div>`],
  ["mailto-sq-in-dq", `<p><a href="mailto:o'neil@corp.example">Dana O'Neil</a> wrote to us. Can you approve the budget?</p>`],
  ["unquoted-url-query-eq", `<p><a href=https://x.example/?a=1&b=2>link</a> Can you approve the budget? it's due</p>`],
];
