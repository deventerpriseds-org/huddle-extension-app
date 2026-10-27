// WHAT:       Proves a saved reply draft keeps the owner's line breaks and blank lines, is Calibri 11pt,
//             sits ABOVE the quoted original, and that Save to Drafts no longer sends a plain `comment`.
// WHY:        Owner, 2026-10-27: "the draft it creates is all one block with no new line spacing and the
//             font is random instead of being calibri size 11 font".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:draft-formatting. Run: bun scripts/draft-html.test.ts

import { insertReplyIntoBody, replyTextToHtml } from "../src/features/huddle/lib/email/draft-html";
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const reply =
  "Hi Amy,\n\nThank you — I'm looking forward to it.\nTomorrow at 11am works.\n\nBest,\nVon";
const html = replyTextToHtml(reply);
const paras = html.match(/<p style="margin:0">.*?<\/p>/g) ?? [];

check(
  "D1 one paragraph per line (7 lines incl. 2 blank)",
  paras.length === 7,
  `got ${paras.length}`,
);
check(
  "D2 blank lines become &nbsp; paragraphs",
  paras[1]?.includes("&nbsp;") && paras[4]?.includes("&nbsp;"),
  paras.join(" | "),
);
check(
  "D3 text lines keep their own paragraph",
  paras[2]?.includes("looking forward") && paras[3]?.includes("11am"),
);
check(
  "D4 Calibri 11pt wrapper",
  /font-family:Calibri[^"]*font-size:11pt/.test(html),
  html.slice(0, 120),
);
check("D5 HTML is escaped", replyTextToHtml("a <b> & c").includes("a &lt;b&gt; &amp; c"));
check("D6 CRLF handled like LF", replyTextToHtml("a\r\n\r\nb").match(/<p /g)?.length === 3);

const quoted =
  '<html><head></head><body dir="ltr"><div id="divRplyFwdMsg">From: Amy</div></body></html>';
const merged = insertReplyIntoBody(quoted, html);
check(
  "D7 reply goes right after <body>, before the quoted original",
  merged.indexOf("Hi Amy") > merged.indexOf("<body") &&
    merged.indexOf("Hi Amy") < merged.indexOf("divRplyFwdMsg"),
);
check(
  "D8 quoted original is preserved",
  merged.includes('<div id="divRplyFwdMsg">From: Amy</div>'),
);
check(
  "D9 no <body> tag -> reply prepended",
  insertReplyIntoBody("<div>q</div>", html).startsWith(html),
);

const graph = readFileSync("src/features/huddle/lib/email/graph-email.server.ts", "utf8");
check("D10 createReply is never given a plain `comment`", !/\bcomment\s*:/.test(graph));
check(
  "D11 the draft body is PATCHed as HTML from replyTextToHtml",
  /contentType: "HTML",\s*content: insertReplyIntoBody\(quoted, replyTextToHtml\(bodyText\)\)/.test(
    graph,
  ),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
