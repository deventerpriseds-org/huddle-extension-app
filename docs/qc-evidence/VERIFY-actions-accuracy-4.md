# VERIFY actions-accuracy, loop 4

WHAT: independent verification of `main` @ 30898bae (#268 squash) for the actions-accuracy work, D-1..D-7 + C0-C9.
WHY: loop 3 was cut by an owner interrupt; the work was merged as #268. This loop checks main after the merge.
SUPERSEDES: VERIFY-actions-accuracy-3.md (partial, interrupted). SUPERSEDED-BY: nothing -- current.
EVIDENCE: commands + outputs inline. Synthetic data only. Scratch: /tmp/claude-0/-home-user/ed70a92b-1b9b-5829-ab72-8eca54030362/scratchpad/v4/

Started 2026-11-17 05:57 UTC. Budget 25 min. The tests ran on a checkout whose src/ and scripts/ are main 30898bae
(this branch has origin/main merged in; `git diff origin/main HEAD` shows only docs/qc-evidence files).

## Baseline: main is the loop-3 head, byte for byte
```
git diff --quiet 7561f19a 30898bae; echo rc=$?   -> rc=0
git rev-parse 7561f19a^{tree} 30898bae^{tree}    -> d577eb90... d577eb90... (identical)
```
So every loop-3 probe result on 7561f19a also describes main.

## C0 suites on main 30898bae -- CONFIRMED
`bun scripts/<suite>.test.ts`:
```
actions-accuracy 55/0, actions-view 90/0, actions-view-server 28/0, report-from-ledger 103/0,
correspondence-ingest 186/0, meeting-triage 69/0, meeting-triage-sql 34/0, meeting-triage-server 7/0,
task-proposals 199/0, task-proposals-sql 45/0, needs-you 77/0, ai-quota-alert 50/0, ai-quota-alert-sql 12/0
```
All rc=0. Counts match the brief exactly.

`npx tsc --noEmit -p .` rc=0; `npm run build` rc=0.

## D-1 stale Teams verdicts re-judged within the cap, no loop -- CONFIRMED
Loop-3 probes re-pointed at this checkout (`v4/repro2.ts`, `v4/d1.ts`, `bun <probe>`):
```
repro2: last msg is owner's m2: true | settled true
        candidate after fix: {"status":"not_checked",...}  listed teams count: 0
d1:     judged before (v1 store): [ "owner@work.e" ]       <- email v1 current, Teams v1 not
        OUTAGE pass: calls 1 failures 1 alreadyJudged 1     <- nothing stored, retried next pass
        CAP=0 pass:  calls 0 overCap 1                      <- cap respected
        OK pass:     calls 1 open 1 alreadyJudged 1         <- only the Teams chat re-judged
        stored teams verdict inputVersion 2 status open
        2nd OK pass: calls 0 alreadyJudged 2                <- no re-judge loop
        verdictIsCurrent email undef: true | teams undef: false | teams 3: false | teams 2 wrong key: false
```
**Radius challenge: cap + #267 quota alert -> hidden forever? NO.** `actions.server.ts:131` only calls
`reportAiFailure` (a report; `ai-quota/hooks.ts` has no imports, suite G1) -- the quota alert never gates or pauses
a classify call. `pipeline.ts:166-182`: the attempt is recorded before the call and spends the cap; a model failure
`continue`s and stores nothing. So during an out-of-quota period a v1 Teams chat shows as "not checked yet"
(counted on the page), at most 6 attempts / 10 min = 36/h, and a 500 cap is exhausted after ~14 h; the cap resets
at the owner's local midnight and every pass retries. Rows return on the first successful pass after quota is
restored. Not forever; bounded by the outage. Residual LOW (same as loop 3): a day-long outage burns the cap.

## D-2 de-dup only same chat, or same sender + quote >= 40 -- CONFIRMED
`bun v4/d27.ts`:
```
D2a shared proposal, diff senders, diff chats -> both kept
D2b same sender, 28-char quote               -> both kept
D2c same sender, 70-char quote               -> newest only (c2)
D2d diff sender, same 70-char quote          -> both kept
D2e unknown (null) sender, same quote        -> both kept
DEDUP_MIN_QUOTE_CHARS = 40
```
INFO (not a defect): `collapseDuplicateTeamsItems` keeps a row only if it wins EVERY key, so with A(chat1,Q,t2),
B(chat2,Q,t1), C(chat1,other,t3) the result is only C -- B's chat disappears and Q shows nowhere (D2g). Reaching it
needs two CURRENT open candidates in one chat, which the per-chat key (`chat|latest message`) plus
`verdictIsCurrent` prevents, so not reachable from the pipeline as built.

## D-3 owner full names from config only, no one-word match -- CONFIRMED (one LOW nit)
```
D3a ownerNames ["Pat"], login boss@        -> []
D3b login pat.example@, names ["Pat","Example, Pat"] -> ["Example, Pat","Pat Example"]
D3c login pat.ex2@                         -> []
D3d name last resort, owner name "Pat", sender "Pat Other" -> []
D3e "Example, Pat" sender vs "Pat Example" -> ["s-pat"]
D3f "Pat Exampleson" vs "Pat Example"      -> []
```
`git show 30898bae -- src | grep '^+' | grep -ciE 'von|ellis|vonda|enterpriseds'` -> 2 lines, both COMMENTS in
`meeting-triage.ts` (lines 80 and 89 region: `"- Note: Von to send pricing"`). No identity in matching logic.
**LOW (D4-L1):** the owner's first name is quoted in two comments of a public repo; replace with "Pat".

## D-4 cross-chat id needs 2+ chats or a clear majority -- CONFIRMED
```
D4a one bad row in one chat            -> []
D4b same id on rows of 2 chats         -> ["u-own"]
D4c sole id, 2 rows in one chat        -> ["u-own"]   (clear majority)
D4d 2 vs 2 tie, one chat each          -> []
```

## D-5 cross-chat ids can only make a chat SHOW -- CONFIRMED
`bun v4/d5.ts` (`chatInvolvement`, group chat, rows `fromOwner:false`, `mentionedUserIds:[]`):
```
D5a no own id, no cross              -> hide false cant_tell_owner_unknown
D5b no own id, cross ids             -> hide false cant_tell_owner_unknown   (cross did not enable hiding)
D5c no own id, cross id is a sender  -> hide false owner_sent
D5d configured id, uninvolved        -> hide true  uninvolved
D5e configured id, cross id mentioned-> hide false owner_mentioned
```
Code: `report-from-ledger.ts` `ownIds` (configured + this chat) gates the hide; `ownerIds` (with cross) only feeds
the SHOW branches.

## D-6 to-do scrubbed of owner-state claims -- CONFIRMED
```
"You have not replied to Pat: send the deck" -> "Send the deck"
"You still need to resubmit the form"        -> "Resubmit the form"
"You still haven't replied"                  -> null
"Send the deck to Pat"                       -> unchanged
"You still owe Pat a reply - book the room"  -> "Book the room"
```

## D-7 labelled meeting line is a detail only if metadata or indented -- CONFIRMED
```
D7a "- Note: Pat to send pricing" (not indented)        -> ITEM
D7b "  - Note: background on pricing" (indented)        -> detail of the item above
D7c "Responsible person: Not stated." / "Timestamp: (..)"-> details
D7d "Responsible person: Pat to send the deck"          -> ITEM (action verb in value)
D7e "Deadline: Friday" with no item above               -> dropped, counted (detail:1)
D7f "Context: the client wants it soon" (not indented)  -> ITEM
```
INFO: D7f makes a junk row from a non-metadata label line. That is the stated trade-off ("never drop content").
