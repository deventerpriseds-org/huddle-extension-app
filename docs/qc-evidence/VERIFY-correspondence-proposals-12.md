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

- Claim 2 (bell, code): CONFIRMED in code, UI-UNVERIFIED (reduced depth)
- Claim 3 (preview-only code + public-log hygiene): CONFIRMED (reduced depth + new scripts)
- Claim 4 (merge readiness, flags off): CONFIRMED -- and ALREADY MERGED (see the top note)
- Claim 5 (collection-only switch-on safety): CONFIRMED safe, with two owner-visible effects that are NOT collection
  (staleAlerts, sent) and one log-noise defect (minor)

## TOP NOTE: the branch merged to main WHILE this loop ran
`origin/main` is now `132c2fc0` "Merge pull request #251 from claude_task-proposals" (2026-11-16 00:03 UTC, before claim 1
of this loop was pushed). `git diff --stat 4d0019a0 origin/main` = only `.claude/actions.md`, `memory.md`, `parked.md` (1
line each). **So every src result below applies byte-for-byte to what is on main now.** deploy-swa auto-deploys a push to
main that touches src, so this code is (inference, deploy run not read) live with flags as configured.

## Claim 2: bell -- CONFIRMED in code, UI-UNVERIFIED
`git diff 90af5f3a 4d0019a0 -- src` touches only ingest-pass.ts, html-visible.ts, onedrive-feed.ts, teams-log.ts: no bell /
attention file changed, so loop 11's code reading stands; attention suite all passed (A0 pins email/meeting/appointment).
**NOT YET UAT-VERIFIED**: open the bell -> "What counts" -> expect exactly Emails, Meetings, Appointments & reminders. Now
that it is on main, the GHA browser runner (verify-uat.yml) can reach it after the deploy.

## Claim 3: preview / public-log hygiene -- CONFIRMED
Loop 11's reading stands (no preview file changed). New since: `correspondence-probes.ts` P-7 prints file base name, HTTP
status, and `<version time>=<record count>` pairs only. `correspondence-backfill.ts` prints `email|teams version <time>:
records/lines N | items/messages N`, a rejection CODE, and a totals line: counts and timestamps only, no subject, sender,
id or path. `correspondence-backfill.yml` masks the PG URL, password and Graph token (`::add-mask::`); it prints the
runner IP and the PG server / resource-group names (the same pattern as azure-pg-query.yml).

## Claim 4: merge readiness with every flag OFF -- CONFIRMED
- The loop-11 defect (1-PERF) is fixed and guarded (claim 1). Schemas: no tools / huddle.functions change since loop 11.
- **The merge of origin/main lost nothing.** Merge base of 13bce386 and 9783d3fc = aa29eef5. Main changed 7 files since
  (3 ledgers + 4 workflows: correspondence-backfill, graph-permission-check, onedrive-feed-flags, proposals-preview). Every
  one of the 78 files where 4d0019a0 differs from 9783d3fc is a file the branch itself changed since the base (`comm`:
  0 outside), so the 4 workflows are byte-identical to main and nothing main-only was dropped.
- `teams-log.ts` change with configured ids: `owners` is built lower-cased (`onedrive-feed.ts` ownerSenderIds `.toLowerCase()`)
  and `sender()` already lower-cases `who.id`, so `lineOwners.has(who.id.toLowerCase())` = the old `owners.has(who.id)`.

## Claim 5: collection-only switch-on (ingest, teams, sent, teamsLoadAt 18:00, staleAlerts; judge/proposals/bell OFF)

