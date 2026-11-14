<!--
WHAT:          Independent verification (loop 6) of claude_task-proposals @ d849f0da: full re-derivation of the
               loop-5 REFUTED items (6.4 / F1-F3 class via parse5 html-visible.ts, claim 16 U1/U4, X3-X6) plus a
               reduced-depth re-check of everything loop 5 confirmed, and the flags-OFF live-change table.
WHY:           Tier 1 (model output stored as proposals; live work-email screen + main-mailbox newTextOnly touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-5.md (origin/claude_verify-correspondence-proposals-5 @ b4e76df7)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-5-*.ts (earlier loops) and scripts/verify6-*.ts (this loop)
-->

# VERIFY correspondence-proposals, loop 6

Started 2026-11-14 02:16 UTC, budget 2.5 h (ends 04:46 UTC). Isolated worktree, branch
`claude_verify-correspondence-proposals-6` started from the target **d849f0da** (`git diff d849f0da HEAD -- src` is empty;
the only additions are this file, loop 5's report and the loop 3-5 probe scripts copied from b4e76df7).
origin/main at start: 90e84d1c (the target is 6 commits behind main, 83 ahead). No live system touched; synthetic
`.example` data only.

**Restart note (02:17 UTC):** the stub above came from a stopped earlier start; this run continues the same branch
(fetched 1469ff19) and keeps the budget end at 04:46 UTC. `node_modules` is a symlink to the main checkout's tree
(parse5 7.3.0 present there; ignored by git).

## Claim 0: full suite re-run at d849f0da

| suite | implementer | observed |
|---|---|---|
| task-proposals | 204/0 | 204 passed, 0 failed |
| redteam-correspondence | 76/0 | 76/0 |
| inbound-email | 72/0 | 72/0 |
| correspondence-ingest | 149/0 | 149/0 |
| cross-app-turn-gate | 92/0 | 92/0 |
| feed-staleness | 96/0 | 96/0 |
| proposals-preview | 6/0 | 6/0 |
| onedrive-feed-truth | 11/0 | 11/0 |
| html-visible-loop5 | 9/0 | 9/0 |
| onedrive-feed / attention / attention-focus / confirm-ask-context | -- | 61 PASS lines "all passed" / all passed / all passed / 21/21 |
| feed-staleness-sql (local PG 16) | 23/0 | 23/0 |
| task-proposals-sql | 45/0 | 45/0 |
| correspondence-ledger-sql | 50/0 | 50/0 |
| fireflies-queue-sql | -- | all passed |
| fireflies-minutes | -- | 3 FAIL (G3, G5, G8) -- **identical on origin/main 90e84d1c** (run from a `git archive` of main); pre-existing |
| `tsc --noEmit` | -- | exit 0, no output |

Every implementer count reproduces exactly.

---

## RETARGET (~02:22 UTC) -- target is now ddc7b55d (= d849f0da + 1 commit)

Coordinator update: verify at **ddc7b55d**. Merged into this branch (e130d663); `git diff ddc7b55d HEAD -- src
scripts/redteam-correspondence.test.ts` is empty. The one commit (owner 2026-11-14, "Iris's current email alerts are
already good"): `newTextOnly` no longer joins a two-line attribution; `isWrappedAttribution` is exported and tested
directly through a `wrapDetected` helper.

### Claim 0 re-run at ddc7b55d

All in-memory suites as above, except **redteam-correspondence 77/0** (was 76). The others are unchanged:
task-proposals 204, inbound-email 72, ingest 149, cross-app 92, feed-staleness 96, preview 6, truth 11,
html-visible-loop5 9, confirm-ask 21/21, onedrive-feed / attention / attention-focus all passed. SQL suites: 23/0, 45/0, 50/0.
`tsc --noEmit` exit 0.

### Claim (a): `newTextOnly` matches main on every wrapped-attribution shape -- CONFIRMED

- Literal sweep (`scripts/verify5-literal-sweep.ts` over the inbound-email, redteam, ingest and task-proposals suites):
  **1502 literals, 13 differ**. All 13 are the owner-approved non-English quoted history: 7 one-line foreign
  attributions (fr/de/es/it/nl/pt/sv) and 6 foreign header blocks. The 6 two-line wrapped rows that differed in loop 5
  now produce **identical output to main**.
- `scripts/verify6-wrapped-probes.ts`: 22 wrapped shapes x (branch vs main). **live == main on 22/22**. The shapes:
  Gmail with email / name-only / 24 h / name split across the wrap; Apple Mail with email / name / iPhone 24 h;
  Outlook-mobile with an offset; Thunderbird numeric; no-year and no-time stamps; X3-X6; three new English sentences;
  lowercase-name; `I`; no date.
- The detector, which no live path calls any more, cuts real stamps and keeps X3-X6. **Residues, non-blocking**:
  - `On May 3 at 9:30 the 2024 board met and Legal` / `wrote:`, `On Sat 4 at 10:15 for the 2025 audit our CFO` /
    `wrote:` and `On Mar 9 the 2025 deadline moved to 17:00 and Finance` / `wrote:` are still detected, because the
    year AND clock are present, `May/Sat/Mar` are month or day names, and a capitalised word comes before `wrote:`.
  - Thunderbird's `On 11/10/25 9:14 AM, Dana Kim` / `wrote:` is not detected, because there is no month or day name.
    This is the keep direction.
- **Observation**: `isWrappedAttribution` has **no caller in `src/`** (grep: its only callers are the definition and
  `scripts/redteam-correspondence.test.ts`). The comment at `inbound-email.ts:150` says it is "kept for the
  correspondence report's own thread logic", and no such caller exists. It is dead code at ddc7b55d: harmless, but
  the comment is inaccurate.

### Claim (b): the rewritten tests are not weakened -- CONFIRMED

Diff read: one assertion was removed, the `en-2line` row in the "still cut" list. Every other change:
- turns a live-screen "cut" expectation into a detector expectation (`wrapDetected`), or
- adds the opposite live-screen expectation, RT-12c `[true, true]` and the new "live screen keeps ... exactly as main"
  test over all 5 `wrappedCuts`.

The live expectation flipped because of the owner's decision. It was not loosened: it is now asserted in the other
direction.

Mutation proofs (`mutate.sh`, anchors/replacements in files, `inbound-email.ts`):

| mutation | named test | verdict | exit |
|---|---|---|---|
| reinstate the live join (`if (i + 1 < lines.length && isWrappedAttribution(l, lines[i + 1])) break;`) | D2 owner 2026-11-14: ...and the live screen keeps | FIRED (control EQUIVALENT) | 0 |
| drop the year AND clock rule (`if (false && !(YEAR...CLOCK...))`) | D2 X1-X6 hard-wrapped English lines | FIRED (control EQUIVALENT) | 0 |
| drop the email shortcut (`if (false && EMAIL.test(joined))`) | D2 real two-line wrapped attributions are still DETECTED | FIRED (control EQUIVALENT) | 0 |

**Finding, non-blocking, test infrastructure:** `scripts/redteam-correspondence.test.ts` never sets a non-zero exit
code. It ends with `console.log(... passed, ... failed)` and has no `process.exit(1)`, unlike inbound-email,
task-proposals, feed-staleness, truth and html-visible-loop5, which all have `if (fail) process.exit(1)`. mutate.sh
reported "the suite exited 0" while an assertion was failing. Any check that reads only the exit code would pass a
red redteam suite. The file was written as a findings probe, where a FAIL line is a finding. It is now used as a
regression suite (the claimed 77/0), so it needs the same exit line.
(Process note: my first three mutate runs used the pattern `FAIL` instead of a test name and reported INERT. They
were invalid, and I re-ran them with the test names above.)

## 6.4 / F1-F3 class: parse5 `html-visible.ts` -- loop-5 shapes FIXED; the class is CLOSED for tree-shape bugs; minor residues

### Loop 5's 88 Chromium rows, re-scored at ddc7b55d (`bun scripts/verify5-html-compare.ts`)

Branch: **83 OK / 3 KEEP+ / 2 DROP** (loop 5: 47 / 16 / 25). The 23 regressions vs main loop 5 blocked on are **all
gone**: F1-F3, C1-C3, K1-K2 and G1 now match Chromium exactly. What remains:
- 2 DROP: `CSS-opacity-pct` and its `#quirks` row, i.e. `opacity:0%`. This is the deliberate hide, judged below.
- 3 KEEP+: the F-shapes in QUIRKS mode only (`FMT-font-p-table#quirks`, `FMT-b-p-table#quirks`,
  `FMT-strong-p-table-text-after#quirks`). Chromium-quirks hides the ask; the branch shows it. Keep-more direction.

### 130 NEW Chromium rows (`scripts/verify6-html-cases.mjs` -> `scripts/verify6-html-truth.json`, 65 shapes x {doctype, quirks})

Same extraction as loop 5 (blockquotes removed, `body.innerText`). One refinement: when `<html>` or `<body>` itself
is not rendered (`checkVisibility()` false), the row records "". That is because innerText of a non-rendered element
falls back to textContent, which a reader does not see. The raw value is kept as `innerTextRaw`.

Branch: **102 OK / 10 KEEP+ / 18 DROP**. Main: 60 OK / 64 KEEP+ / 6 DROP.

**Matches Chromium exactly (OK), both modes**, these groups:
- **Nesting:**
  - deep formatting nesting;
  - a hidden deep subtree followed by a visible sibling;
  - mis-nested `<b><i>`, and the adoption agency with a hidden `<b>` or `<i>` (the re-opened clone is visible, and the
    branch shows it);
  - a hidden `<b>`/`<a>`/`<font>` wrapping a block, including a stray `</p>`;
  - an unclosed hidden span in a td followed by the next td;
  - `<p>` implied-closed by a hidden div;
  - 390 nested divs.
- **Special elements:** `<template>`, `<noscript>`, SVG `<text>`, hidden `<svg>`, SVG `<title>`, `<foreignObject>`,
  `<select>`, `<details open>`, `<dialog open>`, `<object>` fallback, `<iframe srcdoc>`, `<xmp>`, `<![if !mso]>`,
  and MJML `<!--[if !mso]><!-->`.
- **Foster parenting:** text before rows; a hidden span; an unclosed hidden `<b>` before a cell (the cell marker stops
  re-opening); a hidden `<b>` after the rows; and an unclosed hidden `<b>` re-opened after the table, which Chromium
  hides and the branch hides too. Also hidden `<td>`, `<tr hidden>` and `<li hidden>`.
- **`<html>`/`<body>`:** `<body hidden>`, `<html hidden>`, `<body style="display:none">`, a `visibility:hidden` body
  with a `visible` child, `<body hidden style="display:block">`, and a `<title>` in the head.
- **CSS:** `hidden="until-found"`, `hidden` + `display:block`, `DISPLAY: NONE`, `display : none ! important ;
  display:block`, `opacity:0.01`, `display:contents`, `height:0;overflow:hidden`, and `;` inside a CSS comment.
- **Entities:** `&amp;`/`&lt;`, double-escaped `&amp;lt;` (shown as `&lt;`, as in a browser; main shows `<b>`), and a
  raw `<` in text.

**KEEP+ (10), all the same on main:**
- `<textarea>` content;
- closed `<details>` body;
- closed `<dialog>`;
- `display:n\one` (a CSS escape);
- `content-visibility:hidden`.

All are the keep-more direction: hidden text is shown, no ask is lost.

**DROP (18), by cause:**

| rows | cause | defect? |
|---|---|---|
| `MATH` x2 | Chromium renders `<mi>x</mi>` as the math-italic `𝑥`; the branch gives `x` (same on main) | no -- a scoring artefact |
| `BODY-font0-child-sized` x2, `CSS-font-0-shorthand` x2 (`font:0/0 a`) | font-size:0 text; innerText counts it, but Chromium paints a **0x0** box (`scripts/verify6-bare-td.mjs`) | no -- invisible text, the existing approved rule |
| `CSS-maxheight0-overflow-clip` x2 | `max-height:0;overflow:clip`; innerText counts it, box height **0** | no -- invisible, the existing rule extended from `hidden` to `clip` |
| `CSS-opacity-0.0` x2 | `opacity:0.0`; computed opacity 0 | no -- the deliberate choice, judged below |
| **`NEST-420-divs`, `NEST-600-divs`, `NEST-600-b`** x2 | **depth guard** `html-visible.ts:135` `if (depth > 400) return;` drops ALL text below depth ~397 elements; Chromium shows the ask; main keeps it | **YES, regression vs main. Minor:** needs ~100 nested layout tables (`<table><tr><td>` x3000 -> "" in `verify6-serialize-probes.ts`) or ~400 nested divs. Quoted history (the deep part of a long chain) is dropped anyway, and new text sits at the top. |
| **`CSS-decl-inside-string`** x2 | `style="font-family:'Arial;display:none;x'"`: `styleDeclarations` (`html-visible.ts:45`) splits on `;` inside a quoted CSS string | **YES, regression vs main. Very low realism** (a quoted font name containing `;display:none;`) |

### Judgements asked for

- **Always-standards mode: SOUND.** Across all 299 recorded rows (implementer 81, loop 5 88, loop 6 130), only
  **3** differ between standards and quirks Chromium (`scripts/verify6-quirks-diff.ts`). In all 3 the standards text
  (what the branch uses) is the one that KEEPS the ask. In tree construction the only quirks difference that matters
  here is that `<table>` does not close an open `<p>`. Standards therefore can only move content OUT of a hidden `<p>`,
  never into one, so quirks-only markup always comes out keep-more. The webmail rationale is sound for the body
  content, which Outlook-web and Gmail embed in a standards page.
  One inconsistency, inference (no live client check): the same webmail rationale implies webmail ignores the
  email's own `<body hidden>` / `<body style="display:none">` (it rewrites `<html>`/`<body>`), but the branch, like
  standalone Chromium, then drops the WHOLE body. Main keeps it. Realism is very low (a deliberately hidden body).
  Listed, non-blocking.
- **`opacity:0%` hidden although innerText counts it: ACCEPT.** Computed opacity 0 is fully transparent; a reader sees
  nothing. It is the classic hidden-preheader / injection trick the owner approved removing. Residual: an Apple-Mail
  fade-in (`opacity:0` inline plus `@keyframes` in a `<style>` block) would become visible, which an inline-only
  converter cannot know. Very rare in business mail. `color:transparent` is still kept, which is inconsistent but
  keep-more.
- **F8b input wrapped in a real `<table>`: LEGITIMATE, a strengthening.** Chromium builds **0 `<td>` elements** for a
  stray `<td>` outside a table (`scripts/verify6-bare-td.mjs`: `tds:0`, body = the bare text and span). So the old
  input never exercised font-size:0 in a browser tree. The new input does, with the same expected value. The added
  row pins the bare case to what Chromium builds.
- **`READ_LAG_MS` I5 test flip** (`feed-staleness.test.ts`): the old expectation (`fresh` after 2 h) encoded the U1
  defect. The new one asserts `transient` at +2 h AND +9 days, and I23 adds the end-to-end incident. Legitimate.

### Serialization, reply cut, pathological input (`scripts/verify6-serialize-probes.ts`) -- CONFIRMED

- Escaping: `id='x"y<z>'` -> `id="x&quot;y&lt;z&gt;"`; text `&`, `<`, `>` re-escaped; a literal
  `&lt;div id="divRplyFwdMsg"&gt;` in TEXT stays text and does not trigger the cut. Entities decode once, like a
  browser.
- Outlook cut after re-serialization: `divRplyFwdMsg`, `appendonsend`, and uppercase unquoted `<DIV ID=divRplyFwdMsg>`
  all cut exactly as on main. Nested and unclosed `<blockquote>` are removed as on main.
- One divergence, keep-more: a `divRplyFwdMsg` header INSIDE a hidden element is dropped with its parent, so the cut
  does not happen and the old text after it is kept (main cuts). Contrived.
- Never throws, bounded time: 20 000 nested divs 0.78 s, 5 MB of text 1.0 s, 350 000 spans 0.54 s, 50 000
  mis-nested `<i><b>` 0.13 s, a 1 MB style attribute 0.07 s, NUL/lone surrogate, garbage, `""`, non-string input.
  None threw. The depth guard prevents stack overflow but drops the deep text (see the table above).

### Teams (challenge the radius): `teams-log.ts:103` DOES use `htmlToText` -- no decision change found

`teams-log.ts` is not on origin/main (branch-only, flag-gated). `scripts/verify6-teams-probes.ts`: 15 Teams shapes,
old hand scanner (0396f71a, `scripts/verify6-old/`) vs parse5. The shapes: mention `<at>`, reply-quote
`<blockquote itemtype=...Reply>`, attachment-only, self-closing `<attachment/>` then an ask, emoji-only,
`<systemEventMessage/>`, code, `&lt;` text, raw `<`, a link, `&rsquo;`, stray closes, `&nbsp;` tail.
**14/15 identical text and identical `asksSomething`.** The 1 difference is line breaks from implied `</p>`/`</li>`,
with the same ask decision. The media detector reads raw content, not `htmlToText`. The D3 spot probes are unchanged
(see the spot-check section).

### NEW flag-off live change found: implied end tags change the live screen's ask decision (not in loop 5)

`htmlToText` turns `</p>`, `</div>`, `</li>`, `</tr>`, `</hN>` into line breaks (`onedrive-feed.ts:440`). On main those
came only from the SOURCE. parse5 now supplies the implied ones (`html-visible.ts:156` always emits `</name>`), so a
body with unclosed `<p>`/`<li>`/`<tr>` gets new line boundaries, and main's own LINE-based rules in `newTextOnly` start
to apply there: the English `^On .+wrote:$` attribution and the From:/Sent: header pair.
`scripts/verify6-screen-probes.ts`, with `asksSomething({bodyText: htmlToText(html)})`, the live work-email ask
decision:

| body (synthetic) | branch | main |
|---|---|---|
| `<p>Status below.<p>On Friday the auditor wrote:<p>Can you send the ledger by Monday?` | **no ask** | ask |
| `<ul><li>On Monday the board wrote:<li>Can you approve the budget?</ul>` | **no ask** | ask |
| same in `<table><tr><td>...<tr><td>...` | **no ask** | ask |
| `<p>Hi<p>From: the team<p>Sent: Monday<p>Can you approve the budget?` | **no ask** | ask |
| `<p>Thanks<p>On Mon, Nov 10, 2025 at 9:14 AM Dana Kim &lt;...&gt; wrote:<p>Can you send the old ledger?` | **no ask** | ask |
| control: the first row with CLOSED `</p>` | no ask | **no ask** (main cuts too) |
| `<div>On Friday the auditor wrote:<div>Can you...</div></div>` / plain unclosed `<p>` ask | ask | ask |

The words are all still in `htmlToText`'s output; what changes is the cut. The branch makes malformed HTML behave like
well-formed HTML under main's existing rules. Two cases follow from that:
- The last two rows are real quoted history: cutting them is correct.
- The first three are main's own English-sentence false positive, extended to unclosed tags.

It is an English quoted-history change on the live screen that the owner did not approve. It is also the same
effect the owner declined for wrapped attributions on 2026-11-14 ("this doesn't need to impact it"). Realism is low:
Outlook, Gmail and Apple Mail close their `<p>`/`<div>`/`<li>`/`<tr>`. The fix is cheap: parse with
`sourceCodeLocationInfo: true` and emit `</name>` only when `sourceCodeLocation.endTag` exists, which reproduces
main's line structure exactly.
