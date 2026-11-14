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

## Claim 16 (U1/U4: one announcement per incident) -- FIXED as asked; NEW defect U5 introduced by the fix

### U1-U4 re-run on the REAL bell SQL (`scripts/verify5-staleness-sql.ts`, local PostgreSQL 16) -- CONFIRMED

| step | loop 5 (0396f71a) | ddc7b55d |
|---|---|---|
| U1d Fri 00:10, last read 2h10m ago, newer copy unread | `fresh`, row **auto-cleared** | **`transient`, row stays owed/incomplete** |
| U1e Fri 07:10, reader reads the copy, still incomplete | reopened, **announcement #2** | `incomplete`, raised=0, urgent=0 |
| U1 announcements for one incident | 2 | **1** |
| U4b dismissed incomplete row, republished incomplete, unread 2h+, older than 6 working h | `stale`, dismissed row **reopened** | **`transient`, stays dismissed** |
| U4 announcements | 2 | **1** |

U2 (dismissed stays silent, 0 announcements), U3 (open stale -> incomplete announces once), V1/V2 (a transient read or
one 403 raises nothing; two consecutive 403s do), and V3 (feed row first; with no feed rows the order equals main's)
are all identical to loop 5. **U1/U4 CONFIRMED fixed.** The implementer's I23 test covers the same path in the twin;
the mutation proof is below.

### NEW: U5 -- an incomplete sent.json whose reader never reads again stays `transient` FOREVER

`decideFeedStaleness` (`feed-staleness.ts:167-169`) now returns `transient` for as long as the last read was
`rejected:incomplete` and a newer copy exists, "however long the reader takes". The email reader runs on the hourly
inbound watch, but the SENT reader runs only in `loadFeedSent` (`email-replies.server.ts:292`). That is called by
`reconcileRepliedFromSentItems` only while an owed `kind='email'` row with a feed id exists
(`listOwedEmailReplies`, `:210`). So when the owner has no owed work email, sent.json is never read again.
`scripts/verify6-staleness-stuck.ts`, real SQL:

| step (sent.json; no owed work email) | decision | bell row | announced |
|---|---|---|---|
| U5a Mon 10:10 ET, reader read the 9:50 copy -> incomplete | incomplete | owed/incomplete | #1 |
| U5b Mon 11:10, flow FIXED (complete copy 10:55), never read | transient | **owed/incomplete (stuck: the file is complete)** | -- |
| U5c Tue 12:10, same | transient | owed/incomplete | -- |
| owner dismisses | | dismissed | |
| U5d Fri 12:10, flow STOPPED since Mon 10:55 (4 working days) | **transient** | dismissed | **none** |
| U5d+ the next Wednesday (9 days stopped) | **transient** | dismissed | **none** |
| control: same, but the reader DID read the fixed copy (`ok`) | fresh -> Fri **stale** | replied -> **owed/stale** | stale raised |

The consequences:
- **(i)** An urgent incomplete alert never clears after the flow is fixed.
- **(ii)** Once the owner dismisses it, a real later outage of the sent flow is NEVER alerted. That is the staleness
  alert's one job. Before the fix this resolved after 2 h.

Not live at merge (`correspondence.staleAlerts` gates all of it). It **blocks switching staleAlerts on**, in place of
U1. Minimal fix direction: when the last read is `rejected:incomplete` and the drive shows a newer copy, the staleness
check should READ that copy (one `readFeed(cfg, kind)`, the reader that already exists), not wait for a reader that
may never run. Do not fall back on time: falling back to `stale` reintroduces U4, and to `fresh` reintroduces U1.

## X3-X6 and the detector, new spellings both ways -- CONFIRMED (live screen); detector residues listed

- `scripts/verify5-newtext-probes.ts` at ddc7b55d: X1, X2, X3-may, X4-out, X5-time, X6-set, G1 and G2 (Gmail
  wrapped) all give **the same output as main**.
- DIFF rows are all approved non-English history:
  - T-fr (a French header block) and T-de-attr (a German attribution) are cut, as approved.
  - Three are foreign header PAIRS colliding with English, the same residue class as loop 5's N-da:
    - N-van `Van: 12-seat, booked` / `Datum: tbd`
    - N-da `Da: the team` / `Data: attached below`
    - N-de `De: rien` / `Date: Friday`

    (`inbound-email.ts:79-86`; the English-plausible ones are `De:`/`DE:` + `Date:` and `Da:`/`Od:` + `Data:`.)
    Part of the approved "non-English quoted history" change; non-blocking.
- Detector (`isWrappedAttribution`, no live caller): Gmail (4 spellings), Apple Mail (3) and Outlook-mobile (2)
  stamps are detected, and X3-X6, lowercase-name, `I` and no-date sentences are not. The residues are in claim (a):
  3 English sentences that carry month or day name + year + clock + a capitalised word are detected, and Thunderbird
  numeric is missed.

## Bundle / build -- CONFIRMED

- parse5 is reachable from a static import chain that includes a server-fn file: `huddle.functions.ts:8` ->
  `proposals.ts` -> `source-item.ts:15` -> `onedrive-feed.ts:18` -> `html-visible.ts:29` -> parse5. No `.tsx`
  imports any of these.
- `npm run build` (vite build + nitro): **exit 0**. The parse5 signature string (`abandoned-head-element-child`) is
  in **0 files under `.output/public`** (the client) and in 1 server file (`.output/server/_libs/parse5.mjs`).
  Server-only.
- `package-lock.json` adds parse5 7.3.0 + entities 6.0.1. `npm ci --dry-run` on the target's package.json + lock
  succeeds (699 packages). `bun.lock` has no parse5 entry, but it was already stale (last touched a3b20df4), and
  `deploy-swa.yml` runs `bun install` without `--frozen-lockfile`, then npm fallback. Not a new risk.
- origin/main moved to 97c4bed2 during this loop: its 8 commits since the merge base aa29eef5 touch only
  `.claude/*.md` and `proposals-preview.yml`, none touched by the branch. A merge stays clean.

## Mutation proofs (`mutate.sh`, anchors/replacements in files) -- 13 run, 12 FIRED, 1 INERT-equivalent

| mutation | file | named test | verdict | exit |
|---|---|---|---|---|
| U1 fix reverted (2 h fallback back) | feed-staleness.ts | I23 U1/U4 | FIRED (control EQUIVALENT) | 0 |
| 2-check bypassed | feed-staleness.ts | T3 a 403 | FIRED (control EQUIVALENT) | 0 |
| M2: drop `ok &&` | feed-staleness.ts | I12 later checks | FIRED (control EQUIVALENT) | 0 |
| D6: title-negator check always ok | proposals.ts | D6 loop 4: a title that negates | FIRED (control EQUIVALENT) | 0 |
| PV-6: HTML PUT only with PREVIEW_EMAIL=1 | scripts/proposals-preview.ts | PV-6 | FIRED (control EQUIVALENT) | 0 |
| hidden attribute rule off | html-visible.ts | D1 neg: bare / empty-valued hidden attribute | FIRED (control EQUIVALENT) | 0 |
| first declaration wins (no cascade) | html-visible.ts | CSS a later display wins | FIRED (control EQUIVALENT) | 0 |
| parse WITHOUT the doctype (quirks) | html-visible.ts | LOOP5 no row drops a word | FIRED (control EQUIVALENT) | 0 |
| NEVER_TEXT reduced to comment/doctype | html-visible.ts | LOOP5 at least 83 rows match Chromium exactly | FIRED (control EQUIVALENT) | 0 |
| (same) | | TRUTH negatives / TRUTH every row | INERT -- no truth row has `<title>`/`<noscript>`/`<template>`; caught by the loop-5 fixture instead | 1 |
| CSS comment stripping off | html-visible.ts | CSS display:none inside a CSS comment | **INERT, behaviourally equivalent** for that input. Without stripping the property name is garbled (`/* display`), so nothing can hide. Untested direction: `style="/* c */ display:none"` is hidden today (probe: `"shown"`) and would leak under the mutation (keep-more). Test gap, non-blocking. | 1 |
| join reinstated / year+clock off / email shortcut off (claim b) | inbound-email.ts | see claim (b) | FIRED (control EQUIVALENT) x3 | 0 |

`git status --short` was empty after every run.

## Reduced-depth re-checks of loop-5 CONFIRMED items

| item | evidence this loop | result |
|---|---|---|
| full suites | Claim 0 at d849f0da and ddc7b55d: every count equals the claim (redteam 77 at ddc7b55d) | CONFIRMED |
| truth fixture regenerates identically | `scripts/fixtures/html-visible-text-truth.json` unchanged since loop 5 (no commit touches it in 0396f71a..ddc7b55d); truth suite 11/0 | CONFIRMED (carried; not regenerated this loop) |
| V1/V2 (transient / single 403 raise nothing) | real SQL re-run | CONFIRMED |
| V3 (feed row first; flags off == main order) | real SQL re-run | CONFIRMED |
| `feedStateKey` pure; complete:false refused | no diff in 0396f71a..ddc7b55d touches either (`git diff` limited to feed-staleness.ts, inbound-email.ts, html-visible.ts, onedrive-feed.ts htmlToText) | CONFIRMED (carried) |
| D3 / D5 / D6 | `scripts/verify5-d356-probes.ts`: identical to loop 5 (D5 `No‑one` residue unchanged) | CONFIRMED |
| Teams dedup (chatId, message.id), unknown keys ignored | same probe: 2 messages, last copy wins | CONFIRMED |
| flag off = zero calls | no change to `runFeedStalenessCheck` / ingest gating since loop 5 | CONFIRMED (carried) |
| preview: HTML file, email unchanged, counts-only logs | PV suite 6/0 + PV-6 mutation FIRED | CONFIRMED |
| 7 mutation proofs | 6 re-run, all FIRED. W1-W3's code was deleted (replaced by parse5) and is replaced by 4 new html-visible mutations | CONFIRMED |
| Golden-path regression baseline (live app) | not run: this loop forbids live systems; no UI file changed since loop 5 | NOT RUN (out of scope) |

## The flags-OFF live-change table, rebuilt at ddc7b55d (vs origin/main)

`src/` files changed since loop 5's target 0396f71a: `feed-staleness.ts` (flag-gated), `inbound-email.ts` (live),
`html-visible.ts` (new, live) and `onedrive-feed.ts` (`htmlToText`, live). Every other loop-5 row carries unchanged.

| # | change on merge with every flag OFF | status |
|---|---|---|
| 1a | work-email `htmlToText`: hidden text removed. Rules: `display:none`, `hidden`, opacity 0, max-height 0 + overflow hidden/clip, font-size 0, visibility; comments, `<head>`, `<script>`, `<style>`, `<template>`, `<noscript>`, `<title>` | **owner-approved** ("hidden text ignored") |
| 1b | entities decoded, once and correctly (`&eacute;`, `&#8217;`, `&hellip;`; `&amp;lt;` shows `&lt;` where main shows `<`); typographic quotes folded to `'` and `"` | **owner-approved** ("entities decoded") |
| 1c | **visible text dropped that main keeps**, in 3 low-realism shapes: (i) text deeper than ~397 elements (`html-visible.ts:135`); (ii) `;` inside a quoted CSS string (`html-visible.ts:45`); (iii) `<body hidden>` / `<body style="display:none">` drops the whole body (Chromium-consistent; webmail would likely show it -- inference) | **DEFECT** (i), (ii); (iii) judgement |
| 1d | **NEW: implied end tags become line breaks** (`html-visible.ts:156` + `onedrive-feed.ts:440`), so main's English `On ... wrote:` and From:/Sent: cuts now also apply to bodies with unclosed `<p>`/`<li>`/`<tr>`, and the live ask decision flips from ask to no-ask (5 of 8 probes) | **NOT approved**; the same kind of English quoted-history change the owner declined on 2026-11-14 |
| 1e | more line breaks generally; text order follows the browser for foster-parented table text | harmless (no other decision change in 23 Teams/screen probes) |
| 2a | `newTextOnly`: non-English quoted history cut (residue: `De:`+`Date:`, `Da:`+`Data:`, `Van:`+`Datum:` header pairs cut English) | **owner-approved** |
| 2b | ~~English two-line Gmail attribution cut~~ | **GONE** at ddc7b55d (claim (a): 22/22 shapes and 1502 literals equal main) |
| 3-11 | loop-5 rows 3-11 (bell "Teams chats" checkbox, link/badgeCount, settle excludes chat/feed, nullable DDL incl. `feed_pending`, drive metadata select, heartbeat imports, `build_checklist` proposals `not_enabled`, sent settle opt-in, `listOpenAttention` order) | unchanged since loop 5 (no file touched) |
| 12 | new dependency parse5 7.3.0 (+ entities 6.0.1), server bundle only | no client effect |

## Per-claim table (target ddc7b55d)

Basis: S = suite re-run; P = my probe; M = mutate.sh; R = code read; Q = real SQL on local PG; C = real Chromium; B = build.

| item | verdict | basis |
|---|---|---|
| Claim 0: all suites + tsc | CONFIRMED: every claimed count reproduces (redteam 77/0 at ddc7b55d); fireflies-minutes 3 failures pre-existing on main | S |
| (a) `newTextOnly` == main on every wrapped shape | CONFIRMED (22/22; sweep 1502 literals, only the 13 approved non-English differ) | P |
| (b) rewritten tests not weakened | CONFIRMED (3 mutations FIRED); redteam suite exits 0 on failure (infra nit) | M + R |
| 6.4 F1-F3 / C / K / G (loop-5 23 regressions) | **FIXED** (loop-5 88 rows: 83 OK, 0 regressions except deliberate opacity) | C |
| 6.4 new shapes (130 rows: nesting, template/noscript/svg/math/select/details/dialog, foster, `<html>`/`<body>`) | **102 OK / 10 KEEP+ / 18 DROP**. Of the DROP rows, 6 are real regressions vs main: depth guard (3 shapes) and CSS string (1 shape) x2 modes; the rest are innerText-oracle artefacts (font-size:0, opacity 0, max-height clip) or math italics | C |
| 6.4 standards-mode choice | SOUND (3/299 rows differ; standards always the keep-more side) | C + R |
| `opacity:0%` hidden | ACCEPT (computed opacity 0) | C |
| F8b test input change | LEGITIMATE, strengthening (Chromium builds 0 `<td>`) | C |
| `visibleHtml` serialization, reply cut, blockquote | CONFIRMED | P |
| pathological input, never throws | CONFIRMED (bounded time); depth guard drops deep text | P |
| bundle / build | CONFIRMED server-only; build exit 0; lock in sync | B |
| Teams via `htmlToText` (radius challenge) | no open/answered change (14/15 identical, 1 newline-only) | P |
| **6.4 flags OFF: no unapproved live change** | **REFUTED**: row 1d (implied end tags -> English cut on the live ask decision) and row 1c (i)/(ii) | P + C |
| Claim 16 U1/U4 | **FIXED** (1 announcement, never cleared mid-incident, dismiss holds) | Q + M |
| **U5 (new, from the fix)** | **DEFECT**: incomplete sent.json + no owed work email -> `transient` forever; stuck alert, and after a dismiss a real outage is never alerted | Q |
| X3-X6 (detector) | CONFIRMED; 3 English residues still detected, but the detector has no live caller | P + M |
| Claims 5, 6, 7, 8, 9, 10, 11, 14, 15, 17, 18, 20 (loop 5) | CONFIRMED (carried + reduced re-check) | S + P + Q |
| Claim 13 / 19 mutation proofs | CONFIRMED (6 re-run + 7 new, all FIRED except 1 equivalent) | M |
| comment at `inbound-email.ts:150` ("kept for the correspondence report") | inaccurate: `isWrappedAttribution` has no `src/` caller | R |

UI note: none of this loop's claims is browser-only, and no UI file changed since loop 5 (`AttentionBell.tsx`,
`HuddleView.tsx`, `ProposalChecklistItem.tsx` untouched in 0396f71a..ddc7b55d). The bell/checklist UI rows from
loop 4 have still not been driven in a browser in any loop, so whenever this lands it lands **MERGE-PENDING-UAT**
for those rows.