### What runs and what it writes
| piece | runs | writes | owner sees |
|---|---|---|---|
| ingest pass (once-a-minute heartbeat, `ingest.server.ts`) | `processors = []` (bell/proposals off), so `needPayload` is always false | `chat.correspondence_ledger` rows (`pending`; ids, hashes, statuses only, never text) + cursor rows + Teams status note | nothing (no processor) |
| Teams 18:00 window | outside 18:00-24:00 ET: `status: "scheduled"`, no Graph read; never-loaded file reads at once | nothing outside the window | nothing |
| `staleAlerts=true` | `runFeedStaleness` every heartbeat, independent of `ingest` | bell rows kind `feed`; an URGENT incomplete email/sent file also posts an Iris chat directive + an email, once per incident | **YES -- a bell row / Iris message / email when email or sent is stale > 6 working hours or incomplete** |
| `sent` file on | `reconcileRepliedFromSentItems` (`email-replies.server.ts:257`) on the LIVE owed-email path, independent of `ingest` | settles owed WORK-email rows as `replied` when a later Sent Items message is in the same conversation | **YES -- answered work emails leave Iris's owed list** (owner decision 2026-11-12 option A; not collection) |

### (a) Teams daily window -- CONFIRMED
`scripts/verify12-window.mts` (19 rows, my own): spring-forward day (01:59 EST, 03:00/17:59/18:00 EDT), the day before,
fall-back day (both 01:30s, 17:59/18:00 EST), 23:59 in / 00:00 and 00:00:30 out, `00:00` = all day, `23:59`, `7:05`.
**bad=0 of 19 under bun AND under Node 22** (the function copied verbatim into a scratch module for Node, since
ingest-pass.ts's extensionless imports do not load under Node strip-types). Malformed clock -> "in window"; the parser
never passes one through (`25:00`, `6pm`, `18:00:00` fall back to "18:00"; off/null/false disable). Email is unaffected:
the skip is gated on `source === "teams"` (code read; TL-8 pins email still loads). Throttle interplay: inside the window
the existing `minIntervalMinutes` (default 10) applies; due work (`needPayload`) bypasses both, which cannot happen with no
processor. TL-1..9 pass (correspondence-ingest 161/0).

**Minor defect (log noise, not safety):** the pass logs a line unless every part ends `=throttled|unchanged`
(`ingest-pass.ts` last lines). `teams=scheduled` is not in that list, so from 00:00 to 18:00 ET every heartbeat prints
`[correspondence] teams=scheduled | email=throttled` -- about 1,080 lines a day. Counts only, no content. Minimal fix: add
`scheduled` to the regex `/=(throttled|unchanged|scheduled)$/`.

### (b) Teams owner fallback -- CONFIRMED, impact zero with these flags
Both sides are trimmed + lower-cased (`str()` trims; `sender()` and the new line set lower-case), so case and whitespace
variants match (TO-1 pins case). A line with no `ownerUserId` -> `null` "can't tell" (TO-2); configured ids win (TO-3).
**Forged / wrong `ownerUserId`:** it is per line, so it only affects that line's messages: another participant would read
as `fromOwner=true`, which the bell (`bell.ts:45`) and proposals (`proposals.ts:94` skip "own-message") would treat as the
owner's own reply -- a MISSED alert, never a false one. `fromOwner` is not in the ledger's content hash
(`source-item.ts:89`), so the ledger is unaffected. Writing a line requires write access to the owner's OneDrive. With
bell and proposals OFF nothing reads it. **For when bell is switched on (UNVERIFIED, no live file read):** if the flow's
`ownerUserId` is a different id FORM from `from.user.id` (e.g. an `8:orgid:` prefix), every message becomes `false`
instead of `null`, which puts `bell.ts:50` in "configured" mode and the owner's own replies stop settling chats.

### (c) Back-fill script -- CONFIRMED by code reading (not executed: needs Graph + prod PG)
- Writes only through `pgLedger.observe` (`ON CONFLICT (source, source_item_id) DO UPDATE`), so a re-run inserts 0 by
  construction. It never touches the cursor, the bell, proposals or any alert path. Dry run unless `BACKFILL_APPLY=1`.
- **Re-run "changed" is not proven 0 (inference):** versions are observed oldest first and the live file last, so the final
  stored hash is the live file's; an item whose content differs between versions is re-marked `changed` on each pass and
  reset to `pending`. Harmless with no processor on; once bell/proposals run, a re-run could reset processed rows.
- `notBeforeUtc` is REPLACED by `since` (not max'd): if the base config's guard were EARLIER than Monday this would narrow,
  not widen. Either way it only changes which items are stored; nothing announces.

### (d) merge -- see claim 4.
