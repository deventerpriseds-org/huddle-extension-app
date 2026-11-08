# WHAT:       Loop-2 verification, slice A (rendering A1-A3, regressions R1-R2) of chat-format at c335e3c.
# WHY:        Independent re-check after loop 1 (VERIFY-chat-format-1.md) refuted A2.
# SUPERSEDES: nothing (slice A of loop 2; loop 1 report stays as the record of loop 1).
# SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   scratch renders scripts/zz-cf2a.tsx, scripts/zz-cf2b.tsx (react-dom/server, not committed).

Subject: deventerpriseds-org/huddle-extension-app c335e3c (PR #149). Method: `renderToStaticMarkup(<ChatText text=.../>)` under bun.
No browser run (no Playwright against the deployed SWA in this slice).

## R1 — suites / tsc / build: CONFIRMED
chat-format 49/0, schedule-brief 80/0, priority-check 47/0, inbound-email 72/0, schedule-brief-dedupe 21/0, router-winners 39/0.
`npx tsc --noEmit -p .` rc=0. `npm run build` rc=0 ("You can preview this build using npx vite preview").

## R2 — other consumers / merge radius: CONFIRMED
- `git diff --stat 6487061 c335e3c` (what the merge of main brought): HuddleApp.tsx, PolishView/PolishSendSheet, Rail, ViewSwitcher,
  store, useWorkspaceSync, polish-*. **HuddleView.tsx is NOT in the merge diff** -- the brief's premise that the merge changed
  HuddleView is wrong; it was only changed by the branch's own commits.
- HuddleApp merge hunk: adds `polish` view + FULL_WIDTH_VIEWS gating of Sidebar/ContextPanel only for `polish`; no chat consumer touched.
- HuddleView consumers of chat-format: lines 57-58 import, 977 `normalizeChatText(ask.replyBody)`, 1076 `noticeText`, 1080
  `stripRepeatedDraft`, 1130 `<ChatText>`. tsc/build green with all of them.

## A1 — Markdown -> React elements, no HTML injection, non-http(s) never a link: CONFIRMED (one minor link defect)
- Representative: `**Up next**`/`code`/zoom URL/`- one`/`1. a` -> `<strong>`, `<code>`, `<a href="https://zoom.us/j/1?pwd=x" rel="noopener noreferrer">zoom.us/j/1</a>`
  with the trailing "." outside the link, `<ul>`, `<ol>`.
- Injection: `<img src=x onerror=alert(1)>` -> escaped `&lt;img ...&gt;`; `**<b>x</b>**` -> `<strong>&lt;b&gt;x&lt;/b&gt;</strong>`;
  `[evil](https://a.com/"onmouseover=alert(1))` -> href attribute-escaped `&quot;`, no attribute break-out.
- Non-http: `[click](javascript:alert(1))`, bare `javascript:alert(1)`, `[d](data:text/html,x)`, `ftp://a.b/c` -> all plain text.
- Minor defect (not a safety issue): `(https://en.wikipedia.org/wiki/Foo_(bar))` -> href `https://en.wikipedia.org/wiki/Foo_`
  (URL regex excludes `(`/`)`), so a parenthesised URL links to the wrong page. Also label of `https://x.com/a"b` shows `x.com/a%22b`.

## A3 — non-Markdown text not mis-parsed: CONFIRMED
`-5 degrees today`, `-- signed`, `*emphasis* and * not list`, `2 * 3 * 4 = 24`, `2024. was a good year`, `9.30 meeting`,
`#Launch day`, `Just a normal sentence with a > sign and a # hash and 3) things.` -> all plain `<p>`, text unchanged.
Revenue line `1,234.56 up 3.5% — 2024-11-05 at 9:30. Pay $1.00 now` byte-identical in output.

## A2 — blank lines between bullets -> one list; words/numbers never altered; user bubble unchanged: REFUTED (new, narrower defect)
Loop-1 inputs, all FIXED:
- `"1. first\n\nnote\n\n3. third"` -> `<ol><li>first</li></ol><p>note</p><ol start="3"><li>third</li></ol>`.
- `">50% of tasks done"` -> `<p>&gt;50% of tasks done</p>`; `"> quoted line\n> second"` still a blockquote.
- `"# of tasks: 5"` -> `<p># of tasks: 5</p>`; `"## Today"` still a heading.
- `"call __init__ then __main__"` -> unchanged `<p>`.
- `"- a\n\n- b\n\n\n- c"` and `"1. a\n\n2. b\n\n3. c"` -> one list each. User bubble (HuddleView ~1049) still `{m.text}`, unchanged vs merge-base c6c4fc6.

New adversarial -- **only the FIRST number of a contiguous ordered list is kept; every later number the agent wrote is discarded**
(ChatText renders `<li>` with no `value`):
- `"3. a\n2. b\n1. c"` (a countdown) -> `<ol start="3">` -> browser shows **3, 4, 5** -- meaning inverted.
- `"1. a\n3. b\n7. c"` -> shows 1, 2, 3 (3 and 7 lost).
- `"0. zero\n1. one"` -> `start = parseInt("0") || 1` = 1 -> shows 1, 2 (chat-format.ts parseChatBlocks, the `|| 1`).
- (`"1. a\n1. b\n1. c"` -> 1,2,3 is standard Markdown lazy numbering, arguably fine.)
Lesser: nested bullets `- a\n  - nested` flatten into one level (words kept); `"> - a"` stays a quote with literal "- a";
`"200. items shipped"` becomes a one-item list starting at 200 (number still shown).

Slice verdict: FIX FIRST — A2 per-item ordered-list numbers discarded (countdown 3,2,1 renders 3,4,5; `0.` renders 1); optional: A1 parenthesised URL href truncated
