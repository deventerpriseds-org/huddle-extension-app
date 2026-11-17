# VERIFY actions-accuracy, loop 3

WHAT: independent verification of `claude_actions-accuracy` @ 7561f19a (loop-2 fixes D-1..D-7 + UI "More").
WHY: loop 2 returned FIX FIRST (VERIFY-actions-accuracy-2.md, e4588d3c).
SUPERSEDES: nothing (loop 2 stays as the record of the defects). SUPERSEDED-BY: nothing -- current.
EVIDENCE: commands + outputs inline below. Synthetic data only. Scratch: /tmp/claude-0/-home-user/ed70a92b-1b9b-5829-ab72-8eca54030362/scratchpad/l3/

Started 2026-11-17 05:45 UTC. Budget 40 min.

## C0 suites -- CONFIRMED
`bun scripts/<suite>.test.ts` for each, then `npx tsc --noEmit -p .`, `npx vite build` on 7561f19a:
```
actions-accuracy 55/0, actions-view 90/0, actions-view-server 28/0, report-from-ledger 103/0,
correspondence-ingest 186/0, meeting-triage 69/0, meeting-triage-sql 34/0, meeting-triage-server 7/0,
task-proposals 199/0, task-proposals-sql 45/0, needs-you 77/0, ai-quota-alert 50/0, ai-quota-alert-sql 12/0
tsc rc=0, build rc=0
```
Matches the builder's counts exactly.

## D-1 stale verdicts re-judged -- CONFIRMED (one residual risk, LOW, noted)
1. Loop-2 repro2 re-run (`l3/repro2.ts`, paths repointed to 7561f19a):
```
branch itemKey teams:19:a_b@...|...:m2 | last msg is owner's m2: true | settled true
candidate after fix: {"status":"not_checked","who":"Pat Example","title":"Pat Example","quote":null,"reason":null}
listed teams count: 0
```
The stale v1 Teams verdict (owner's own sentence judged as an ask) is no longer shown.
2. Probe `l3/d1.ts` -- runClassify with fake deps; store holds a v1 verdict for one email thread and one Teams chat:
```
judged before (v1 store): [ "owner@work.e" ]          <- email v1 still current; Teams v1 is not
OUTAGE pass (model throws): calls 1, failures 1, alreadyJudged 1, judged after 1   <- nothing stored, retried
candidates during outage: [ "email:open", "teams:not_checked" ]
CAP=0 pass: calls 0, overCap 1                          <- cap respected, no call
OK pass: calls 1, open 1, alreadyJudged 1               <- only the Teams chat re-judged; email NOT re-judged
stored teams verdict inputVersion 2 status open
2nd OK pass (loop check): calls 0, alreadyJudged 2      <- no re-judge loop
candidates after: [ "email:open", "teams:open" ]
verdictIsCurrent email undef: true | teams undef: false | teams 3: false | teams 2 wrong key: false
admit bad-shape / none / quote_not_found all carry inputVersion 2
```
3. Radius challenge -- outage / cap interaction (the brief's question). Read `actions.server.ts:141-200` and
`pipeline.ts:155-230`. A model failure stores nothing (retried next pass) but its attempt is recorded first and
spends the daily cap. Pass cadence `CLASSIFY_EVERY_MS = 10 min`, `CLASSIFY_PER_PASS = 6` -> at most 36 attempts/hour.
**Not hidden forever:** every pass retries, and the cap resets at the owner's local midnight. **Residual (LOW):**
during an OpenAI outage, Teams chats whose only verdict is v1 drop from listed to "N not checked yet" (the page
shows that count, `ActionsView.tsx:278-280`), and a full-day outage (~14 h at 36/h) can exhaust the 500 cap so they
stay unlisted until the next local day. Same exposure as any never-judged thread today; the version bump only
enlarges the set once (this week's Teams chats). No permanent loss, no loop.
