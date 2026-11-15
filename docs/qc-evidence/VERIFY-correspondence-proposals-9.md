# VERIFY-correspondence-proposals-9

WHAT:       Independent verifier loop 9 for `claude_task-proposals` @ `1c0171d7` vs `origin/main` (`ab6c87a0`).
WHY:        Loop 8 (`claude_verify-correspondence-proposals-8` @ `4857ac27`) refuted claim 1d (quote-aware tag regex
            dropped visible text after an apostrophe in an unquoted attribute) and observed 1e (parse5 quadratic on
            deep block nesting). Commit 1c0171d7 claims to fix both. This loop re-derives them, re-checks loop 8's
            confirmed probes, and covers claims 2-4 that loop 8 did not reach.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-8.md stays as the loop-8 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify9-*` on this branch; loop 5-8 probes copied unchanged from the loop-8 branch.

Verifier started 2026-11-15 17:36 UTC. Budget 2 h of active time. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): CONFIRMED
- Claim 1 (1d + 1e fixes, loop-8 re-check): REFUTED (1d: `=`+quote shapes drop a visible ask; 1e: guard bypassable, 62 KB -> 7 s)
- Claim 2 (bell "Teams chats" removed): PENDING
- Claim 3 (forwarded.ts + preview scripts): PENDING
- Claim 4 (merge readiness, flags off): PENDING

## Claim 0: every suite at 1c0171d7 -- CONFIRMED

Ran EVERY `scripts/*.test.ts` (106 files) with `bun <file>` (PG 16 binaries on PATH for the self-hosting SQL suites).
96 exit 0. The 10 non-zero files, each re-checked:

| file | on branch | why | on origin/main (ab6c87a0, `git archive`) |
|---|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | "Cannot use beforeEach()/describe outside of the test runner" | they are `bun test` files | `bun test`: 26/0, 11/0, 30/0, 12/0 on branch |
| focus | 24/1 (F22 voice call to Iris) | pre-existing | identical 24/1 |
| memory-mode | 2/4 | pre-existing | identical 2/4 |
| model-policy | diff 3 sol-ceiling FAIL | pre-existing | identical |
| start-on-approval | 49/50 (coursework) | pre-existing | identical 49/50 |
| fireflies-minutes | 3 FAILED (G3/G5/G8) | pre-existing (as loop 8 found) | identical 3 FAILED |
| confirm-reask-db | refuses without `LOCAL_PG_ADMIN_URL`; with a local PG 16 URL: 1 failure AC-27 | pre-existing | identical AC-27 failure |

The correspondence/html suites the implementer listed, observed here: html-visible-loop5 29/0, onedrive-feed-truth 11/0,
inbound-email 72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0, correspondence-ingest 149/0,
proposals-preview 15/0, feed-staleness 98/0, forwarded 17/0, meeting-triage 69/0, attention + attention-focus all
passed. SQL: task-proposals-sql 45/0, correspondence-ledger-sql 50/0, feed-staleness-sql 23/0, meeting-triage-sql 34/0,
meeting-triage-server 7/0, fireflies-queue-sql all passed. Others of note: cross-app-turn-gate 92/0, onedrive-feed all
passed, inbox-read 68/0, email-self-send 73/0.

`npx tsc --noEmit`: exit 0, 0 lines. `npm run build`: exit 0.
No suite fails on the branch that passes on main.

## Claim 1: loop-8 1d + 1e fixes -- REFUTED (both fixes are incomplete; narrower, but the same two defects remain)

### 1a/1b. Loop-8 confirmed probes re-run at 1c0171d7 -- still hold

| probe | result |
|---|---|
| `verify8-chromium-rows` loop-5 / loop-6 / implementer truth | 88 / 130 / 81 rows, regression drops **0 / 0 / 0**, every ask flip vs main goes Chromium's way (flips-where-branch!=chromium 0 / 0 / 0) |
| `verify8-chromium-rows` loop-8 set | 71 rows, regression drops 0, 1 flip against Chromium = `fontzero-attribution` (font-size:0, the deliberate invisible family) |
| `verify8-screen-probes` | 63 rows, 11 ask flips, 1 against Chromium (`fontzero-attribution`); the 2 rows dropping words main + Chromium show are `recon-i-fontzero` and `fontzero-attribution` -- both font-size:0. `apostrophe-unquoted-attr` no longer drops (fixed). |
| `verify8-quote-probes` | 8/8 same-ask, incl. `q-mailto-apostrophe-unquoted`, `q-attr-name-apostrophe` |
| `verify7-screen-probes` / `verify6-screen-probes` | rows=39 differ=0 flips=0 / rows=8 differ=0 |

### 1d. REFUTED: `=` followed by a quote still opens a run where the browser does not

The new rule (`onedrive-feed.ts:474`, `/<[a-zA-Z\/!?](?:[^>"'=]|=\s*"[^"]*"|=\s*'[^']*'|=)*>/`) opens a quoted run after ANY `=`.
The HTML tokenizer opens a quoted value only in the "before attribute value" state -- right after an attribute NAME and
its `=`. An `=` that starts an attribute name, follows a closed quoted value, is a second `=`, or sits in the tag name
is an ordinary character there, and the tag ends at the first `>`.

Loop-9 shapes, built independently (`scripts/verify9-shapes.mjs`, 28 rows; Chromium-recorded by
`scripts/verify9-chromium-record.mjs` -> `scripts/verify9-chromium-truth.json`; compared by
`bun scripts/verify9-quote-probes.ts`): **rows dropping a word main AND Chromium show = 6, ask flips vs main = 2, both
against Chromium.**

| shape (synthetic) | branch | main | Chromium |
|---|---|---|---|
| `after-quoted-value-eq-ask`: `<p><b class="hi"='x>Can you approve the budget? it's due</b></p>` | `""` **asks=false** | full ask, asks=true | full ask, asks=true |
| `double-eq-ask`: `<div><span title=='x>Can you approve the budget? it's urgent</span></div>` | `""` **asks=false** | full ask | full ask |
| `double-eq-sq`: `<span title=='x>Dana's note:</span> Can you ...` | drops "Dana's note:" | keeps | keeps |
| `attr-name-starts-eq`: `<b class="hi" ='x>Lee's list</b> ...` | drops "Lee's list" | keeps | keeps |
| `after-quoted-value-eq`: `<b class="hi"='x>Lee's list</b> ...` | drops "Lee's list" | keeps | keeps |
| `tag-name-eq`: `<b='x>Lee's list</b> ...` | drops "Lee's list" | keeps | keeps |

Controls the fix gets right (all three agree, or branch = Chromium): apostrophe/quote inside an unquoted value or name,
backtick values, unquoted `style=font-family:'Segoe UI'`, `onclick=alert('x')`, `&quot;` in a value, `<br/'>`, Outlook
`MsoNormal` + `style='...\"Calibri\"...'`, Gmail `dir="ltr"`, `mailto:o'neil` inside a dq value, unquoted URL query
`?a=1&b=2`, `= 'a > b'` / `=\n"a > b"` / `=\t'a > b'` (branch = Chromium, main shows a `b'>` residue). Two `=`+quote
shapes inside an unquoted value (`href=...?id='q4>`) happened NOT to drop only because `</p>` had already been
rewritten to a newline, so the run found no closing `>`.

Reach: needs an `=` immediately (or after whitespace) before a quote where no attribute name precedes it -- malformed
markup no mainstream client writes. But it is the same defect class loop 8 refuted (a regex guessing the tokenizer
drops a whole visible ask main and Chromium show, on the live screen with every flag off), so per the owner's rule it
is a REFUTE.

**Minimal fix (measured): delete line 474** -- tag handling is then byte-for-byte main's `<[^>]+>`. I applied it
temporarily (restored after; not committed) and re-ran: `verify9-quote-probes` drops 0 / flips 0; `verify8-chromium-rows`
regression drops 0 on all four sets, flips against Chromium only `fontzero-attribution`; `verify7-screen-probes` 39/0;
onedrive-feed-truth 11/0, inbound-email 72/0, redteam-correspondence 77/0, needs-you 77/0, correspondence-ingest 149/0.
Cost: `html-visible-loop5` fails 4 assertions that pin the GT-in-alt improvement (`LOOP5 no row drops a word` reports
`GT-in-alt-phantom-hidden` "missing Can" -- the text becomes `">Can you sign...`, main's own residue glued to the word,
not a drop; `exact 83/88`; the two `LOOP8 control` GT-in-alt rows). Those assertions pin a behaviour main does not have
and the owner did not list as approved; they would be updated to main's residue. Every alternative regex re-derives the
tokenizer one shape at a time, which is how loops 5, 8 and 9 each found a new drop.

### 1e. REFUTED: the depth guard is an estimate the input controls; two shapes still reach the slow parse

`bun scripts/verify9-depth.ts` (branch htmlToText vs main):

| input (synthetic) | len | estimatedDepth | parser | branch ms | main ms |
|---|---|---|---|---|---|
| div / table-tr-td / blockquote / ul-li / b, x1999 closed or unclosed | 6-50 KB | 1998-1999 | runs | 6-22 | 0-2 |
| same x2001 | 6-50 KB | 2001 | skipped | 0-3 | 0-2 |
| `<b id=bN>` x1999 unclosed | 23 KB | 1999 | runs | 157 | 0 |
| **`"<div></i>".repeat(40000)`** (stray end tags) | 360 KB | **1** | runs | **7748** | 4 |
| `"<div></x>".repeat(40000)` + closes | 600 KB | 1 | runs | 7735 | 5 |
| `"<blockquote></span>".repeat(40000)` | 760 KB | 1 | runs | 5415 | 2 |
| **1990 distinct unclosed `<b id=..>` then `<p>y</p>` x5000** | **62 KB** | 1991 | runs | **7107** | 1 |
| 1500 distinct `<b>` then `<p>` x10000 | 97 KB | 1501 | runs | 11987 | 1 |
| 20000 distinct `<b id=..></i>` then `<p>` x200 | 330 KB | 2 | runs | **31893** | 2 |

Two mechanisms: (1) `estimatedDepth` subtracts one for EVERY end tag, including stray ones the browser ignores, so
`<div></i>` x40k reads as depth 1 while the real tree is 40k deep -- exactly loop 8's 5-8 s cost, guard bypassed;
(2) formatting-element reconstruction: N distinct open `<b>` (Noah's Ark only merges identical ones) are rebuilt in every
later paragraph, N x M elements, with the estimate below the limit and no stray tag needed (62 KB -> 7 s).
Main is 0-5 ms on all of them. Every live work-email read re-maps every snapshot record, so one hostile body costs that on
every read, flags OFF. Hostile sender only; no real client writes these.

**Minimal fix (prototyped, `bun scripts/verify9-guard-proto.ts`, not wired into src/):** bound parse5 by what it actually
BUILDS -- a tree adapter over `defaultTreeAdapter` that tracks real depth in `appendChild`/`insertBefore` and counts
`createElement`, throwing past depth 2000 or `4 x start-tag count + 2000` elements; visibleHtml's existing `catch` then
returns the html unchanged (main's text). Measured: all six hostile inputs stop in **16-138 ms** (guard:depth or
guard:nodes); **0 of 398** corpus rows (loop 5/6/8/9 + implementer truth) trip it, so no output changes; a 180 KB
Outlook-style table report parses unguarded in 23 ms. `estimatedDepth` can stay as a cheap pre-check or go.

### 1e (second question). Can a realistic email cross the limit, and is that acceptable?
`estimatedDepth` over-counts unclosed `<p>`/`<li>`/`<td>`/`<tr>`/`<option>`, XHTML-style `<div/>`, and tags inside
comments (VML `<v:fill .../>`, `<o:AllowPNG/>` count as opens). A long generated report or newsletter with ~2000 unclosed
cells/paragraphs could cross it. Then visibleHtml returns the html unchanged: hidden text, comments and `<head>` text
are shown exactly as on main (htmlToText on the branch has no comment / head stripping of its own; main had none either).
The remaining differences on that path are only entity decoding (approved) and the line-474 regex (1d). With line 474
removed, an over-limit email reads exactly like main -- acceptable under the owner's rule (keep-more, main's behaviour);
it only loses the approved hidden-text cut for that one email.

### Radius challenge (claim 1)
`htmlToText` from onedrive-feed.ts is also imported by `src/features/huddle/lib/external-feeds/teams-log.ts:26` (new on
the branch, not in the brief's radius) -- checked under claim 4. `inbox-read.ts` has its OWN `htmlToText` (line 254),
byte-identical to main (diff empty), so the Graph inbox tool is outside the radius.
