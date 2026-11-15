# VERIFY-correspondence-proposals-10

WHAT:       Independent verifier loop 10 for `claude_task-proposals` @ `907dade7` vs `origin/main` (`ab6c87a0`).
WHY:        Loop 9 (`claude_verify-correspondence-proposals-9` @ `f669c0b5`) refuted 1d (line-474 quote-aware tag regex
            dropped visible asks), 1e (depth estimate bypassable -> 7-32 s parses) and claim 4 row 6 (build_checklist
            `proposals` parameter model-visible with flags off). Commit 907dade7 claims to fix all three. This loop
            re-derives them with new shapes, re-checks loop 5-9 probes at reduced depth, and re-sweeps the whole diff.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-9.md stays as the loop-9 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify10-*` on this branch; loop 5-9 probes copied unchanged from the loop-9 branch.

Verifier started 2026-11-15 18:21 UTC. Budget 90 min of active time. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): CONFIRMED
- Claim 1 (email text = main except the three approved changes): REFUTED (1d-new: a cut comment removes the `>` main's tag rule stopped at -> visible ask dropped; 1e: loop-9 shapes fixed, but per-token stack walks under the limit stay linear x ~2000: 810 KB -> 3.3 s)
- Claim 2 (bell, code): PENDING
- Claim 3 (preview-only code + public-log hygiene): PENDING
- Claim 4 (merge readiness, flags off): PENDING

## Claim 0: every suite at 907dade7 -- CONFIRMED

Ran EVERY `scripts/*.test.ts` (107 files) with `bun <file>`, PG 16 binaries on PATH (`/tmp/.../runall.sh`). **97 exit 0.**
The 10 non-zero files are the same 10 loop 9 explained; each re-checked against `origin/main` (`git archive ab6c87a0`):

| file | branch | origin/main |
|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | "outside the test runner" under `bun <file>`; under `bun test`: 26/0, 11/0, 30/0, 12/0 | n/a (`bun test` files) |
| fireflies-minutes, focus, memory-mode, model-policy, start-on-approval | rc 1 | rc 1, failure lines **identical** (diffed, timings stripped) |
| confirm-reask-db | rc 2, `REFUSING: LOCAL_PG_ADMIN_URL ...` | rc 2, same refusal (not re-run against a local PG this loop: reduced depth; loop 9 saw the same AC-27 failure on both) |

Named suites, observed: html-visible-loop5 32/0, checklist-tool 6/0, forwarded 22/0, onedrive-feed-truth 11/0,
inbound-email 72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0, correspondence-ingest 149/0,
proposals-preview 15/0, feed-staleness 98/0, meeting-triage 69/0, attention all passed (16). SQL: task-proposals-sql 45/0,
correspondence-ledger-sql 50/0, feed-staleness-sql 23/0, meeting-triage-sql 34/0, fireflies-queue-sql all passed.

`npx tsc --noEmit`: exit 0, 0 output lines. `npm run build`: exit 0; parse5 in `.output/server/_libs/parse5.mjs`, absent
from `.output/public`. No suite fails on the branch that passes on main.

## Claim 1: email text = main except hidden text / entities / non-English headers -- REFUTED

### 1a/1b. Loop 5-9 probes re-run at 907dade7 (reduced depth) -- hold
| probe | result |
|---|---|
| `verify8-chromium-rows` loop5 / loop6 / impl / loop8 | 88/130/81/71 rows, regression drops **0/0/0/0**; flips against Chromium 0/0/0/1 (`fontzero-attribution`, font-size:0 family) |
| `verify8-screen-probes` | 63 rows; the 2 dropping rows are `recon-i-fontzero`, `fontzero-attribution` (both font-size:0); 1 flip against Chromium = `fontzero-attribution` |
| `verify9-quote-probes` (loop-9's six `=`+quote drops) | 28 rows, drops **0**, flips 0 -- 1d fix holds |
| `verify8-quote-probes` / `verify7-screen-probes` / `verify6-screen-probes` | all same-ask / 39 rows differ 0 / 8 rows differ 0 |
| loop-9 1e shapes (`scripts/verify10-loop9-recheck.ts`) | `<div></i>`x40k 24 ms, `<div></x>`+closes 15 ms, `<blockquote></span>` 11 ms, 1990 distinct `<b>`+5000 `<p>` 138 ms, 1500/10000 125 ms, 20000 `<b></i>`+200 `<p>` 125 ms, 40k nested div 9 ms (main 1-5 ms); all = main's text. Loop-9 1e fix holds. |

`onedrive-feed.ts:466-471` confirmed: the quote-aware rule is gone; tags end at `<[^>]+>` exactly as on main.

### 1d-new. REFUTED: a cut COMMENT removes the `>` at which main's own tag rule stopped
visibleHtml splices each comment's whole source span (`<!-- ... -->`) out and puts `" "` in its place. Main never cut
comments, so when a raw visible `<` sits earlier in the text (`x < y`, `<3`, `<=`, `<4`, `<-`), main's `<[^>]+>` ran from that
`<` to the comment's `-->` and stopped. With the comment gone, the same rule runs on to the NEXT `>` in the email and
swallows the visible words in between. A hidden text node cannot do this (its hidden ancestor's start tag always supplies a
`>` first); comments are the one cut span that carries its own `>`.

Loop-10 shapes, built independently (`scripts/verify10-shapes.mjs`, 20 rows), Chromium-recorded
(`scripts/verify10-chromium-record.mjs` -> `scripts/verify10-chromium-truth.json`), compared by
`bun scripts/verify10-quote-probes.ts`: **rows dropping a word main AND Chromium show = 2, ask flips vs main = 1, against Chromium.**

| shape (synthetic) | branch | main | Chromium |
|---|---|---|---|
| `lt-in-td-then-comment`: `<td>x < y <!-- c --> Can you approve the budget?</td>` | `"x"` **asks=false** | `"x Can you approve the budget?"` asks=true | `"x < y Can you approve the budget?"` asks=true |
| `lt-then-comment-then-tag`: `<p>Q <4 <!-- c --> done</p><p>Can you approve the budget?</p>` | drops "done" | keeps "done" | keeps "done" |

Controls on the same 20 rows: where `</p>` is turned into a newline before the tag rule (no later `>`), the branch keeps
MORE than main (`lt3-then-comment`, `lt-space-then-mso-comment`, `lte-then-comment`, `lt-arrow-then-comment` = Chromium);
comment-with-`>` and `<!-- </blockquote> -->` rows match Chromium better than main; CRLF / lone CR / BOM / NUL / astral
offset rows cut exactly the hidden text, no visible word moved (parse5 offsets are raw string indices).

Reach: needs a RAW `<` in visible text (mainstream clients write `&lt;`) followed by a comment before the next tag --
hand-written or generated HTML. Same class loops 8 and 9 refuted (text the browser shows, dropped by the regex stage, flags off).

**Minimal fix (measured, applied temporarily and restored -- `scripts/verify10-comment-fix-proto.py`):** replace a cut
COMMENT span with `<!---->` instead of `" "` (main's rule consumes it whole, and its `>` stops an earlier match exactly where
main's `-->` did; text cuts keep `" "`). With it: `verify10-quote-probes` drops 0 / flips 0; `verify9-quote-probes` 0/0;
`verify8-chromium-rows` regression drops 0 on all four sets, the only flip against Chromium still `fontzero-attribution`;
`verify8-screen-probes` unchanged (2 font-size:0 rows); `verify7-screen-probes` 39/0; onedrive-feed-truth 11/0,
html-visible-loop5 32/0, inbound-email 72/0, redteam-correspondence 77/0, needs-you 77/0, correspondence-ingest 149/0,
onedrive-feed all passed. `git diff HEAD -- src/` empty after restore.

### 1e. PARTLY: loop-9's two mechanisms are bounded; per-token stack walks just under the limit are still ~2000x main
907dade7's adapter counts depth (appendChild/insertBefore) and created elements. It does NOT count work that creates no
element: every stray end tag / scope check walks the open-element stack, which may be 1990 deep. `bun scripts/verify10-scale.ts`
(raw output `VERIFY-correspondence-proposals-10-scale.txt`), 1990 open + N tokens, all parsed (no abort), ask kept:

| shape (synthetic) | len | branch htmlToText | main |
|---|---|---|---|
| `<svg>`x1990 + `</x>`x50k | 210 KB | 832 ms | 1 ms |
| `<svg>`x1990 + `</x>`x200k | 810 KB | **3349 ms** | 5 ms |
| `<span>`x1990 + `</x>`x200k | 812 KB | 1637 ms | 6 ms |
| `<div>`x1990 + `</li>` / `</h1>` / `<p></p>` / `<dt>` x200k | 0.8-1.4 MB | 1061-1535 ms | 5-14 ms |
| `<ul>`x1990 + `<li>`x200k | 808 KB | 1003 ms | 7 ms |
| `<template>`x100k (adapter restarts depth inside template content; ends in a caught RangeError at EOF) | 1.0 MB | 2159 ms | 5 ms |
| `<template><div>`x130k | 1.95 MB | 2104 ms | 41 ms |

Linear in length (about 4 ms per KB worst), not the super-linear 62 KB -> 7 s of loop 9; within the 2 MB feed default a
hostile body costs ~3-8 s on every read of the work-email screen, flags off. Hostile sender only.
`bun scripts/verify10-guard.ts` (raw `...-guard.txt`): 31 more shapes (foster parenting, adoption agency, select/optgroup,
math/svg, ruby, frameset, noscript, nested tables, `<a` padding in a comment to inflate the node budget): each either aborts
in <= 25 ms or parses in <= 224 ms per MB, every result = main's text or the browser's.

Real-looking emails do NOT trip the guard (`bun scripts/verify10-realistic.ts`, raw `...-realistic.txt`): Outlook/Word
3000 paragraphs + VML comments 970 KB (157 ms), 6000-row report with unclosed cells, 12-deep nested-table newsletter 534 KB,
Gmail thread 150 and 600 quotes deep, 5000 unclosed `<p><font>` -- all parsed, hidden preheader cut.

**Minimal fix (prototyped, `bun scripts/verify10-guard-proto.ts`, not wired in):** depth limit `min(2000, 5e7 / tokens)`
(tokens = `<` + optional `/` + letter count, so stack depth x tokens <= 5e7) and template content inheriting its
template's depth (`setTemplateContent` map). Every hostile shape above stops in **5-38 ms** (2 MB svg case 29 ms);
**0 trips** on the 398-row corpus + loop 8/9 shapes + 5 real-looking emails. (A work budget charged via `onParseError` does
not work: parse5 reports tokenizer errors only, so stray end tags are never charged -- measured in verify10-realistic (3).)

### Radius
`teams-log.ts:103` also calls this `htmlToText` (flag-gated ingest path, claim 4). `inbox-read.ts:254` has its own
`htmlToText`, unchanged vs main.
