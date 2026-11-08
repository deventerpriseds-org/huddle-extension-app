# VERIFY chat-format loop 6

- WHAT: independent verification of deventerpriseds-org/huddle-extension-app ca5c02e (PR #149 squash) against `docs/qc-evidence/AC-chat-format.md`.
- WHY: loop 5 found A1/A3 defects (S-13, S-26, S-27, S-32); dd7323c1 (squashed into ca5c02e) claims to fix them.
- SUPERSEDES: VERIFY-chat-format-5.md (loop 5). SUPERSEDED-BY: nothing, current.
- EVIDENCE: scratch harness `scripts/zz-v6.tsx` (react-dom/server `renderToStaticMarkup(<ChatText/>)`, class/style attrs stripped for reading), run with `npx bun`. Not committed.

## A1 rendering: full re-derivation of S-1..S-46 plus attacks -> REFUTED (4 residual misses)

Observed (exact output, classes stripped):

| row | input | output | AC expected | result |
|---|---|---|---|---|
| S-13 | `***really***` | `<strong><em>really</em></strong>` | bold-italic, no `*` | FIXED |
| S-13b | `**_y_**` | `<strong><em>y</em></strong>` | same | FIXED |
| S-26 | `<https://x.com>` | `<a href="https://x.com">x.com</a>` | link, no `<` `>` | FIXED |
| S-27 | `**https://x.com/a**` | `<a href="https://x.com/a">x.com/a</a>` (NO `<strong>`) | "bold AND clickable" | **PARTIAL: clickable, not bold** |
| S-37b | `Best,\\\nVon` (backslash hard break) | `<p>Best,\<br/>Von</p>` | "no visible spaces or backslash" | **MISS: backslash visible** |
| X24 | `**bold *it* bold**` | `<p>**bold <em>it</em> bold**</p>` | S-9: bold, no `*` visible | **MISS: literal `**` shown** |
| X6 | `**see https://x.com/a now**` | `<strong>see https://x.com/a now</strong>`, no `<a>` | S-22/S-27: URL clickable | **MISS: URL not clickable** (also X19 `**https://x.com/a b**`, X20 `***https://x.com***`) |

Cause, read from `src/features/huddle/lib/chat-format.ts` INLINE_RE: groups 1/2 are `[^*\n]+?` and the bold body is pushed as a plain string (`{t:"bold", v}`), never re-parsed for inline. So nothing inside bold (a URL, an `*italic*`) is processed, and a `*` inside bold makes group 2 fail to match at all. The S-27 fix special-cases a bold body that is exactly one URL and emits a bare link, dropping the bold.

Everything else in the table PASSED: S-1..S-6, S-9a-c, S-11, S-12, S-14, S-15, S-17, S-19..S-25, S-33..S-35, S-37, S-38, S-41 as specified. Declared-literal rows behave as declared: S-7 flattened with words intact, S-8 `[ ]` literal, S-10 `__x__` literal, S-39 table literal, S-40 `---`/`***` literal.
Security: S-28 `javascript:`/`data:` stay text; S-29 `<b>`/`<img onerror>` escaped text; X5 `<javascript:alert(1)>` text; X25 `<ftp://…>` text; X17/X18 a `"` in the href is attribute-escaped by React (`&quot;`), no attribute injection.
New `<` rule attacks: X1 `I <3 you`, X2 `a < b > c`, X27 `5 < 7 and <3 <https://a.io> ok` all literal except the real autolink; X21 `<https://x.com>>` link plus a literal `>`.
New `***` attacks: X7 `foo***bar***baz` and X8 `2***3***4` become bold-italic mid-word (CommonMark would also emphasise X7; X8 `2***3***4` is arguable but words are intact, no `*` lost visibly). X9 `***` alone stays literal. X32 `2*3*4` and `a_b_c` stay literal.
Fence: X22 inner whitespace and blank lines kept exactly; X23 an unclosed fence becomes `<pre>` of the rest (no words lost).
Perf S-42: 400 bullets / 55,549 chars rendered in 24.5 ms.

## A3 plain text not mis-parsed -> CONFIRMED

| input | output |
|---|---|
| S-32a `Note here.\n10. That's the deadline` | one `<p>` (no list) |
| S-32b `2026. What a year` | `<p>` |
| S-32c `Steps:\n2. a` | `<p>Steps:</p><ol start="2">` (still a list) |
| S-32d `Intro.\n1. a` | `<p>Intro.</p><ol>` (still a list) |
| X11 `Note.\n2. second\n3. third` | one `<p>` (CommonMark agrees: a non-1 item cannot interrupt a paragraph) |
| X13 `Note.\n10) deadline`, X28 `Day 1.\n2. Two`, X31 `Total: 3 items.\n2. Second` | `<p>` |
| X14 `Lead:\n10. x\n11. y` | `<ol start="10">` 10, 11 |
| S-16, S-18, S-33 `-5°F`, S-34 emoji lines | literal text as specified |

Noted, not a defect: X29 `Hi.\n\n10. That's` (blank line first) becomes `<ol start="10">`; CommonMark does the same after a blank line. X16 `1. a\nNote\n2. b` renders `2. b` as paragraph text, words intact.
