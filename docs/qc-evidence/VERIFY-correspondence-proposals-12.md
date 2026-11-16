# VERIFY-correspondence-proposals-12

WHAT:       Independent verifier loop 12 for `claude_task-proposals` @ `4d0019a0` (includes a merge of origin/main) vs `origin/main` @ `9783d3fc`.
WHY:        Loop 11 refuted claims 1/4 on Node speed (tag-span loop rebuilt `${PREFIX}${html}` per element). 13bce386 claims the
            hoist fix. New since loop 11: Teams daily load window, Teams owner fallback, one-time backfill script, merge of main.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-11.md stays as the loop-11 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify12-*` on this branch; loop 5-11 probes copied unchanged from the loop-11 branch.

Verifier started 2026-11-15 23:14 UTC. Budget 75 min active. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): CONFIRMED

## Claim 0: every suite at 4d0019a0 -- CONFIRMED
Ran EVERY `scripts/*.test.ts` (107 files) with `bun <file>` (PG 16 at /usr/lib/postgresql/16/bin for the SQL suites), plus
`node --experimental-strip-types scripts/html-visible-node-timing.test.mts`, `npx tsc --noEmit`, `npm run build`.
**97 of 107 exit 0; node timing 3/0; tsc exit 0 with 0 lines; build exit 0.** The 10 non-zero files are the same 10 as
loops 10/11, each re-run against `origin/main` @ `9783d3fc` (git archive, same node_modules):

| file | branch | origin/main |
|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | rc 1 under `bun <file>`; `bun test` rc 0 | `bun test` rc 0 |
| fireflies-minutes, focus, memory-mode, model-policy, start-on-approval | rc 1 | rc 1, FAIL lines identical (diffed, timings stripped) |
| confirm-reask-db | rc 2 (refuses without LOCAL_PG_ADMIN_URL) | rc 2, identical |

Named suites, observed (all match the implementer's numbers): html-visible-loop5 46/0, checklist-tool 8/0, forwarded 22/0,
onedrive-feed-truth 11/0, inbound-email 72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0,
correspondence-ingest 161/0, proposals-preview 15/0, feed-staleness 98/0, meeting-triage 69/0, attention all passed,
onedrive-feed all passed. SQL: task-proposals-sql 45/0, correspondence-ledger-sql 50/0, feed-staleness-sql 23/0,
meeting-triage-sql 34/0, fireflies-queue-sql all passed.

- Claim 1 (email text = main except approved changes, AND speed on Node): CONFIRMED

## Claim 1: email text + speed -- CONFIRMED (loop-11 refute is fixed)

### 1-PERF re-derived under Node 22 (production runtime), my own bodies
`scripts/verify12-node.mts` (new bodies, none from the implementer's suite): a 30-reply Gmail thread with nested
`gmail_quote` blockquotes, a 1500-card newsletter (nested layout tables, inline styles, `alt="... > ..."` on every image,
hidden spacer spans), a 12k-row table where EVERY cell tag holds a `>` in an attribute (every start tag is rewritten, so
the edit list is at its largest), an Outlook body with list conditional comments + a `divRplyFwdMsg` reply header + 6000
quoted lines, and 1.6 MB of tiny elements. One process per row; first call cold, warm = median of 3.

| body | size | 4d0019a0 first / warm | 907dade7 (pre-rewrite base) first / warm | 90af5f3a (loop 11) first / warm |
|---|---|---|---|---|
| gmail-thread-30 | 33 KB | 19 / 6 ms | 20 / 7 ms | 23 / 8 ms |
| newsletter-1500 | 869 KB | 161 / 103 ms | 159 / 98 ms | **6818 / 8610 ms** |
| gt-attr-table-12k | 832 KB | 201 / 143 ms | 152 / 89 ms | >120 s timeout (killed) |
| outlook-lists-reply | 1313 KB | 275 / 148 ms | 248 / 176 ms | >120 s timeout (killed) |
| many-elements-1.6MB | 1777 KB | 549 / 510 ms | 470 / 390 ms | >120 s timeout (killed) |

Every row on 4d0019a0: hidden text cut, the ask kept. 4d0019a0 is within 1.0-1.6x of the 907dade7 base on every row (the
worst ratio is the every-tag-rewritten table, 1.6x warm, 201 ms cold for 832 KB); 90af5f3a is 40x+ or never finishes.
The loop-11 figures (Outlook 947 KB, 217 KB report, 332 KB paragraphs) are covered by the implementer's Node suite, which
I re-ran: outlook-950KB 192 ms, report-217KB 90 ms, gt-attrs-250KB 65 ms.

### The Node timing suite is a real guard (mutation, run in a scratch copy of src, never in the worktree)
`mutate.sh` could not read this suite's output format (UNDETERMINED, nothing proven, tree restored), so I applied the
mutation to a scratch copy of `src/` with the suite copied beside it:

| variant of html-visible.ts | suite result |
|---|---|
| as committed | 3/0 (192 / 90 / 65 ms) |
| control: one comment line appended | 3/0 (169 / 96 / 47 ms) -- EQUIVALENT |
| start-tag slice reverted to `` `${PREFIX}${html}`.slice(...) `` | **1/2 FAIL** (4472, 2541 ms; gt-attrs 1146 ms passes) |
| both slices reverted (= 90af5f3a) | **0/3 FAIL** (9454, 2519, 1590 ms) |

FIRED, control equivalent. Note: the gt-attrs row alone would not catch a start-tag-only revert (1146 ms under its
1500 ms limit); the other two rows do. Limits carry ~8x headroom over today's times, so CI noise should not flake them.

### Text unchanged by the hoist (reduced-depth re-check of everything loops 5-11 confirmed)
- `BASE10=<907dade7 tree> bun scripts/verify11-probes.ts` (113 rows: 66-row tag-span spelling table + 18 comment shapes +
  31 own shapes): output **byte-identical to loop 11's** after stripping timings (0 diff lines). Summary: word-drops 2
  (S-43 approved Q1-A cut, C-noscript = base), ask-flips-vs-main 2, **flips-against-chromium 0**, branch==chrome 67.
- `bun scripts/verify8-chromium-rows.ts` (370 Chromium-recorded rows over 4 sets): regression drops 0/0/0/0; the only
  flip against Chromium is `fontzero-attribution` (unchanged since loop 8, font-size:0 text, = base).
- `bun scripts/verify10-quote-probes.ts` (1d comment fix, 20 rows): drops 0, flips 0, flips against Chromium 0.
- The main column is current main: `scripts/verify5-main/onedrive-feed.ts` differs from `origin/main` @ 9783d3fc only in
  one import path line; `inbound-email.ts` identical.
