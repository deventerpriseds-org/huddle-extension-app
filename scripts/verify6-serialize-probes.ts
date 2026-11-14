// WHAT:       Verifier loop 6: visibleHtml serialization (escaping, id passthrough), the Outlook reply-header cut and
//             <blockquote> removal after re-serialization, and pathological input (depth, size, garbage, timing,
//             never-throws).
// WHY:        6.4 fix pass: htmlToText now runs its old regex pipeline over parse5's re-serialized tree.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-6.md
// All data synthetic.
import { visibleHtml } from "../src/features/huddle/lib/external-feeds/html-visible";
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";

const show = (id: string, v: unknown) => console.log(`${id.padEnd(34)} ${JSON.stringify(v)}`);
// serialization
show("SER escape+id", visibleHtml(`<p id='x"y<z>'>a &amp; b &lt;c&gt; "q"</p>`));
show("SER literal tag text survives", htmlToText(`<p>Type &lt;div id="divRplyFwdMsg"&gt; then can you reply?</p>`));
show("SER double entity", htmlToText(`<p>&amp;amp; &amp;lt;b&amp;gt; can you?</p>`));
show("SER nbsp", htmlToText(`<p>a&nbsp;&nbsp;b can you?</p>`));
// Outlook reply header cut
const outlook = `<div>Can you sign the NDA?</div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Dana Kim<br><b>Sent:</b> Monday</font></div><div>Old: can you send the deck?</div>`;
show("CUT divRplyFwdMsg branch", htmlToText(outlook));
show("CUT divRplyFwdMsg main", mainHtml(outlook));
const aos = `<div>Can you sign the NDA?</div><div id="appendonsend"></div><hr><div>From: Dana<br>Old: can you send the deck?</div>`;
show("CUT appendonsend branch", htmlToText(aos));
show("CUT appendonsend main", mainHtml(aos));
const upper = `<DIV>Can you sign?</DIV><DIV ID=divRplyFwdMsg>From: x</DIV><DIV>old ask?</DIV>`;
show("CUT uppercase unquoted branch", htmlToText(upper));
show("CUT uppercase unquoted main", mainHtml(upper));
const hiddenHdr = `<div>Can you sign?</div><div style="display:none"><div id="divRplyFwdMsg">From: x</div></div><div>old ask: can you send?</div>`;
show("CUT header inside hidden branch", htmlToText(hiddenHdr));
show("CUT header inside hidden main", mainHtml(hiddenHdr));
// blockquote
const bq = `<p>New note.</p><blockquote type="cite"><p>old ask?</p><blockquote>older ask?</blockquote>still old</blockquote><p>Can you confirm?</p>`;
show("BQ nested branch", htmlToText(bq));
show("BQ nested main", mainHtml(bq));
show("BQ unclosed branch", htmlToText(`<p>Can you confirm?</p><blockquote><p>old ask?`));
show("BQ unclosed main", mainHtml(`<p>Can you confirm?</p><blockquote><p>old ask?`));
// pathological
const time = (id: string, f: () => string) => {
  const t = Date.now();
  let r: string, err = "";
  try { r = f(); } catch (e) { r = ""; err = String(e).slice(0, 80); }
  console.log(`${id.padEnd(34)} ms=${Date.now() - t} len=${r.length} tail=${JSON.stringify(r.slice(-40))}${err ? ` THREW ${err}` : ""}`);
};
time("PATH 399 divs", () => htmlToText("<div>".repeat(395) + "Can you sign?"));
time("PATH 405 divs", () => htmlToText("<div>".repeat(405) + "Can you sign?"));
time("PATH 20000 divs", () => htmlToText("<div>".repeat(20000) + "Can you sign?"));
time("PATH 20000 b", () => htmlToText("<b>".repeat(20000) + "Can you sign?"));
time("PATH 200000 i/b misnest", () => htmlToText("<i><b></i></b>".repeat(50000) + "Can you sign?"));
time("PATH 5MB text", () => htmlToText("<p>" + "word ".repeat(1_000_000) + "Can you sign?</p>"));
time("PATH 5MB tags", () => htmlToText("<span>x</span>".repeat(350_000) + "Can you sign?"));
time("PATH 50k tables", () => htmlToText("<table><tr><td>".repeat(3000) + "Can you sign?"));
time("PATH nul/surrogate", () => htmlToText("<p>\u0000a\ud800b<\u0000x>Can you sign?</p>"));
time("PATH garbage", () => htmlToText("<<<>>><!-- <![CDATA[ x ]]> <?php ?> </ > <a b=c d='e\" f>Can you sign?"));
time("PATH empty", () => htmlToText(""));
time("PATH non-string", () => htmlToText(undefined as unknown as string));
time("PATH style 1MB", () => htmlToText(`<div style="${"color:red;".repeat(100_000)}display:none">x</div><p>Can you sign?</p>`));
