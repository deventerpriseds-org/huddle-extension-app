// WHAT:       Verifier loop 7: the depth guard (keep text past depth 400; a hidden ancestor still hides) and the
//             quote/paren-aware CSS declaration split, on the branch's htmlToText vs origin/main's.
// WHY:        loop 6 refuted items 2 and 3 (deep text dropped; ';' inside a quoted CSS string split a declaration).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-7.md
// All data synthetic.
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { htmlToText as mainHtml } from "./verify5-main/onedrive-feed";
import { styleDeclarations } from "../src/features/huddle/lib/external-feeds/html-visible";

const ASK = "Can you approve the budget?";
const deep = (n: number, open: string, close: string, inner: string) => open.repeat(n) + inner + close.repeat(n);
const cases: [string, string, "keep" | "drop"][] = [
  ["405 divs, ask at bottom", deep(405, "<div>", "</div>", ASK), "keep"],
  ["600 divs", deep(600, "<div>", "</div>", ASK), "keep"],
  ["3000 td tables", deep(1000, "<table><tr><td>", "</td></tr></table>", ASK), "keep"],
  ["display:none ancestor at depth 10, ask at 600", deep(10, "<div>", "</div>", `<div style="display:none">${deep(600, "<div>", "</div>", ASK)}</div>`), "drop"],
  ["visibility:hidden ancestor at 10, ask at 600", deep(10, "<div>", "</div>", `<div style="visibility:hidden">${deep(600, "<div>", "</div>", ASK)}</div>`), "drop"],
  ["font-size:0 ancestor at 10, ask at 600", deep(10, "<div>", "</div>", `<div style="font-size:0">${deep(600, "<div>", "</div>", ASK)}</div>`), "drop"],
  ["hidden ancestor AT depth 399", deep(398, "<div>", "</div>", `<div hidden>${deep(50, "<div>", "</div>", ASK)}</div>`), "drop"],
  ["hidden ancestor at depth 402 (inside flatText)", deep(402, "<div>", "</div>", `<div style="display:none">${ASK}</div>`), "drop"],
  ["visibility:visible child under hidden, past 400", deep(10, "<div>", "</div>", `<div style="visibility:hidden">${deep(500, "<div>", "</div>", `<span style="visibility:visible">${ASK}</span>`)}</div>`), "keep"],
  ["CSS ; in double-quoted string", `<p style='font-family:"Arial;display:none;x"'>${ASK}</p>`, "keep"],
  ["CSS ; in single-quoted string", `<p style="font-family:'Arial;display:none;x'">${ASK}</p>`, "keep"],
  ["CSS ; inside url()", `<p style="background:url(a;display:none;b)">${ASK}</p>`, "keep"],
  ["CSS real display:none after string", `<p style="font-family:'A;B';display:none">${ASK}</p>`, "drop"],
  ["CSS escaped quote inside string", `<p style="content:'a\\';display:none;'">${ASK}</p>`, "keep"],
  ["CSS unterminated quote then display:none", `<p style="font-family:'Arial;display:none">${ASK}</p>`, "keep"],
  ["CSS unbalanced ( then display:none", `<p style="x:calc(1px;display:none">${ASK}</p>`, "keep"],
  ["CSS stray ) then display:none", `<p style="x:1px);display:none">${ASK}</p>`, "drop"],
];
let bad = 0;
for (const [id, html, want] of cases) {
  const t0 = Date.now();
  const b = htmlToText(html);
  const ms = Date.now() - t0;
  let m = "";
  try { m = mainHtml(html); } catch (e) { m = `THREW ${String(e).slice(0, 40)}`; }
  const has = b.includes(ASK);
  const ok = (want === "keep") === has;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BAD "} ${id.padEnd(50)} want=${want} branch=${has ? "keep" : "drop"} main=${m.includes(ASK) ? "keep" : "drop"} ${ms}ms`);
}
for (const s of [`font-family:'A;B';display:none`, `content:"a;b";color:red`, `x:url(a;b);display:block`]) console.log(JSON.stringify(s), "->", JSON.stringify([...styleDeclarations(s)]));
console.log(`cases=${cases.length} bad=${bad}`);
