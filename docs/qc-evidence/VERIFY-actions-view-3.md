---
WHAT: Independent verification, loop 3, of the Actions view (branch claude_actions-view head 5a21fc7b).
WHY: Loop 2 (VERIFY-actions-view-2.md) refuted D1, D2, D4, D5, D6 and left O1, O2, the E-U table, the 96-AC sweep and
     the UI claims NOT REACHED. The builder's loop-2 fix log is BUILD-actions-view.md "## Loop-2 fixes".
SUPERSEDES: nothing (VERIFY-actions-view-2.md is the previous loop, kept as the record of the defects).
SUPERSEDED-BY: nothing -- current.
EVIDENCE: this file; probes in docs/qc-evidence/verify-actions-view-3-probes/.
---

# VERIFY: actions-view, loop 3

Code under test: `git archive 5a21fc7b` unpacked to a scratch dir (node_modules linked from the main checkout).
Started 2026-11-17 02:22 UTC. Budget 60 minutes. Synthetic data only.

## Verdicts (appended as each check completes)

### 0. Named suites on 5a21fc7b

| suite | command | result |
|---|---|---|
| actions-view | `bun scripts/actions-view.test.ts` | exit 0, `82 passed, 0 failed` |
| actions-view-server (real PG 16) | `bun scripts/actions-view-server.test.ts` | exit 0, `26 passed, 0 failed` |
| correspondence-ledger-sql | `bun scripts/correspondence-ledger-sql.test.ts` | exit 0, `79 passed, 0 failed` |
| report-from-ledger | `bun scripts/report-from-ledger.test.ts` | exit 0, `62 passed, 0 failed` |

Matches the builder's counts (82 / 26 / 79 / 62). **CONFIRMED.**

### 1. Every suite in the BUILD log, tsc, build -- on 5a21fc7b and on a test-merge with origin/main 9c1859e1

Runner: `verify-actions-view-3-probes` is not needed; a loop over the 20 suites named in the BUILD log's "Final
checks", then `npx tsc --noEmit`, then `npm run build`. Test-merge: `git merge-tree --write-tree 5a21fc7b 9c1859e1`
-> tree a2d47c8a, no conflict; its only difference from 5a21fc7b is `scripts/proposals-preview.ts` (+16/-1).

| suite | 5a21fc7b | test-merge a2d47c8a |
|---|---|---|
| actions-view | 82 passed, 0 failed | 82 / 0 |
| actions-view-server (real PG 16) | 26 / 0 | 26 / 0 |
| correspondence-ledger-sql | 79 / 0 | 79 / 0 |
| report-from-ledger | 62 / 0 | 62 / 0 |
| task-proposals / -sql | 199 / 45 | 199 / 45 |
| meeting-triage / -sql / -server | 69 / 34 / 7 | 69 / 34 / 7 |
| attention / attention-focus | 16 PASS, "all passed" / 27 PASS, "all passed" | same |
| needs-you | 77 / 0 | 77 / 0 |
| correspondence-ingest | 186 / 0 | 186 / 0 |
| onedrive-feed | 61 PASS, "all passed" | same |
| feed-staleness / -sql | 98 / 23 | 98 / 23 |
| redteam-correspondence | 77 / 0 | 77 / 0 |
| onedrive-feed-truth | 11 / 0 | 11 / 0 |
| fireflies-queue-sql | 14 PASS, "all passed" | same |
| fireflies-minutes | 72 PASS, FAIL G3, G5, G8 (exit 1) | same three |
| `npx tsc --noEmit` | exit 0 | exit 0 |
| `npm run build` | exit 0, nitro "You can deploy this build" | exit 0 |

Baseline: `git archive 9c1859e1` (current main) -> `bun scripts/fireflies-minutes.test.ts` -> `FAIL G3`, `FAIL G5`,
`FAIL G8`, `3 FAILED`. The three failures pre-exist on main. **CONFIRMED** (all suites, typecheck and build, on the
head and on the test-merge).

