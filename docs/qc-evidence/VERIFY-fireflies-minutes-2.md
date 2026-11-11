<!--
WHAT:       Loop-2 independent verification of the Fireflies webhook -> meeting-minutes email feature (branch claude_fireflies-minutes @ f34bb1eb), claims C1-C14.
WHY:        Loop 1 returned FIX FIRST (D1-D6: crashed 'sending' row never sent, racing skip overwrote 'sending', settings load coupled to OneDrive, Graph error text leak, spoofable settings, time budget). This loop re-derives the fixed claims from the real code.
SUPERSEDES: docs/qc-evidence/VERIFY-fireflies-minutes-1.md (loop 1 verdict FIX FIRST)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; commands and outputs inline; branch claude_verify-fireflies-minutes-2
-->
# VERIFY fireflies-minutes, loop 2

Started 2026-11-11T04:22Z. Budget 30 min. Code under test: origin/claude_fireflies-minutes f34bb1eb.

## Method for C7 / C13: the branch's REAL SQL on a local PostgreSQL 16.15

A local PG16 cluster (127.0.0.1:55432, ssl=on) was started and `minutes-store.server.ts` was imported
verbatim with `AZURE_PG_URL` pointed at it (its own BOOTSTRAP_SQL created the tables). The worker's email
branch was simulated in the exact order `processMeeting` uses: plan from the CLAIMED row snapshot
(`planEmail`), then `recordEmailSent` / `recordEmailNotNeeded` / `recordEmailProblem`, `recordOneDrive`,
`releaseMeeting`. Time passing = `UPDATE ... SET next_attempt_at = now() - 1s`. Script:
`/tmp/claude-0/-home-user/ed70a92b-1b9b-5829-ab72-8eca54030362/scratchpad/v2/sql-seq.ts` (not committed).

Raw output:
```
S1 claim after 2 deliveries                              {"id":"m1","pe":true}
S1 plan                                                  "send"
S1 row after late retry                                  {"pe":false,"po":false,"es":"sent","n":1,"a":0,"err":null,"os":"saved","rp":null}
S1 late-retry claim                                      null
S1 total sends (want 1)                                  1
S2 parallel claims sizes (want 1+0)                      [1,0]
S3 re-claim while leased (want 0)                        0
S3 re-claim after lease expiry (want 1)                  1
S4 row right after mid-work resend                       {"pe":true,"po":true,"es":null,"n":0,"a":0,"err":null,"os":null,"rp":"200"}
S4 row after worker finished                             {"pe":false,"po":false,"es":"sent","n":1,"a":0,"err":null,"os":"saved","rp":"200"}
S4 re-claim for the resend (want 1)                      0
S5 claims before worker stops picking it up              12
S5 minutes of polling (claims*5)                         60
S5 final row (want es=failed at 3h)                      {"pe":true,"po":true,"es":null,"n":0,"a":12,"err":"waiting:fireflies_summary_missing","os":null,"rp":null}
S6 retry claim pe                                        true
S6 row                                                   {"pe":false,"po":true,"es":"sent","n":1,"a":2,"err":null,"os":null,"rp":null}
S7 same rp -> row                                        {"pe":false,"po":false,"es":"sent","n":1,"a":0,"err":null,"os":"saved","rp":"100"}
S7 older rp -> row                                       {"pe":false,"po":false,"es":"sent","n":1,"a":0,"err":null,"os":"saved","rp":"100"}
S7 newer rp -> row                                       {"pe":true,"po":true,"es":"sent","n":1,"a":0,"err":null,"os":"saved","rp":"300"}
S7 newer, upd OFF, changed hash plan                     "not_needed"
S7 newer, upd ON, changed hash plan                      "send_update"
S7 newer, upd ON, same hash plan                         "not_needed"
S7 sends (want 2: original + update)                     2
S8 transient-failure claims before abandon               12
S8 backoff minutes covered                               241
S8 final row                                             {"pe":true,"po":true,"es":null,"n":0,"a":12,"err":"graph_send_503","os":null,"rp":null}
```

## C7 idempotency -- REFUTED (new defect D7; loop-1 D1/D2 are FIXED)

Fixed and confirmed on real SQL: retry before and after send never double-sends (S1); two parallel heartbeats
lease one row once (S2, SKIP LOCKED); a crashed worker's row is re-claimed only after the 3-minute lease
lapses (S3) -- loop-1 D1 (crashed 'sending' row never sent) is obsolete, the 'sending' state is gone; D2
(racing skip overwrote 'sending') is obsolete for the same reason. Same/older reprocessed_at only bumps
the count (S7); newer queues work and the plan respects update-emails off/on and the content hash (S7).
Failed send then retry sends once (S6).

