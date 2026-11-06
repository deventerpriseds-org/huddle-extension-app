# VERIFY second-mailbox-trinnex — loop 3, lane 3a
# WHAT:       Independent verification of C1, C2, C6, C7 and fix items F-hang, F-reply, F-main, F-self, F-sub
# WHY:        Loop 2 (2a/2c) refuted the hang, reply, main-failure, self-mail and subscription paths; fixes landed in a62e6db8 + a71382ed
# SUPERSEDES: nothing (loop 2 lanes 2a/2c are the predecessors for these claims)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   head origin/claude/cool-cannon-q4puke c5a38800; diff 48c34655..c5a38800 -- src scripts

## Findings (appended per claim)

Run at 2026-11-06 ~15:17-15:25 UTC on c5a38800 (worktree branch claude_verify-second-mailbox-3a).
Suites re-run by this verifier: second-mailbox 27 PASS/0 FAIL rc=0; inbound-email 69 PASS rc=0;
mail-subscription 24 PASS rc=0; schedule-brief 76 passed 0 failed rc=0; `npx tsc --noEmit -p .` rc=0.
Independent probe: scratchpad hang-probe.ts (fetch stub: main=/users/von.ellis%40enterpriseds.io, extra=/me/).

| claim | verdict | evidence |
|---|---|---|
| C1 one mailbox today | CONFIRMED | calendar-mailbox.ts:55-56 unchanged since 48c34655 (no diff); A8 PASS; with mailboxes=[main] every loop over extras is empty; draft path calls findReplyOriginal(main)+createFormattedReplyDraft(base,token) = same /users/{mb} URL + app token as old createReplyDraftInMailbox; subscription guard isAppKeyMailbox(von.ellis@enterpriseds.io)=true -> unchanged. Order-dependence for two EnterpriseDS rows is identical to origin/main (first matching row). |
| C2 non-EDS never main | CONFIRMED | calendar-mailbox.ts:55 main = first app-key row; A1, A4 PASS |
| C6 extra error/hang cannot break or delay main; failed main never ok | PARTIAL: "break" CONFIRMED, "delay" REFUTED (bounded), "never ok" CONFIRMED for calendar/search/watch | probe: extra that rejects at 9.5s -> CAL ms=8037 ok:true main event; SEARCH ms=8035 ok:true; DRAFT ms=8003 reply in main; extra that NEVER settles -> CAL ms=8002 ok:true. UNHANDLED_COUNT 0 after 11s wait. Main's reply is delayed by up to 8s PER extra (sequential awaits). G1 PASS (main fails -> ok:false). |
| C7 reply lands where email arrived | CONFIRMED | probe: subject in extra (older) vs newer main mail -> POST /me/messages/orig-x/createReply, from=von@trinnex.io; no subject -> newest (main) -> POST /users/von.ellis%40.../orig-main/createReply. Button: email-replies.functions.ts:66-71 uses row.mailbox, written per message at inbound-email.server.ts:184 (msgMailbox). |
| F-hang | CONFIRMED for the 5 named sites; DEFECT outside radius (D1) | graph-email.server.ts withExtraMailboxTimeout, `call.catch(()=>onTimeout)` -> no unhandled rejection (observed 0) |
| F-reply | CONFIRMED | see C7 |
| F-main | CONFIRMED | getOwnerCalendarEvents `if (!first.ok) return first`; search `if (!first.ok) return {...first}`; watch `ok: read.ok` + `error` -> route returns 500 (run-inbound-email.ts:72) while extras still delivered |
| F-self | CONFIRMED by code read + tsc; cross-mailbox branch UNTESTED | inbound-email.server.ts fromSelf over all mailboxes; single-mailbox verdict identical to screenMessage:121. No test exercises mail FROM trinnex address landing in main. |
| F-sub | CONFIRMED | inbound-email.server.ts `!opts.dryRun && isAppKeyMailbox(mailbox)`; mail-subscription.test.ts:128 structural PASS |

## Defects
D1 (MEDIUM, observed) reconcileRepliedFromSentItems (email-replies.server.ts:243-262) runs BEFORE the main inbox read
(inbound-email.server.ts:91) and calls hasSentReplyInConversation(row.mailbox, ..., row.owner_email)
(graph-email.server.ts:547) for every owed row, including Trinnex rows, with NO time limit. Probe: with the
extra mailbox hanging, hasSentReplyInConversation("von@trinnex.io",...) was STILL PENDING after 12000ms.
So one owed Trinnex email + a hanging Trinnex Graph/journey call stalls the whole watch (cron and instant
webhook path) -> main mailbox alerts delayed indefinitely. This is exactly F-hang's class, outside the claimed radius.
D2 (LOW, observed) C6 "cannot delay" is false as stated: each extra adds up to 8s, sequentially, to the main
calendar/search/draft/brief answer (probe ms=8002-8037). When main has already FAILED, extras are still awaited before the error returns.
D3 (LOW, inferred from code) read_email by id (graph-email.server.ts:1148-1157) loops mailboxes with no time
limit; if main read errors, a hanging extra hangs the tool call.
D4 (LOW, observed) F-self cross-mailbox case has no test (inbound-email.test.ts:93-142 only single-mailbox screenMessage).
Note: origin/main is 2 commits past the merge base (#151, #152); merge main before landing.
