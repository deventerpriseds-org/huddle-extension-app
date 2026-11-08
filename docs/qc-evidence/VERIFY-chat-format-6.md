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

## Re-checks at reduced depth (scratch `scripts/zz-v6b.tsx`, not committed)

- **A2 CONFIRMED.** `Pay $1,234.56 by 10/05 — 3 of 12 tasks, 7:00 PM, v2.3.1, 50% (≈ 0.5), O'Brien & Co.` plus a bullet and a numbered line, rendered through react-dom/server: every token present in the output text (`every token kept: true`).
- **B1 CONFIRMED.** `briefDeliveryPlan` on 80 meetings with 200-char titles and 200-char locations: directive 3,902 chars, appendBlock 4,266 chars, 25 bullets plus `…and 55 more — the "Open Schedule" button below shows them all.` `joinOpenerAndBlock` given a model reply that copied the list: the opener is kept and `Meeting 1 ` appears on exactly 1 line. `priorityAppendBlock({count:9, top:6…})`: 3 bullets plus `9 open priorities (6 more not shown): 2 past due, 1 blocked, 3 not yet scheduled.`; count 0 gives `undefined`.
- **B2 CONFIRMED.** Empty day -> kind `nothing-scheduled`, directive `Today (2026-10-05) — nothing is on the calendar…`. Window `after_work 17-22` -> `the after work window (5 PM–10 PM) — what is still ahead`.
- **B3 CONFIRMED.** No items plus a 5,000-char `meetings: Graph 403…` error -> kind `read-error`, directive 765 chars (error clipped), text `the schedule brief could NOT read: meetings.`
- **C1 CONFIRMED.** A full draft copy with a `**Suggested reply:**` label -> `"Here's a draft."`. A paraphrased middle -> text returned unchanged (`true`).
- **E1 CONFIRMED.** `noticeText`: `(couldn't respond — quota)` and the curly-apostrophe form -> notice; `(fallback: gpt-4o (TPM): Limit) …` -> notice. Over-match negatives `(couldn't respond - quota)`, `I couldn't respond earlier — sorry`, `(fallback plan: Zoom)`, `Fallback: use Zoom` -> `null`. HuddleView at ca5c02e (lines 1148-1259): `notice` swaps ONLY the text body for the grey box. `ConfirmAskRow`, `EmailReplyRow`, `NavLinkButton` and artifact chips are rendered outside that ternary, so they stay on a failure row. `stripRepeatedDraft` is applied only when `m.emailReply.replyBody` exists. The main merge (#169/#173) did not change this path.

## R1 suites -> CONFIRMED (build NOT REACHED)
At ca5c02e after `npm ci --ignore-scripts`: all 63 `test:*` scripts PASS=63 FAIL=0 (chat-format 90 passed, 0 failed). `npx tsc --noEmit -p .` rc=0, 0 errors. `npm run build` was not re-run this loop because of the time budget.

## R2 other consumers -> CONFIRMED at the HuddleView level
The only renderer consumers are HuddleView MessageRow (`noticeText`, `stripRepeatedDraft`, `ChatText`) as read above. `CopyMessageButton` still copies the raw `m.text`. No new consumers were traced beyond loop 5 in this pass.

## Verdict
Overall verdict: FIX FIRST — A1: `**https://x.com/a**` link not bold (S-27 asks for bold AND clickable); `**bold *it* bold**` shows literal `**`; a URL inside bold with other words (`**see https://x.com/a now**`) is not clickable; `Best,\` backslash hard break shows the backslash (S-37b). Root cause: the bold body is never re-parsed for inline content.
