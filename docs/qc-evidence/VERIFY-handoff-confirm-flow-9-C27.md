<!--
WHAT:       Loop-9 independent verification of claims C2 (askIsUrgentNow urgency) and C7 (board-claim honesty) for handoff-confirm-flow
WHY:        Loop 8 REFUTED both (origin/claude_verify-handoff-confirm-flow-8-c2 / -8-c7); fix 0ea0a387 claims to close them
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   probes in docs/qc-evidence/probe-9-c27-*.ts on this branch; tested HEAD e45abd80
-->
# VERIFY handoff-confirm-flow loop 9 -- C2, C7
Tested HEAD: e45abd80 (origin/claude/modest-brown-2hdt5n)
Status: see end

## Prior probes re-run at e45abd80 (bun docs/qc-evidence/verify-handoff-confirm-flow-{7,8}-c{2,7}-probe.ts)
- 7-c2: unsafe=0 over=5 (known safe-direction overs). 8-c2: unsafe=0 over=1 ("Never mind the details, just do it now" -> default, safe).
- 7-c7: misses=1 (M7-7 "It's now in Done." passive, by design). 8-c7: unsafe=0 misses=1 (M8-5 "Marked it as done for you.").
- Loop-8 UNSAFE rows U8-1..U8-5 now KEPT (fixed).

## C2 -- REFUTED (26 UNSAFE), probe docs/qc-evidence/probe-9-c27-c2.ts
Every row below returns classifyAsk(text).urgency === "now" while the message defers, gates, retracts or quotes:
| group | input (got=now, UNSAFE) |
|---|---|
| condition gate | "If Sam agrees, do it now." / "Assuming the budget clears, book it asap." / "Provided it's under $500, book it right away." |
| event wait | "Send it right away — the moment Sam replies." |
| time (unlisted) | "Do it now. Actually, in two hours." / "...in a few hours." / "...EOD is fine." / "...2moro." / "Do it now. Mañana." / "Do it now. In the AM." |
| take-back (unlisted) | "Do it now. On second thought, hmm." / "Belay that." / "Disregard." / "Strike that." / "Psych!" / "Haha just messing with you" |
| negation (unlisted) | "Do it now? Nooo." / "Do it now? Na." / "Do it now? Hard pass." |
| quote chars NOT in /["“”«»]/ | "Sam: „book it asap‟" / "Sam: 「book it asap」" / "Sam: ‹book it asap›" / "Sam: ″book it asap″" -- the fix's "any quote character means not now" is false for these |
| unmarked reported speech | "Finn's note says, book it asap. Thoughts?" |
| question | "Do you think I should do it now?" (type quick-verbal) / "Check whether we should do it now" |
Correctly default: "As soon as Sam replies, send it right away." (vetoed by the listed word "soon"), "Do it now /s", "Sam said: book it asap. I think it can wait a bit" (vetoed by "wait").
Consumers reached by these inputs (observed): huddle.functions.ts:2077 (`urgency !== "now"` gate), :7413 (followupMode now vs confirm), capabilities.ts:280.
Root cause (observed, capabilities.ts:228-241): urgency is decided by a closed allowlist of "now" clauses, but the vetoes are an OPEN denylist of words; any
retraction/condition/time phrase not on the list leaves the "do it now" clause intact. Same shape as loops 1-8.

## C7 -- REFUTED (1 solid UNSAFE + 1 weak), probe docs/qc-evidence/probe-9-c27-c7.ts
| row | real summary (huddle.functions.ts) | reply | got |
|---|---|---|---|
| U9-1 UNSAFE | flag_blocker ok, `blocked: ${reason.slice(0,50)}` (:4287, recorded only AFTER board BLOCKED set :4267), reason "Vendor import keeps reporting skipped duplicate" | "I've marked it blocked." | rewritten to "Nothing was changed on the board for that." |
| U9-3 UNSAFE (weak: delegation may not itself change the board) | delegate_to_specialist ok, `tasked Researcher: work out why the importer skipped duplicate` (:2576-2581) | "I've moved it to In progress." | rewritten |
Root cause: board-claims.ts huddleToolChangedTask `if (/skipped duplicate$/i.test(u.summary)) return false;` still scans the WHOLE summary, whose tail is
agent free text (block reason, delegation objective) -- the exact loop-8 class ("never by scanning the summary's free text"). The real dup summaries are
"already confirmed this turn — skipped duplicate" / "already delegated <role> this turn — skipped duplicate"; anchoring on those would close it.
Kept correctly: U9-2 (60-char slice leaves trailing space), U9-4 plain block, U9-5 reason "Huddle-only mode, journey disabled".
Misses (safe direction, false claim kept): M9-1 create_artifact `saved "X" · saved, but held out of review — confirm intent...` (:4183-4185) still backs
"I saved it and moved it to review." though the task was NOT flipped; M9-2 confirm_task_intent "DoD confirmed" (sets DoD only) backs "I've moved it to Doing."

## Suite re-run at e45abd80 (observed)
tsc --noEmit rc=0; handoff-lane-a 204 pass/0 fail; lane-b 7/0; board-claims 79/0; not-ai-task 6/0; one-request-one-task 40/0; mode 70/70; router 39/0.
Matches the implementer's counts. The suites are green over every UNSAFE row above (none of them is in a suite).

## Mutations (scripts via /usr/local/bin/mutate.sh; anchors in docs/qc-evidence/mut9/)
- C2: drop `"scratch that", ` from DEFERRAL_RE in capabilities.ts; test `v8-U: "Do it now. Scratch that." -> default` -> FIRED (control EQUIVALENT), exit 0.
- C7: confirm_task_intent branch -> `return true`; test `a skipped-duplicate or failed-journey confirm does not back a claim` -> FIRED (control EQUIVALENT), exit 0.
Both new guards are real; they protect only the enumerated rows.

## Verdict
| claim | verdict | concrete failing input |
|---|---|---|
| C2 urgency | REFUTED (26 UNSAFE) | "If Sam agrees, do it now." / "Do it now. Mañana." / "Sam: „book it asap‟" -> urgency "now" |
| C7 board-claim honesty | REFUTED (1 UNSAFE, 1 weak UNSAFE, 2 safe misses) | flag_blocker ok `blocked: Vendor import keeps reporting skipped duplicate` + "I've marked it blocked." -> rewritten to "Nothing was changed on the board for that." |

Status: COMPLETE
LOOP-9-C27-COMPLETE
