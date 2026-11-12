<!--
WHAT:       Loop-3 independent verification of the Fireflies -> Huddle meeting-minutes feature (claims C1-C14) on origin/main b217d0f6.
WHY:        Loop 2 returned FIX FIRST with D7 (mid-lease delivery wiped) and D8 (summary polls exhausted attempts); PR #195 claims to fix both. Loop 2 also left C1, C5, C6, C9, C10, C11, C14 NOT REACHED.
SUPERSEDES: docs/qc-evidence/VERIFY-fireflies-minutes-2.md (loop 2: FIX FIRST, D7 D8)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; branch claude_verify-fireflies-minutes-3; suites re-run in this session.
-->
# VERIFY fireflies-minutes, loop 3

Code under test: origin/main b217d0f6. Started 05:48 UTC, budget 30 min.

## Suites re-run (this session, origin/main b217d0f6)
- `bun scripts/fireflies-minutes.test.ts` -> 62 PASS, 0 FAIL
- `bun scripts/fireflies-queue-sql.test.ts` (real SQL, local PG16) -> 11 PASS
- `bun scripts/cross-app-turn-gate.test.ts` -> 92 passed, 0 failed
- `bun scripts/scheduler-one-user.test.ts` -> 7 passed, 0 failed
- `npx tsc --noEmit -p .` -> no output (0 errors)
- NEW `bun scripts/verify3-ffq-extra.test.ts` (real SQL) -> X1-X5 5 PASS
- NEW `bun scripts/verify3-pure.test.ts` -> 23 PASS

## Verdicts
| # | Claim | Verdict | Evidence |
|---|---|---|---|
| C1 | V2 signature, constant-time | CONFIRMED | Docs (run 42816565367 log): header X-Hub-Signature, `sha256=<hex>` of raw body, timing-safe compare. minutes.ts:59-79 regex-gates 64 hex, XOR-accumulates all 32 bytes (no early exit). Route passes `request.text()` untouched, 16 KiB cap. verify3-pure: 10 signature probes PASS (bare hex, sha1=, truncated, 1-nibble, tampered, empty secret all refused; utf8 body accepted). |
| C2 | strict meeting id | CONFIRMED (re-check) | minutes.ts:355 reject-not-clean; probes PASS. |
| C3 | settings read per pass, default Fireflies | CONFIRMED (re-check) | fireflies.server.ts:394 loadMinutesSettings inside emailBranch; parseMinutesSource -> 'fireflies' unless 'luna'. |
| C4 | no cross-mode fallback | CONFIRMED (re-check) | generateMinutes: fireflies branch returns before any Luna call; luna branch never reads summary. |
| C5 | custom sections preferred, never falsely claimed | CONFIRMED | extended_sections with content -> kind custom; else standard + STANDARD_SUMMARY_NOTICE + "Minutes from the Fireflies summary." Docs: extended_sections = "sections ... included by customizing the summary from the dashboard". Observation: docs also list `apps_preview.outputs` (AI-app output); code does not read it - if the owner's "custom output" is an AI app rather than a dashboard summary customisation, it is reported as standard (honest, not false). Risk not tested: if a standard summary exists at meeting.transcribed time before extended_sections are generated, standard minutes go out and the later custom version is not emailed unless update emails are on. |
| C6 | Luna template vs handoff | CONFIRMED | MINUTES_INSTRUCTIONS (minutes.ts:180-207) covers every handoff bullet lines 44-74 (5 sections, action-language agenda headings, one plain opening sentence, 2-3 `###` sections, <250 words, <=4 bullets, no LaTeX, bold rule, nested answers, Next 2 weeks/Beyond, ownership gaps). missingTemplateSections rejects a reply missing a section (probe PASS). |
| C7 | D7 mid-lease delivery kept | CONFIRMED | Every flag clear is `CASE WHEN queue_version = claimed`; releaseMeeting makes a moved version due now. Author Q4 + new X1 (failed pass + mid-lease delivery: attempts 0, due now, no give-up) + X5 (final problem with moved version stays pending) PASS on real SQL. |
| C8 | email / OneDrive independent | CONFIRMED (re-check) | Promise.allSettled, each branch records its own result. |
| C9 | short error codes + Entra token check | CONFIRMED (code) / panel UI-UNVERIFIED | errCode regex, safeSendError never returns Graph text; route 503 code regex-gated. authorisedOwner: verifyEntraIdToken pins issuer to ENTRA_TENANT_ID + audience=clientId; non-owner -> null -> refused. Panel calls getToken() and sends idToken (MeetingMinutesPanel.tsx:56,83), same pattern as HuddleView.tsx:339. Not run in a browser. |
| C10 | recipients configurable, no literals, subject, no PDF | CONFIRMED | No address literal in minutes.ts/panel (only placeholder name@example.com); subject = title + date; no attachment field; escape-first HTML (probe PASS). Note: default = owner's AUTO-tier linked addresses, so the second handoff address is a default only if the gate auto-sends to it (DB, not checked). |
| C11 | one pass under ~45s | REFUTED | See D9 below. |
| C12 | suites + typecheck | CONFIRMED | above. |
| C13 | D8 attempts = failed passes; visible give-up | CONFIRMED, with D9 side effect | Author Q5/Q6 + X2 (delivery between release and giveUp: no give-up, attempts reset) + X3 (delivery after give-up revives) PASS. |
| C14 | scheduler change cannot delay/reorder/break jobs | CONFIRMED | diff 33f625e3..origin/main of scheduler.server.ts: only adds a started-early promise (caught) and two `await fireflies` after existing work. run-turn.ts runs drain/reminders/jobs in Promise.all, so the pass extends the response only, never the start of other work. |

### D9 (C11) - worst-case pass exceeds the ceiling, and a pass that dies is never counted
Bounded steps on the Luna path, in sequence: Fireflies query 12s + schema-retry query 12s (fireflies.server.ts:200,230) + Luna 25s (:346) = 49s, before three calls that have NO timeout: getAppToken (graph-email.server.ts:124), sendMail (:770), and the DB settings read. OneDrive branch (parallel): up to 4 folder calls x 10s + PUT 15s = 55s after the fetch -> 79s bounded. The comment at :346 ("fetch(<=12s) + Luna(<=25s) stays under ~45s") omits the retry query and the send.
Consequence, proven on real SQL (X4): claimDueMeetings does not count attempts and a killed pass never reaches releaseMeeting, so 30 killed passes leave attempts=0 and the row claimable every 3 minutes forever - the D8 cap does not apply. Failing scenario: Fireflies answers in ~11s and Luna in ~24s on each pass; the host stops the invocation at ~45s during sendMail/recordEmailSent; every 3 minutes the same meeting is re-worked, no final failure is ever recorded, and a kill landing after Graph's 202 but before recordEmailSent sends the same minutes again.
Realistic path today (live API accepts extended_sections, so no retry query): 12 + 25 + token + send ~ 37-40s - inside the ceiling unless Graph is slow. Severity: medium (rare, unbounded when it happens).