## Verdict: FIX FIRST

PASS (CONFIRMED) 24 claim rows | FAIL (REFUTED/DEFECT) 3 (6.4 flags-off row 1d, 6.4 row 1c depth/CSS-string,
U5) | UNVERIFIED 1 (claim 17 self-send tier, needs the live profile row; carried) | UI-UNVERIFIED: bell/checklist UI
(carried, not in scope this loop).

Loop 5's blockers are fixed: F1-F3 and the whole tree-shape class, and U1/U4. What blocks now is smaller and cheap.

### Blocking for merge (live with every flag OFF)

1. **Implied end tags change the live ask decision**: `src/features/huddle/lib/external-feeds/html-visible.ts:156`
   always emits `</name>`, and `onedrive-feed.ts:440` turns `</p|div|li|tr|hN>` into line breaks. As a result
   `newTextOnly`'s English attribution and From:/Sent: rules (`inbound-email.ts:151-152`) now cut bodies that main
   keeps whole.
   ```
   asksSomething({subject:"Status", bodyText: htmlToText('<p>Status below.<p>On Friday the auditor wrote:<p>Can you send the ledger by Monday?')})
   // branch false ; main true   (scripts/verify6-screen-probes.ts, 5 of 8 shapes)
   ```
   This is an English quoted-history change the owner has not approved, of the same kind he declined on 2026-11-14.
   Fix: parse with `sourceCodeLocationInfo: true` and emit `</name>` only when `node.sourceCodeLocation?.endTag`
   exists, which reproduces main's line structure.
