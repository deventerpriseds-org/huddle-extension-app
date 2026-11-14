<!--
WHAT:          Independent verification (loop 5) of claude_task-proposals @ 03cabacc: re-derivation of every loop-4
               REFUTED / PARTIAL / MINOR item (D1 W1-W4/W7, D2 X1/X2, D3, D5, D6, STALE 4c/4d, 8.3), the 14
               implementer claims, the Chromium truth file, and the flags-OFF live-change table.
WHY:           Tier 1 (model output stored as proposals; live bell + live email screens touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-4.md (origin/claude_verify-correspondence-4)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-*.ts, scripts/verify4-*.ts (loops 3-4) and scripts/verify5-*.ts
-->

# VERIFY correspondence-proposals, loop 5

Started 2026-11-13 23:10 UTC, budget 3 h (ends 02:10 UTC). Isolated worktree at detached 03cabacc; compared against
origin/main 502e34e2 (live; 1 commit ahead of 03cabacc, ledger-only). No live system touched; synthetic `.example`
data only.

**Restart note (this run, 23:16 UTC):** the stub above came from a killed earlier start and is treated as unverified.
This run tests the verify branch checkout, whose `src/` is byte-identical to 03cabacc (`git diff 03cabacc HEAD -- src`
is empty; the only differences are this file and `scripts/verify3-*` / `scripts/verify4-*` probe scripts).
origin/main has since moved to 9a22b0cc (3 ledger-only commits ahead of 03cabacc: 502e34e2, 64170e84, 9a22b0cc).
Budget re-based: ends 02:16 UTC.

## Claim 0: full suite re-run at 03cabacc

| suite | implementer | observed (this run) |
|---|---|---|
| task-proposals | 203/0 | 203 passed, 0 failed |
| redteam-correspondence | 75/0 | 75 passed, 0 failed |
| correspondence-ingest | 149/0 | 149 passed, 0 failed |
| inbound-email | 72/0 | 72 passed, 0 failed |
| cross-app-turn-gate | 92/0 | 92 passed, 0 failed |
| feed-staleness | 73/0 | 73 passed, 0 failed |
| onedrive-feed-truth | 11/0 | 11 passed, 0 failed |
| proposals-preview | 5/0 | 5 passed, 0 failed |
| onedrive-feed, attention, attention-focus | -- | all passed |
| confirm-ask-context (main-side file) | -- | 21/21 passed |
| feed-staleness-sql (local PG 16) | 23/0 | 23 passed, 0 failed |
| task-proposals-sql | 45/0 | 45 passed, 0 failed |
| correspondence-ledger-sql | 50/0 | 50 passed, 0 failed |
| fireflies-queue-sql | -- | all passed |

Every implementer count reproduces exactly.

## Claim 0b: the two merges kept main's files intact

- Merge 0cb6d8a0 (parents 2cf5fa8d / main 8972f632, base e710fe27): 13 files touched only by main; all 10 non-ledger ones
  (`autowork.server.ts`, `PolishView.tsx`, `attention/focus.ts`, 2 tests, 2 skill check scripts, 2 workflows, 1 doc)
  are byte-identical to main (`git diff --stat 8972f632 0cb6d8a0 -- <files>` empty). One file touched by both sides,
  `HuddleView.tsx`: `git diff origin/main 03cabacc -- HuddleView.tsx` contains ONLY the branch's proposal-checklist
  code (2 imports, `propIds` reconcile, proposal row render); main's bell-jump `focusStep`/`FOCUS_WAIT_MS` code is
  present unchanged.
- Merge 03cabacc (parents 21928c16 / main aa29eef5, base 8972f632): main side touched only `.claude/actions.md`,
  `.claude/memory.md`, `graph-permission-check.yml`; the workflow is byte-identical to main.
- vs today's origin/main 9a22b0cc: every main-side code/workflow/skill file above is byte-identical. **CONFIRMED.**

---

## RESTART 2 (2026-11-14 00:02 UTC) -- re-targeted to b7dd9343

**The two claims above were run at 03cabacc, which is NOT the target.** The target b7dd9343 is 2 commits newer
(84b4a613 + b7dd9343, the urgent incomplete-file alert; `git merge-base --is-ancestor 03cabacc b7dd9343` true). This
run merged b7dd9343 into the verify branch (52964877); `git diff b7dd9343 HEAD -- src` is empty, so every probe below
runs against the target's source. Budget re-based: this run ends 03:02 UTC. Claim 0b (merge integrity) still holds:
b7dd9343 adds no merge; `git log 03cabacc..b7dd9343` is the 2 feature commits only.

## Claim 0 (re-run at b7dd9343)

| suite | implementer | observed at b7dd9343 |
|---|---|---|
| task-proposals | 203/0 | 203/0 |
| redteam-correspondence | 75/0 | 75/0 |
| correspondence-ingest | 149/0 | 149/0 |
| inbound-email | 72/0 | 72/0 |
| cross-app-turn-gate | 92/0 | 92/0 |
| feed-staleness | 95/0 | **95/0** (was 73 at 03cabacc: +22 new) |
| onedrive-feed-truth | 11/0 | 11/0 |
| proposals-preview | 5/0 | 5/0 |
| onedrive-feed / attention / attention-focus | -- | 61/0, 15/0, 27/0 |
| confirm-ask-context | -- | 21/0 |
| feed-staleness-sql (local PG 16) | 23/0 | **23/0 -- unchanged, so the 22 new incomplete-alert tests are in-memory only; none runs the real SQL** |
| task-proposals-sql / correspondence-ledger-sql / fireflies-queue-sql | 45, 50, -- | 45/0, 50/0, 14/0 |
| fireflies-minutes | -- | 64 pass / **3 FAIL (G3, G5, G8)** -- **pre-existing: origin/main bc6bd661 fails the same 3**; the branch's only fireflies diff is `export` on `fetchTranscript`. Not caused by this branch. |
| `tsc --noEmit` | -- | 0 errors at b7dd9343; 0 at origin/main |

---

## RESTART 3 (2026-11-14 01:35 UTC) -- re-targeted to 0396f71a

Budget re-based: this run ends 04:35 UTC. Verify branch = fb22507b + merge of 0396f71a (ec4d4c29).
`git diff b7dd9343 0396f71a --stat` = exactly 3 files: `scripts/fixtures/preview-fetch-stub.ts` (2 +-),
`scripts/proposals-preview.test.ts` (+1), `scripts/proposals-preview.ts` (+33 -3). **No `src/` change**, so every
Claim-0 suite result at b7dd9343 carries to 0396f71a except the preview suite. `git diff 0396f71a HEAD -- src
scripts/proposals-preview* scripts/fixtures` is empty.

## Claim 0c: suites changed by 0396f71a

| suite | implementer | observed at 0396f71a |
|---|---|---|
| proposals-preview | 6/0 | **6/0** (PV-1..PV-6) |
| `tsc --noEmit` | -- | **exit 0, no output** |

## Claim 11: the Chromium truth fixture is real -- CONFIRMED

`node scripts/html-visible-text-truth.mjs` re-run here against `/opt/pw-browsers/chromium-1243`: wrote 81 cases and
`git diff -- scripts/fixtures/html-visible-text-truth.json` is **empty** (byte-identical, incl. the recorded chromium
path). The fixture has one commit (ac0a5a8f) and is reproducible from the generator, so it was not hand-edited.
`bun scripts/onedrive-feed-truth.test.ts`: 11/0. 80/81 rows match exactly; the 81st is `LEAK-formatting-reopened`
(keeps more). CONFIRMED.

## Claims 1-3 (D1 W1-W3, W4, W7): fixed on the recorded shapes -- REFUTED on new shapes

W1, W2, W3, W4 (one copy survives), W7 match Chromium exactly (fixture rows, truth suite 11/0). To test beyond the
implementer's 81 rows, `scripts/verify5-html-cases.mjs` records 44 NEW shapes x {doctype, quirks} = 88 rows through the
same Chromium extraction, and `scripts/verify5-html-compare.ts` scores branch and origin/main `htmlToText` against it
(DROP = a word Chromium shows is missing). Branch: 47 OK / 16 KEEP+ / **25 DROP**; main: 22 OK / 64 KEEP+ / 2 DROP.
**23 rows are DROP on the branch and not on main** (flags OFF, live work-email screen):

| shape (synthetic) | Chromium | branch | main | realism |
|---|---|---|---|---|
| F1 `<p><b style="display:none">pre<table><tr><td>Can you sign the NDA?</td></tr></table>` | ask | **""** | kept | medium: W1-class unclosed hidden element; ask in a layout table |
| F2 same with `<font>`, `<strong>` (+ `<p>Thanks</p>` after: "Thanks" survives, ask dropped), `<a>`+`<center>` | ask | **""** | kept | as F1 |
| F3 `<ul><li><b style="display:none">pre<li><table><tr><td>ASK` and `<p><b ...>pre<p><table>...ASK` | ask (doctype AND quirks) | **""** | kept | as F1 |
| C1 `style="color:red; /* display:none */"` | ask | **""** | kept | low |
| C2 `style="display:none; display:block"` (later declaration wins) | ask | **""** | kept | low |
| C3 `style="display:nonex"` (invalid value) | ask | **""** | kept | very low |
| K1 `<!-->ASK<!-- x -->` / `<!--->ASK...` (abrupt empty comment) | ask | **""** | kept | low |
| K2 `<!-- x --!><p>ASK</p><!-- y -->` (`--!>` closes a comment) | ask | **""** | kept | very low |
| G1 `<div style="display:none"><img alt="a > <div>">pre</div><p>ASK</p>` (`>` inside a quoted value) | ask | **""** | kept (+junk) | very low |

Root causes:
- F1-F3: `onedrive-feed.ts:581` skips the ancestor-close rule for every FORMATTING element ("the browser re-opens
  it"), so `elementEnd` runs to the end of the document. The browser re-opens a formatting element only up to the
  last **marker** in the active-formatting list; a `<td>`/`<th>`/`<caption>` pushes a marker, so text in the next
  table cell is NOT re-wrapped in the hidden `<b>` and is visible. The code has no marker notion.
- C1-C3: `HIDDEN_STYLE` (`:408`) is a substring regex over the raw style text: it sees declarations inside CSS
  comments, ignores the cascade inside one attribute, and has no word boundary after `none`.
- K1/K2: `htmlToText` (`:700`) strips comments with `/<!--[\s\S]*?-->/`; the HTML tokenizer also ends a comment at
  `<!-->`, `<!--->` and `--!>`. Main never stripped comments, so this is new on the branch.
- G1: every tag regex (`:456`, `:573`, `:643`) ends a tag at the first `>`, including one inside a quoted value
  (`attrsOf` itself is correct; the tag it is handed is already truncated). Main shares the regex but never stripped.

Also observed, keep-more only (acceptable direction): self-closing `<span style="display:none"/>` (browser keeps the
span open), `<noscript>`, `<template>`, `visibility:collapse`, an unclosed trailing `<!--`, `<textarea>` content, the
known re-opened `<b>` (`FMT-b-div-div`), and `>` in a hidden tag's own attribute (junk kept).

**Verdict for claims 1-3: the five recorded shapes are fixed; the D1 class ("flag-off live screen drops visible
text") is NOT closed.** F1-F3 is the same class loop 4 blocked on (an unclosed hidden inline element whose parent
closes implicitly), reached with a formatting tag and an ask in a table cell -- the commonest place for an ask in
an HTML email. Blocking under this loop's rule ("any OTHER flag-off live change, especially dropped visible text, is
still a defect"). C/K/G are rarer; listed for the fix pass.

## Claims 4 + 12 (D2 X1/X2, `newTextOnly` vs main) -- X1/X2 FIXED; sweep REPRODUCED; guard weaker than claimed

`scripts/verify5-newtext-probes.ts` (branch vs origin/main `newTextOnly`), `scripts/verify5-literal-sweep.ts`.

- X1, X2 verbatim: branch output == main output (ask kept). **FIXED.**
- Sweep (TypeScript AST over the inbound-email, redteam, ingest and task-proposals suites): **1486 literals, 19 differ**
  (implementer counted 1436; my walker also joins template expressions). The 19 are exactly the implementer's list:
  7 one-line foreign attributions, 6 foreign header blocks, 6 two-line wrapped attributions; every one keeps only the
  greeting line before quoted history. **REPRODUCED.**
- NEW spellings, cut direction (branch cuts, main keeps the whole body):

| id | body (synthetic) | branch keeps | why it passes `isWrappedAttribution` |
|---|---|---|---|
| X3 | `Quick note.` / `On the 12 open items from 2024 we may still owe Finance, and Dana` / `wrote:` / `Can you send the ledger by Monday?` | "Quick note." | `may` is in DATE_NAME |
| X4 | `On the 3 invoices from 2025 it turns out Pat` / `Kim wrote:` / `Can you approve the PO by Friday?` | "" | `out` (Portuguese Oct) |
| X5 | `On Friday 14 at 10:30 the vendor called and Legal` / `wrote:` / `Can you sign the NDA today?` | "" | weekday + day + time |
| X6 | `On the 2 dates set for 2026 Ops` / `wrote:` / `Can you confirm the venue?` | "" | `set` (Portuguese Sep) |
| N-da | `Da: the team` / `Data: attached below` / `Can you review it today?` | "" | it header pair `Da:` + `Data:` |

  `DATE_NAME` (`inbound-email.ts:118`) includes 3-letter foreign abbreviations that are common English words
  (`may`, `out`, `set`, `sun`, `sat`, `mar`, `dom`, `ago`), so the "weekday or month name" test is satisfied by
  ordinary English. Every X3-X6 joined line is a sentence main's OWN single-line rule (`^\s*On .+wrote:\s*$`) already
  cuts when it is not wrapped, so this extends a false-positive main already has rather than creating a new class.
- Keep direction: real Gmail wraps (`On Mon, Nov 10, 2025 at 9:14 AM Dana Kim <dana@...>` / `wrote:`; name-only
  variant), a real French header block and a real German one-line attribution are all cut. CONFIRMED.

**Verdict: claim 4 PARTIAL (X1/X2 fixed; the shape guard is satisfied by English words). Claim 12 CONFIRMED on its
corpus; new spellings X3-X6/N-da cut English text main keeps.** Not blocking on its own: it is main's existing
single-line false positive reaching a hard-wrapped line, and the cut content is always text after "<X> wrote:". The
two-line English wrap cut is itself NOT one of the three owner-approved changes (only non-English quoted history
is); it should be listed to the owner as a fourth live change. Fix candidate: English-only names in DATE_NAME for
the English opener.