### 2. D1 (Tier 1): a quote stitched across two pieces -- FULL RE-DERIVATION

Code read (`src/features/huddle/lib/correspondence/action-classify.ts:157-195`): `emailQuoteHaystack` returns
`[latestOther.text, forwardOfThatMessage]` (or one piece, or `[]`); `teamsQuoteHaystack` returns one piece per OTHER
message; `quoteIsVerbatim` folds EACH piece separately and uses `pieces.some(p => canon(p).includes(q))`. Every
caller found by `grep -rn "quoteIsVerbatim(\|admitActionVerdict(\|QuoteHaystack("`: `pipeline.ts:169-171` (passes
the list), `scripts/action-scan-steps.ts:132,141,170,179` (passes the list), `needs-you.ts:395` (passes one string,
`latestOther.text` only -- a single piece, no join). No caller joins.

Loop-2 probe re-run (`bun docs/qc-evidence/verify-actions-view-2-probes/quote.ts`): Q15 (Teams two-message stitch)
`verbatim=false admit=not_checked`; Q21 (email body + forwarded part) `false`. Q1-Q14, Q16-Q20 unchanged from loop 2.

New probe `verify-actions-view-3-probes/d1.ts` (10 rows, all `OK`, "all as expected"): OTHER|OWNER|OTHER stitch ->
not_checked; a quote found only in the OWNER's message -> not_checked; three-message stitch -> not_checked; an OTHER
message with null text does not throw and the next message still admits; a quote in the forward alone -> open; a
forward belonging to a DIFFERENT message is not a piece -> not_checked; no latestOther -> `[]` -> not_checked.

Mutation (own, see section 10): D1-M.

Verdict D1: **CONFIRMED FIXED.**

### 3. D4 (Tier 1): Wrong? on one thread brought back another thread sharing the proposal -- FULL RE-DERIVATION

Code read: `actions.ts:171-239` -- `owner_correction` is `{v:2, items:{<itemKey>: correction}}`; `correctionsOf`
reads the v2 map (only entries whose stored `itemKey` equals the map key) or the pre-D4 single object as a map of one;
`withItemCorrection` / `withItemUndo` change ONE entry and carry every other one over. `pipeline.ts:262,337` reads
`correctionFor(p.correction, u.itemKey)` for thread and meeting rows. `actions.server.ts:354-412` `correctItemFor`:
backing check (D6) first, then `BEGIN; SELECT owner_correction ... FOR UPDATE; UPDATE; COMMIT` on one pooled client,
ROLLBACK on every early return and on throw; the ledger mirror after COMMIT is per version and best-effort.

Builder's real-PG suite re-run: D4-S1..S5 PASS (26/26 above). Loop-2 probe `correction.ts` re-run is moot (it
exercised the pure single-correction shape that no longer exists).

Independent real-PG probe `verify-actions-view-3-probes/v3-probe.test.ts` (fresh PostgreSQL 16, synthetic data):
`V3-D4c` 5 rounds, each: two chats attached to ONE proposal, `Promise.all` of Wrong? on A and Wrong? on B (two pool
connections, truly concurrent), then `Promise.all` of Undo on A and a second Wrong? on B. Every round: both
corrections survive the first pair; after the second pair A is shown and B hidden -> `PASS`, 5/5. (A first run
returned FAIL because my probe used the reason `already_done`, which is not in `CORRECTION_REASONS`
(`actions.ts:135`); the server correctly answered "Pick a reason." Re-run with `already_handled` -> PASS.)

Mutation (own): D4-M in section 10.

Verdict D4: **CONFIRMED FIXED.**

### 4. D6: Wrong? trusted the client's itemKey -- FULL RE-DERIVATION

Code read: `itemBacking` (`actions.server.ts:421-452`): a thread key is backed only by a ledger row of the owner's
whose `result_ids.action.key` = itemKey AND `result_ids.action.proposalId` = the proposal; the mirror row is THAT
row. A meeting key is backed only by a transcript ref of this proposal with `'meeting:' || source_item_id || '|' ||
norm_title` = itemKey, matching the client format at `pipeline.ts:336`. A read error returns null (refused). The
check runs for Undo too (`correctItemFor` calls it before either branch). Suite: D6-S1..S7 PASS.

