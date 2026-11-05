# WHAT:       Verifier loop 3, slice A (A1-A3, R1, R2) for chat-format, subject 3a0cd80 (PR #149).
# WHY:        Independent re-check of loop 2's REFUTED A2 (list numbering) and the A1 URL-with-parens bug.
# SUPERSEDES: nothing (loop 2 reports stay as history).
# SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   react-dom/server render of ChatText via scratch scripts/zz-verify3a.tsx (not committed).

## A2 — list numbering + blank lines (FULL RE-DERIVATION) — CONFIRMED
renderToStaticMarkup(<ChatText/>) at 3a0cd80:
- "3. a\n2. b\n1. c" -> `<ol start="3"><li value="3">a</li><li value="2">b</li><li value="1">c</li>`
- "1. a\n3. b\n7. c" -> `<ol><li value="1">a</li><li value="3">b</li><li value="7">c</li>`
- "0. zero\n1. one" -> `<ol start="0"><li value="0">zero</li><li value="1">one</li>`
- "• one\n\n• two\n\n• three" -> one `<ul>` with 3 `<li>`; "1. one\n\n2. two\n\n3. three" -> one `<ol>` values 1,2,3
- "Paid $1,234.50 on 3/4; 12.5% up, 007 ids, 1e10, -3" -> unchanged `<p>`; "1.5 hours left\n2.0 is out" -> `<p>` with `<br/>`
- Edge (cosmetic, not blocking): "007. bond" renders marker 7 (leading zeros dropped from the list MARKER only).

## A1 — inline rendering / URL parens — CONFIRMED for bare URLs; one sibling spelling REFUTED (minor)
- "(https://en.wikipedia.org/wiki/Foo_(bar))" -> `(<a href="https://en.wikipedia.org/wiki/Foo_(bar)">…</a>)` FIXED
- "(see https://a.io/x)." -> href `https://a.io/x`, text `).` OK; "https://a.io/x)" -> href `https://a.io/x` + `)` OK
- "https://a.io/x))." / "https://a.io/(x" / "Go to https://a.io/x(, ok" -> unbalanced parens left outside the href, OK
- XSS: `<script>`, `<img onerror>`, `javascript:` bare and in `[x](javascript:…)`, `data:`, `ftp:`, `mailto:`, `//a.io`, `HTTPS://` -> all escaped plain text, no link; `https://a.io/x" onmouseover="…` -> href `https://a.io/x`, rest escaped text.
- **REFUTED (minor): Markdown link with parens in URL.** "[docs](https://a.io/p_(q))" -> `<a href="https://a.io/p_(q">docs</a>)` — broken href and a stray `)`. The md-link branch of INLINE_RE still uses `[^\s)]+`; 544c002 fixed only the bare-URL branch. Wikipedia-style links in `[label](url)` form hit this.
- Minor/not new: nested parens "https://a.io/a_(b_(c))" -> href `https://a.io/a_` (one level of balance only). "**[x](https://a.io/y)**" -> bold literal `[x](https://a.io/y)`, no link (no nesting).

## A3 — non-Markdown text — CONFIRMED
"# of tasks: 5\n>50% done\n2*3*4 = 24\nsnake __init__ and a_b_c" -> single `<p>` with `<br/>`, every char intact.

## R1 — suites / tsc / build — CONFIRMED
`npx tsc --noEmit -p .` rc=0, empty output; `npm run build` rc=0 (nitro "You can preview this build").
chat-format 64/0, schedule-brief 82/0, priority-check 47/0, inbound-email 72/0, schedule-brief-dedupe 21/0, router-winners 39/0, polish-core all passed.

## R2 — consumers — CONFIRMED
Consumers of chat-format: HuddleView (ChatText, normalizeChatText, noticeText, stripRepeatedDraft), priority-check.server (bulletSection), schedule-brief-run.server (bulletSection, spacedClock), huddle.functions (joinOpenerAndBlock). HuddleView diff 544c002~1..3a0cd80 = 0 lines (user bubble untouched). 8986387 (Polish ecosystem) touches no chat-format file and polish code imports none of it; polish-core test passes.

## Slice verdict
FIX FIRST — md-link `[label](url_(x))` href truncated (INLINE_RE md-link branch `[^\s)]+`). Everything else CONFIRMED.
