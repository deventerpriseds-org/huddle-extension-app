# VERIFY-report-from-ledger-2

WHAT:       independent verification, loop 2, of the uninvolved-chat findings fix (branch claude_fix-uninvolved-chat-findings, head fd1da2fe)
WHY:        loop 1 (VERIFY-report-from-ledger-1.md) REFUTED claim 1: @Everyone hid a chat; a non-array mention field aborted the report
SUPERSEDES: nothing (loop 1 stays as the record of the refutation)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   probe /tmp/.../scratchpad/probe2.ts (synthetic data only); mutate.sh outputs m1..m4.out; commands below

## Suites

| where | report-from-ledger | fireflies-list | correspondence-ingest | forwarded-store | tsc |
|---|---|---|---|---|---|
| fix branch fd1da2fe | 62 / 0 | 9 / 0 | 186 / 0 | n/a | rc=0 |
| test-merge fix + origin/main 19903a7e | 62 / 0 | 9 / 0 | 186 / 0 | 83 / 0 | rc=0 |

Test-merge `git merge origin/main` into the fix: NO CONFLICT (#261 forwardsFromLedger and source-item changes auto-merged).

## Claims

| # | claim | verdict | evidence |
|---|---|---|---|
| F1 | @Everyone / tag / other non-user mention no longer hides a group chat | CONFIRMED (new rows) | probe cases A,B,C,D,E,F,G,H,I,J,K,N,O,R,T,U,V,Y,Z all `hide=false owner_maybe_mentioned`, parsed end to end (parseTeamsLog -> teamsContent -> teamsChatsFromLedger). Uninvolved controls L,M,P,Q,X,ZA still `hide=true` (no over-match). |
| F1-residual | rows stored by #257 before the flag existed | KNOWN, UNCHANGED (documented by builder) | stored `{mentionedUserIds:[], text:"Everyone please send"}` with no `unresolvedMention` -> `hide=true uninvolved`. ledger.server.ts:217-219 keeps old content when the hash is unchanged, so live ingest never adds the flag; only an applied back-fill does. |
| F2 | one malformed stored row cannot abort the report | CONFIRMED for every reachable shape | stored mentionedUserIds string/object -> `cant_tell_no_mention_data`; `[null]`,`['']`,`[7]` -> `owner_maybe_mentioned`; a null message entry -> `cant_tell_malformed`; 8 malformed rows beside a good row through teamsChatsFromLedger + planLedgerReport: no throw, other chat unaffected. Only `null` as a whole row throws (report-from-ledger.ts:254, outside the per-chat try) -- unreachable: the loader builds every row as an object (report-from-ledger.server.ts:37). |
| F4 | empty id / null entry / tag reads as unknown, not nobody | CONFIRMED | probe C,D,E,H,N,O + stored `[null]`,`['']`,`[7]`. |
| F5 | one owner-id normaliser at both sites | CONFIRMED | stored mention `' OWNER-GUID-0001 '` -> owner_mentioned; sender id `' OWNER-GUID-0001 '` -> owner_sent; facts and rule both go through teamsOwnerIds/normTeamsId (diff). |
| F6 | Fireflies union trims known ids | CONFIRMED | VF6-1, VF6-2 pass; mutation M3 FIRED. |
| F3, F7 | deliberately unchanged | NOT REACHED | budget hit before mapping the brief's numbering to loop-1's report (loop 1 lists 5 "cases the suite misses", not 7 findings). |
| L1 re-checks | window since Monday, resolved exclusion, 1:1 always shows, rule before AI, mentions stored / hash unchanged, union | CONFIRMED (reduced depth: named suite tests) | W-1..W-4, R-1/R-4/R-5/R-8/R-9, U-3, P-1, TP-2, FL-6 all PASS on fix and on the test-merge. |

Probe expectation errors (not defects): ZB, an entity-escaped `&lt;at&gt;` in an HTML body, is literal typed text, not a Graph mention, so hide=true is correct.

## Mutations (mutate.sh, exit code read)

| guard (builder: NOT PROVEN) | mutation | test | verdict | exit |
|---|---|---|---|---|
| parser `unresolved = true` for a non-user mention (teams-log.ts mentionFacts) | drop the `unresolved = true` line | VF1-2 | FIRED (control EQUIVALENT) | 0 |
| rule-level try/catch in chatInvolvement | `catch { return cant_tell_malformed }` -> `catch (e) { throw e; }` | VF2-2 | FIRED (control EQUIVALENT) | 0 |
| normMeetingId trim | `id.trim()` -> `id` | VF6-2 | FIRED (control EQUIVALENT) | 0 |
| teamsContent copies unresolvedMention | spread -> `{}` | VF1-9 | FIRED (control EQUIVALENT) | 0 |

Note: the builder wrote that VF1-1 catches the parser line. It does not. With that line removed, VF1-1 still passes, because the body `<at id="0">` check flags the same message, so the two checks overlap. VF1-2, VF4-1 and VF4-2 are the tests that fail.

## Blast radius challenge

`origin/claude_actions-view` (50063519) ALSO edits `chatInvolvement`. `git merge-tree` against the fix branch:
CONFLICT in report-from-ledger.ts lines 187-203. The actions-view side adds team CHANNELS (`kind !== "channel"`) to the
hideable kinds, but keeps the OLD body (unguarded `.some`, no maybe-mention). Taking actions-view's side wholesale
re-opens findings 1, 2 and 5. Correct resolution: the fix side's body PLUS the actions-view channel condition.
Actions-view does not read `unresolvedMention`/`mentionedUserIds` elsewhere (git grep), so the stored-content change alone does not alter it.

## Verdict

PASS on F1 (new rows), F2, F4, F5, F6 and on the loop-1 re-checks. MERGE for the fix branch. Findings 3 and 7: NOT REACHED.
Required: resolve the actions-view conflict as above when either branch lands second.