Observation (not a defect): an itemKey of an OLDER version of the same thread (its verdict row still exists after a
newer message) is still "backed", so a stale page can still Wrong?/Undo that older version. It writes only that
version's entry and the old row's mirror, so it cannot hide the current version (`correctionHides` compares keys).

Verdict D6: **CONFIRMED FIXED.**

### 5. D2: failed model calls did not count toward the daily cap -- FULL RE-DERIVATION

Code read: `pipeline.ts:141-160` -- `recordCall` is awaited BEFORE `deps.model`; a throw from it `break`s the pass
(no call); `res.calls++` follows the record. `actions.server.ts:78-90` `recordActionCall` is ONE UPDATE appending to
`result_ids.action_calls` (prunes >48h), throws unless `rowCount === 1`. `actionCallsToday` (`:97-109`) counts
attempts since the owner's local midnight, `max(attempts, verdicts today)`. `classifyCallsLeft` (`pipeline.ts:91`):
`max(0, min(6, cap - used))`, a non-finite `used` -> 0. `dailyCap` itself is clamped finite in
`resolveActionsSettings` (`actions.ts:76`), so a NaN cap cannot reach `classifyCallsLeft`. `markProcessed`
(`ledger.server.ts:359-364`) carries both `action` and `action_calls` over; `grep -rn "result_ids\s*=" src` (not `||`
merges) finds only that UPDATE and `recordActionCall`.

Suites: D2-1..D2-5 (offline), D2-S1..S6 and D2-E1 (real heartbeat, real SQL) PASS. Independent: `V3-D2c` 25
concurrent `recordActionCall` on the SAME ledger row -> `actionCallsToday` = 25 -> `PASS` (the append is atomic under
concurrency; no lost count).

Mutations: D2-M in section 10.

Verdict D2: **CONFIRMED FIXED.**

### 6. D3: the cross-instance overrun bound, as stated

Statement (BUILD log line 165-167): "only passes that START on two instances in the same moment overrun ... bound =
(instances - 1) x min(6, cap - used) extra calls per overlapping 10-minute pass". Code: each instance reads `used`
ONCE at the start of its pass (`actions.server.ts:164-165`) and may start up to `left` calls within its 20 s budget
(`CLASSIFY_BUDGET_MS`). Derivation: instance B starting while A is mid-pass reads `used` after A's first records, so
it overruns by LESS but still overruns (derived from the code, NOT run: cap 5, used 3; A reads 3 -> left 2, records 1; B starts, reads 4
-> left 1; total 3 calls -> 6 for the day). So "START in the same moment" is imprecise: any two passes whose 20 s
windows overlap can overrun. The BOUND itself holds, because each extra instance's `left` <= min(6, cap - used at
the earliest start). D3-MEASURE (`actions-view` suite) reproduces the simultaneous case: 4 calls -> 7.

Verdict D3: bound **CONFIRMED**; the wording "only passes that START ... in the same moment" is **inaccurate** (LOW,
doc only, `BUILD-actions-view.md:165`): it should read "passes whose ~20 s windows overlap".

### 7. D5: the client `from:"actions"` flag bypassed the proposals flag -- FULL RE-DERIVATION

Code read (`proposals.server.ts:290-322`): order is config (either switch) -> `callerOwners` (sign-in) ->
`proposalBacksActionsRow` (server-side, owner-scoped, fail closed) -> `cfg = proposalsCfg ?? (fromActions ?
actionsCfg : null)` -> triage gate `!fromActions && !meetingTriageOn` -> bell settle only when `fromActions && r.ok &&
!r.alreadyDone`. `proposalBacksActionsRow` (`actions.server.ts:458-473`): proposal is the caller's AND (an `open`
thread verdict points at it OR it has its own transcript ref). Suite: D5-S0..S5 PASS (the REAL `actOnProposal`).