**D7 (lost update, real SQL S4).** A delivery that lands while a worker holds the lease is erased when the
worker finishes: `recordWebhook` sets `pending_email/pending_onedrive = true` (row shows pe/po true, rp 200),
then the worker -- which fetched the meeting BEFORE that delivery -- calls `recordEmailSent` (sets
`pending_email = false` unconditionally, minutes-store.server.ts:220) and `recordOneDrive` ok (sets
`pending_onedrive = false`, :259). Re-claim finds nothing (0). Consequence, concretely: the common order
`meeting.transcribed` -> worker running -> `meeting.summarized` arrives seconds later leaves the OneDrive file
WITHOUT the summary forever, and a reprocessed resend arriving mid-work is never update-emailed nor
re-saved, contradicting the recordWebhook comment "the file gains the summary once it exists". No duplicate
email results, so the owner's literal "no duplicate email" requirement holds; the defect is a lost update in
the same ledger. Residual (not counted): a worker killed between Graph send and `recordEmailSent` re-sends
after the lease lapses (at-least-once) -- acceptable, but see C11 on the 45s ceiling, which makes that kill
reachable.

## C13 Fireflies-summary wait up to 3h then fail visibly -- REFUTED (D8)

`emailBranch` waits while `age < SUMMARY_WAIT_MS (3h)` and re-polls every 300s (fireflies.server.ts:490),
but every claim increments `attempts` and `claimDueMeetings` excludes `attempts >= 12`
(minutes-store.server.ts:187, default maxAttempts=12). Real SQL S5: 12 claims = **60 minutes**, then the
row is never claimed again and stays `email_status NULL, pending_email true, email_error
'waiting:fireflies_summary_missing'` forever -- it never reaches the 3h decision and never becomes
`failed`. Only a later webhook (which resets attempts=0) rescues it; if `meeting.summarized` never comes
(summary generation off or failed), the meeting sits in "waiting" indefinitely. Same abandonment for
transient errors (S8: 12 attempts / ~241 min of backoff, then `es NULL`, `err graph_send_503`, never
`failed`). The "never emails empty or Luna-written minutes in Fireflies mode" half holds: `generateMinutes`
returns `fireflies_summary_missing` (no send) and has no Luna branch for source='fireflies'
(fireflies.server.ts:314-322).

## C12 suites + typecheck -- CONFIRMED (re-run by this verifier at f34bb1eb)

`bun scripts/fireflies-minutes.test.ts` 62 PASS / 0 FAIL ("all passed"); `cross-app-turn-gate` 92 passed 0 failed;
`scheduler-one-user` 7/0; `schedule-brief-dedupe` 21/0; `priority-check` 47/0; `npx tsc --noEmit -p .` rc=0, no
output. Note: none of these suites caught D7 or D8. The suites test `planEmail` and similar pure functions;
they do not run the queue SQL.

## Reduced-depth re-checks (code read at f34bb1eb)

- **C3 CONFIRMED.** `emailBranch` calls `loadMinutesSettings(owner)` on every pass (fireflies.server.ts:393).
  `parseMinutesSource` returns 'luna' only for exactly "luna" and the Fireflies default for anything else
  (minutes.ts:24-26).
- **C4 CONFIRMED.** `generateMinutes` (fireflies.server.ts:309-340): the fireflies branch returns either a
  summary or `fireflies_summary_missing`. The luna branch returns Luna output or an error. Neither branch
  falls back to the other mode.
- **C8 CONFIRMED (loop-1 D3 fixed).** Settings load only inside `emailBranch`. Email and OneDrive run under
  `Promise.allSettled` (:464), and a rejection in one branch is recorded separately (:475-485).
- **C2 CONFIRMED, with one small caveat.** `safeMeetingId` returns null outside `^[A-Za-z0-9_-]{1,120}$`
  (minutes.ts:355-358), and the webhook throws `invalid_meeting_id` (:532-533). Caveat: it calls `.trim()`
  first, so `" abc "` is accepted as `abc`. The id is otherwise unchanged, so this is harmless.

## NOT REACHED (budget)

C1 signature (I read the header parse and the HMAC computation, but not the comparison), C5 custom sections,
C6 Luna template, C9 (I read `safeSendError`, which returns only short codes, but did NOT check the Entra ID
token check or that a non-owner token is refused), C10 (I confirmed the subject includes title and date,
but did not grep for hard-coded addresses or PDF), C11 time budget, C14 scheduler, and the re-run of the
loop-1 adversarial test `scripts/fireflies-minutes.verify.test.ts`.
Flagged for C11, inference only and not measured: the worker's email path can take one Fireflies fetch
(<=12s), plus the schema-retry fetch (<=12s), plus Luna (<=25s), plus the send, which is more than 45s.
If the heartbeat request is killed at the hosting ceiling after the Graph send but before
`recordEmailSent`, the email is sent again once the lease lapses.

## Verdict

C7 REFUTED (D7 lost update), C13 REFUTED (D8 abandoned after 12 attempts / 60 min, never `failed`).
C2, C3, C4, C8, C12 CONFIRMED. C1, C5, C6, C9, C10, C11, C14 NOT REACHED. Verdict: **FIX FIRST**.
Per the coordinator, PR #191 is already merged and deploying, so D7 and D8 become a follow-up fix PR.