2. **Depth guard drops visible text main keeps**: `html-visible.ts:135` `if (depth > 400) return;`.
   ```
   htmlToText("<div>".repeat(405) + "Can you sign?")              // branch "" ; main "Can you sign?" ; Chromium shows it
   htmlToText("<table><tr><td>".repeat(3000) + "Can you sign?")  // branch ""
   ```
   Low realism, but it is a dropped-visible-text defect by this loop's rule. Fix: past the limit, append the
   subtree's text iteratively (escaped) instead of returning.

Fold into the same pass (non-blocking, very low realism): `html-visible.ts:45` splits a style on `;` inside a
quoted CSS string (`style="font-family:'Arial;display:none;x'"` drops the text; main keeps it).

If the owner prefers to accept items 1-2 as known deviations instead, everything else here is MERGE-READY. That is
the owner's call, not the verifier's.

### Blocking before `correspondence.staleAlerts` is switched on (not live at merge)

3. **U5** -- `src/features/huddle/lib/correspondence/feed-staleness.ts:167-168`: an unread newer copy after an
   incomplete read is `transient` forever. The sent reader runs only while an owed `kind='email'` work row exists
   (`email-replies.server.ts:210`, `:293`). Repro: `scripts/verify6-staleness-stuck.ts`. The alert stays after the
   flow is fixed; after a dismiss, a 4-day and a 9-day sent outage raise nothing (control raises `stale`). Fix:
   have the staleness check read the newer copy (existing `readFeed`) rather than wait.

### Tell the owner / nits (non-blocking)

4. Row 1c (iii): `<body hidden>` drops the whole message (Chromium-consistent; webmail likely shows it -- inference).
5. Foreign header-pair collisions with English (`De:`+`Date:`, `Da:`+`Data:`, `Van:`+`Datum:`), inside the approved
   class.
6. `scripts/redteam-correspondence.test.ts:505` never exits non-zero on a failure; add `if (fail) process.exit(1)`.
7. `inbound-email.ts:150` comment claims a caller of `isWrappedAttribution` that does not exist (dead code).
8. Test gap: CSS-comment stripping is only tested in the keep direction; `style="/* c */ display:none"` is
   untested.
9. Carried: D5 `No‑one` residue; preview footer wording.