Verdict D5: **CONFIRMED FIXED.**

### 8. O1: a follow-up after Dismiss silently disappears -- run against a REAL store

`v3-probe.test.ts` V3-O1, REAL `runActionsClassify` + REAL `getActionsPage` + real `pgProposalStore`/ledger on
PostgreSQL 16, model mocked to ADMIT the ask. Observed (`v3-probe.out.txt`):
- pass 1: chat F "Could you please send the synthetic budget sheet by Friday?" -> verdict open, proposal created;
  page `counts.all = 1`.
- Dismiss the proposal -> page `counts.all = 0`.
- Follow-up message 2 in chat F, same ask -> pass 2 makes 1 model call; stored verdict
  `{"status":"open","onBoard":true,"proposalId":null}` (suppressed by F15, mapped to onBoard at
  `actions.server.ts:182`); page `counts.all = 0`, `hidden.total = 0`, `notChecked` unchanged (=1, the other chat).
So the follow-up is in no list and no count. This MATCHES AC-C-6 ("Dismiss ... the same normalised to-do is not
proposed again from any source") and AC-E-10, so it is not a defect against the ACs.
- **O1 (LOW, record accuracy)**: the stored verdict says `onBoard: true` although the to-do is NOT on the board; it
  was suppressed by a dismissal. Anything reading `onBoard` later (support, a future "already on your board" label)
  would be told something false. Repro: V3-O1 above.

Verdict O1: **CONFIRMED** (behaviour proven on a real store; consistent with AC-C-6; LOW mislabel).

### 9. O2: an edited latest message keeps its old verdict -- run against a REAL store

V3-O2: `observe` the same message id with a new content hash, then `storeContent` the new text "Never mind, all sorted
now, thanks.". Observed: the row has `content_hash = f2-edited` and the new text, `result_ids.action.quote` is still
"send the synthetic budget sheet by Friday" (no longer in the text), the next pass makes 0 model calls
(`alreadyJudged: 2`). Cause: the itemKey is thread key + latest message id (`pipeline.ts:61,67`), and the ledger's
content-change upsert (`ledger.server.ts:224-240`) never touches `result_ids`. No AC covers edits (AC-E-7 says "a new
message arrives (new latest id)").
- **O2 (LOW)**: an edited ask keeps showing the old to-do and a quote that is no longer in the message, and is never
  re-judged unless a newer message arrives. Repro: V3-O2.

Verdict O2: **CONFIRMED** as described (LOW, outside the ACs).

### 10. Mutation proofs run by this verifier (`mutate.sh` on PATH, anchors extracted from the source into files, exact test names)

Run in a git snapshot of 5a21fc7b (scratch repo, tree clean before and after; `git status` shows only my untracked
probe). Anchors/replacements are one line each, shown as before -> after.

| id | file | mutation | test cmd / pattern | outcome | exit |
|---|---|---|---|---|---|
| D6-M | actions.server.ts `itemBacking` | `AND result_ids->'action'->>'key' = $2 AND` -> `AND $2::text IS NOT NULL AND` (any verdict row of the proposal backs any key) | actions-view-server / `D6-S2 GUARD: a made-up itemKey ending in a real ledger id` | **FIRED (control EQUIVALENT)** | 0 |
| D2-M | actions.server.ts `recordActionCall` | `if ((r.rowCount ?? 0) !== 1) throw ...` -> `void r;` (a missing row no longer stops the call) | actions-view-server / `D2-S3 recording on a row that is not there throws` | **FIRED (control EQUIVALENT)** | 0 |
| D4-M | actions.ts `correctionsOf` | pre-D4 single-shape line -> comment (old stored corrections ignored -> un-hidden) | actions-view / `D4-4 the pre-D4 single shape is read as its one item` | **FIRED (control EQUIVALENT)** | 0 |
| D1-M | action-classify.ts `teamsQuoteHaystack` | `c.messages.filter((m) => m.speaker === "OTHER").map` -> `c.messages.map` (the OWNER's own messages become quote pieces) | actions-view (whole suite) | **INERT** | 1 |
| D5-M | actions.server.ts `proposalBacksActionsRow` | drop `AND result_ids->'action'->>'status' = 'open'` | actions-view-server (whole suite) | **INERT** | 1 |

Reading the two INERT results:
- **D1-M INERT = test gap (LOW).** The code is right (probe d1.ts P2: a quote found only in the owner's message ->
  not_checked), but no test locks "the owner's own words are not a quote source". If someone widened the haystack,
  the model could cite the owner's own sentence as the ask and it would be admitted. Repro: apply D1-M, run
  `bun scripts/actions-view.test.ts` -> 82/82 still pass.
- **D5-M INERT = behaviourally equivalent in reachable states, so NOT PROVEN rather than broken.** A verdict only
  carries a `proposalId` when it is `open` (`admitActionVerdict` builds every verdict with `proposalId: null`;
  `runClassify` sets it only inside `if (v.status === "open")`, `pipeline.ts:172-176`). So no stored verdict can be
  non-open AND point at a proposal, and the clause cannot change an outcome today.

Totals: 3 FIRED (all controlled), 2 INERT (one test gap, one equivalent), 0 NOT-APPLIED. With loop 2's M1-M3 and the
builder's d1a-d6c, the D1, D2, D4 and D6 guards each have at least one FIRED proof by someone other than the builder
(D1 by loop-2 M1 on the length clause; the piece-split itself only by the builder's d1a-d1c).

### 11. E-U spelling table (AC-EU-1), row by row

`verify-actions-view-3-probes/eu.ts` calls the ONE rule `chatInvolvement` (main's #262 body; the only change on this
branch is `&& kind !== "channel"`, confirmed by `git diff 9c1859e1 5a21fc7b -- .../report-from-ledger.ts`: one hunk
inside `chatInvolvementOf`) with stored-message shapes exactly as `external-feeds/teams-log.ts:282-311` writes them.

| row | expected (AC) | observed | verdict |
|---|---|---|---|
| S-1 1:1 | show | hide=false one_on_one | CONFIRMED |
| S-2 group, never wrote, empty mentions | HIDE | hide=true uninvolved | CONFIRMED |
| S-3 meeting chat | HIDE | hide=true uninvolved | CONFIRMED |
| S-4 channel `thread.tacv2` | HIDE | hide=true kind=channel | CONFIRMED |
| S-5 upper-case id | as S-2 | hide=true | CONFIRMED |
| S-6 fromOwner true | show | owner_sent | CONFIRMED |
| S-7 sender id = owner id other case | show | owner_sent | CONFIRMED |
| S-8 owner @mentioned | show | owner_mentioned | CONFIRMED |
| **S-9 team / tag mention only** | **HIDE** | **hide=false, reason owner_maybe_mentioned** (ingest shape: `mentionedUserIds: []`, `unresolvedMention: true`) | **REFUTED (D7)** |
| S-10 one message lacks mention data | show | cant_tell_no_mention_data | CONFIRMED |
| S-11 no owner id anywhere | show | cant_tell_owner_unknown | CONFIRMED (id only in config: hide, as designed) |
| S-12 fromOwner null | show | cant_tell_owner_unknown | CONFIRMED |
| S-13 unknown suffix | show | not_group_or_meeting | CONFIRMED |
| S-14 owner wrote only before the window | show | owner_sent | CONFIRMED |
| S-15 switch OFF -> classified | show + classified | suite S-15 and E-1 PASS; loop-2 M2 FIRED on `pipeline.ts` | CONFIRMED |

Extra: a null stored message -> `cant_tell_malformed`, no throw; a non-string chat id -> unknown, show.

**DEFECT D7 (LOW, spec vs. merged rule; fails toward SHOWING).** AC row S-9 says a chat whose only mention is a team /
tag / @Everyone mention is HIDDEN. The ingest (`teams-log.ts:99-123` `mentionFacts`) marks exactly that mention
`unresolvedMention: true`, and main's merged rule (`report-from-ledger.ts:196`, `maybeMentionsOwner` at `:230-238`,
main's #262 "finding 1") then SHOWS the chat as `owner_maybe_mentioned`. The suite's S-9 test
(`scripts/actions-view.test.ts:107`) passes only because its fixture omits `unresolvedMention`, a shape the ingest
never writes for a mention. Repro: `CODE=<checkout> bun docs/qc-evidence/verify-actions-view-3-probes/eu.ts`, row
S-9a. Impact: such chats are shown and sent to the model (one call each, within the cap), never wrongly hidden. The
AC and main's rule disagree; the owner decides: keep main's fail-open behaviour (then fix the S-9 row and the fixture)
or hide tag-only mentions (then change main's rule).

AC-EU-2 (switch ON -> hidden chats never reach the model, counted in N hidden): `pipeline.ts:69-73` plus suite E-1 and
S-15 -> CONFIRMED. AC-EU-3 (one rule): one `chatInvolvement` definition in `src` + `scripts` -> CONFIRMED.

### 12. UI claims, read from code (`git diff 9c1859e1 5a21fc7b` of Rail.tsx, HuddleApp.tsx, store.ts, AppsLauncher.tsx, ViewSwitcher.tsx; ModulesLauncher.tsx and ActionsView.tsx read)

- **Priorities and Schedule are still reachable.** Desktop: `Rail.tsx` drops them from `items` and renders
  `RailModulesButton` (popover `side="right" align="start"`, header "Modules", `LauncherList items={HUDDLE_MODULES}`
  = Priorities, Schedule, Actions, each setting `view`). Desktop header: `ViewSwitcher` inline = Huddle, Board, Files
  + `ModulesPill` (same list). Phone: `BOTTOM_ENTRIES` = Huddle, Board, Modules, Files, Apps; Modules opens
  `ModulesSheet` with the same list; grid columns derived (`bottomGridClass(5)` = `grid-cols-5`). `HuddleApp.tsx`
  `VIEWS` keeps `priorities`/`schedule` and adds `actions`; `View` union gains `"actions"` (`tsc` exit 0 enforces the
  `Record<View>`). X-3 (header pills lose Priorities/Schedule) is recorded as approved in the AC file (line 156).
  **Code: CONFIRMED. Rendered: MERGE-PENDING-UAT.**
- **Design tokens, not raw colours.** A regex for Tailwind palette colours (`bg|text|border|ring|fill|stroke|from|to|
  via`-`red..black`), hex, `rgb(` and `hsl(` over ActionsView, ModulesLauncher, ViewSwitcher, Rail, HuddleApp and
  AppsLauncher -> **0 hits**. New classes use `bg-muted`, `text-foreground`, `text-muted-foreground`,
  `bg-primary-foreground/15`, `bg-surface`. **CONFIRMED (code).**
- One shared list component (AC-M-12): `LauncherList` exported from AppsLauncher, used by Apps (`AppList`) and all
  three Modules surfaces. Touch targets: `min-h-11` on list rows and bottom-bar buttons. Badge only when > 0, shows
  `counts.all` from the same `getActionsFn`. Active state: `aria-current="page"` when `MODULE_VIEWS.has(view)`.
  **CONFIRMED (code); rendered MERGE-PENDING-UAT.**
- Phone top bar: `VIEW_TITLE` gives every view its own name, huddle view keeps the huddle's name (X-5).

### 13. Sweep of all 96 ACs (`AC-actions-view-modules.md`)

Method per AC: a named passing test (suite run in section 1), a probe of mine, or a code read. Anything only
observable in a browser is MERGE-PENDING-UAT (code read consistent, not rendered). Nothing below was run in a browser.

| ACs | evidence | verdict |
|---|---|---|
| M-1, M-2, M-3, M-4, M-7, M-8, M-9, M-10, M-11, M-12, M-13, M-14 | code read, section 12 (M-14 keyboard/Esc/focus return comes from the Radix Popover used, not new code) | code CONFIRMED; rendered **MERGE-PENDING-UAT** |
| M-5 badge = All | code: badge reads `r.counts.all` from `getActionsFn`, hidden at 0 | code CONFIRMED; **MERGE-PENDING-UAT** |
| M-6 View union + VIEWS | `store.ts` diff, `HuddleApp.tsx` diff, `tsc` exit 0 | **CONFIRMED** |
| B-1..B-13 | code: `WidgetPage`, `CollapsibleSection` with counts, "Since Monday, <Mon D>" (`ActionsView.tsx:97`), never-classified state distinct from "caught up" (`:269-284`), error + Retry (`:219`), "What shows · N hidden" (`:205`), `truncate` + `title=` (`:308,327,517,524`), tokens only (section 12); section order F-4, newest first F-2, window C-1..C-5 | logic **CONFIRMED** by tests/code; rendered **MERGE-PENDING-UAT** |
| C-1 | `actOnProposalFn` with `from:"actions"` (`ActionsView.tsx:378`); no new action endpoint in the diff | **CONFIRMED** |
| C-2..C-5, C-7, C-8, C-11, C-12, C-13, C-14, C-16, C-22, C-23 | existing endpoints reused (code); optimistic/rollback/clipboard/toasts are client behaviour | **MERGE-PENDING-UAT** (not exercised here) |
| C-6 Dismiss + F15 | V3-O1 on a real store: the same to-do from a follow-up is not proposed again | **CONFIRMED** (see O1 mislabel, LOW) |
| C-9, C-10 Draft reply split by `isFeedId` | `saveEmailReplyDraftFn` only for draftable rows (`ActionsView.tsx:422`; `isDraftable: !isFeedId`) | code CONFIRMED; **MERGE-PENDING-UAT** |
| C-15, F-3 Open in Teams | `teamsLink: safeLink(c.webUrl)` (`pipeline.ts:309`), `<a target="_blank" rel="noopener noreferrer">` (`ActionsView.tsx:447,559`) | **CONFIRMED** (code) |
| C-17, C-18, C-19, E-14 (Tier 1) | D4 (section 3), G-1..G-7, D4-1..D4-8, D4-E1..E3, D4-S1..S5, V3-D4c; newer version judged again G-7 / D4-6 | **CONFIRMED** |
| C-20 stop list | F-7 (hidden and counted). Note: `listSender` is client-supplied on Wrong?/Undo and not checked against the row (`actions.server.ts` `correctActionItem`); owner-scoped to his own settings, no cross-user effect | **CONFIRMED** (LOW note) |
| C-21 Wrong? text is data, never logged | G-3 bound; no log line carries it (section F-4 below); not passed to any model in this diff | **CONFIRMED** (code) |
| D-1, D-3, D-10 | client behaviour | **MERGE-PENDING-UAT** |
| D-2 reconciliation | F-3 RECONCILE | **CONFIRMED** (logic) |
| D-4, D-5, D-6, D-7, D-8 | H-3, H-4, F-5, F-6; settings stored server-side via `setActionsSettingsRaw` | **CONFIRMED** (logic); panel rendering MERGE-PENDING-UAT |
| D-9, EU-1, EU-2, EU-3 | section 11 | EU-1 **REFUTED on row S-9 (D7)**, all other rows CONFIRMED; EU-2, EU-3, D-9 CONFIRMED |
| E-1 one classifier module | `action-classify.ts` imported by `pipeline.ts` and `scripts/action-scan-steps.ts` (section 2 grep) | **CONFIRMED** |
| E-2, E-3 (Tier 1) | A-1..A-11, D1 section 2 | **CONFIRMED** |
| E-4, E-5 | A-6, A-7, E-5 | **CONFIRMED** |
| E-6 | B-1, H-7 | **CONFIRMED** |
| E-7 | E-3; V3-O2 (an edit with the same id is NOT re-judged, O2, outside the AC) | **CONFIRMED** |
| E-8, H-3 | E-4, D2 (section 5), D2-E1, V3-D2c | **CONFIRMED** |
| E-9 | C-1..C-5 | **CONFIRMED** |
| E-10 | V3-O1 (one proposal, suppressed follow-up backs nothing) + suite H-6 | **CONFIRMED** |
| E-11 resolved threads not classified | code: the plan splits `email.resolved` / `teams.resolved` from `scan`, and `threadUnits` iterates `scan` only | **CONFIRMED** (code) |
| E-12 store-only sent rows never classified | not traced this loop | **NOT REACHED** |
| E-13 | F-1 | **CONFIRMED** |
| F-1, F-2 | `ownedScope` / `callerOwners` gate on every server fn; D4-S4, D6-S7, D5-S0 other owner refused | **CONFIRMED** |
| F-4 logs | the diff adds 3 log lines, all counts or `e.name` (`git diff 9c1859e1 5a21fc7b -- src`) | **CONFIRMED** |
| G-1, G-2, G-3 (phone) | code (dropdown chip under `md:app-hidden`, `VIEW_TITLE`) | **MERGE-PENDING-UAT** |
| H-1 page read makes no model call | `getActionsPage` (`actions.server.ts:272-311`) calls no model and imports none (code read; not measured) | **CONFIRMED** (code) |
| H-2 heartbeat | `ingest.server.ts` `withActionsClassify` after the pass, only when ingest is on; `classifyDue` 10 min; try/catch; counts-only log | **CONFIRMED** (code) |
| I-1, I-2, I-3, I-6 | unchanged components re-used; nav entries code-read | **MERGE-PENDING-UAT** |
| I-4 bell unchanged | attention 16 / attention-focus 27 all passed | **CONFIRMED** |
| I-5 checklist labels only | `ProposalChecklistItem.tsx` +9/-9 in the diff; not read line by line | **UNPROVEN** |
| I-7 report keeps working | `scripts/action-scan-steps.ts` imports the same module (section 2) | **CONFIRMED** (code) |
| I-8 bell settle from Actions only | D5-S2, D5-S5, H-1 | **CONFIRMED** |
| I-9 markProcessed keeps the verdict | correspondence-ledger-sql 79/79 (AI-9), D2-S2 | **CONFIRMED** |

### 14. Verdict

| class | count |
|---|---|
| Loop-2 defects re-derived | D1, D2, D4, D5, D6 **CONFIRMED FIXED**; D3 bound CONFIRMED, its wording inaccurate (LOW, doc) |
| New defects | **D7 (LOW)** AC S-9 vs main's merged fail-open rule; **test gap (LOW)** owner's own words as a quote source not locked (D1-M INERT); **O1 (LOW)** suppressed follow-up stored as `onBoard: true`; **O2 (LOW)** edited message keeps its old verdict and quote |
| Mutations (mine) | 3 FIRED (control EQUIVALENT), 2 INERT (1 test gap, 1 equivalent in reachable states), 0 NOT-APPLIED |
| Suites | all 20 + tsc + build on 5a21fc7b and on the test-merge with main 9c1859e1; only fireflies-minutes G3/G5/G8 fail, as on main |
| NOT REACHED | AC-E-12; AC-I-5 line-by-line |
| UI | rendered behaviour of every M/B/C/D/G/I UI claim: **MERGE-PENDING-UAT** |

No defect blocks a merge: none of the new findings is above LOW, and D7 fails toward showing (one model call per
such chat, inside the daily cap), never toward hiding. **Verdict: MERGE-PENDING-UAT** -- the code may land; the UI
claims are NOT YET UAT-VERIFIED until a browser run against the deployed app passes. D7 needs the owner's call
(keep main's fail-open rule and fix the S-9 row and fixture, or hide tag-only mentions).
