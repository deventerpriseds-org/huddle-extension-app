# VERIFY-deep-ask-hybrid-3

<!--
WHAT:       Independent verification (loop 3) of a7c5df7, diffed against 74883ca (loop 2's subject).
WHY:        Loop 2 (VERIFY-deep-ask-hybrid-2.md) refuted AC9 (produce wrote the board with journey off) and
            found AC4 misses; a7c5df7 claims fixes for both plus a fail-safe tier pin in the gate's catch.
SUPERSEDES: nothing (loop 2 file stays on claude_verify-deep-ask-hybrid-2)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; commands run against detached a7c5df7 in a fresh clone. No DB/service touched,
            live QA script NOT run.
-->

Diff 74883ca..a7c5df7: 4 files (qa-produce-quick.mjs, scripts/ask-shape.test.ts, huddle.functions.ts,
tasks/ask-shape.ts). deep-confirm.server.ts, routing.ts, model-policy.ts, green-light.ts: `git diff --stat` empty.

## Suite (observed at a7c5df7)
- `npx tsc --noEmit -p .` -> tsc_exit=0
- `bun scripts/ask-shape.test.ts` -> exit 0, "ALL PASS" (69 PASS lines, 0 FAIL)
- `bun scripts/verdict-memory.test.ts` -> exit 0, "ALL PASS"
- `bun scripts/green-light.test.ts` -> exit 0, "ALL PASS"
- `bun scripts/router-winners.test.ts` -> exit 0, "20 passed, 0 failed"

## AC9 -- produce honours journey:{enabled:false}: CONFIRMED (for an explicit false), with one semantic caveat
Every side effect runProduce (huddle.functions.ts:1608-1680) can cause, traced:
| effect | line | gated |
|---|---|---|
| quick_create_task (journey board write) | 1617-1625 | `journeyOn && data.caller?.entra_email` |
| journeyTaskUpdates.push (board card in response) | 1626 | inside same branch |
| assignCreatedJourneyTasks (journey row update) | 1634-1644 | inside same branch, and `r.ok` |
| runScheduledAutoWork({force:true}) | 1652-1659 | `if (journeyOn)` |
| finalize -> turnStore.saveTurnChunk | 1267-1279 | not gated; chat.pending_turns transcript only, not the board |
- `journeyOn = data.agents?.[agentId]?.journey?.enabled !== false` (:1614). `agentId` is pending.agentId; the
  harness builds `agents[id]` for every member with `journey:{enabled:false}` (qa-produce-quick.mjs:44-46), so
  the lookup hits and journeyOn=false -> no board write, no assign, no auto-work kick. `created` stays false.
- Outside runProduce but on the accept path: recordDeepConfirmVerdict (:1688) writes chat.deep_confirm (Huddle
  DB, not the board). Not gated by journey; not a board write.
- Harness/code agreement: Case 2 asserts `/couldn't confirm the board write/i` (qa-produce-quick.mjs:95); the
  created=false text at :1670 contains `couldn't confirm the board write` (ASCII apostrophe, grep count 1).
  Every send() goes through the same `agents` builder with journey disabled (:44-50). Case 4 text now Test- prefixed.
- CAVEAT (semantic mismatch, not a refutation of AC9 as worded): every OTHER board-write site is OPT-IN --
  `agentBackend.journey?.enabled && ...` (:2887, :3099, :3434, :6174; :909 also truthy). runProduce is OPT-OUT
  (`!== false`). So a turn whose `agents` map omits the agent or omits `journey` gets NO board write anywhere
  else but DOES get the produce board write + forced auto-work. The comment "like every other board write"
  (:1611) is therefore inaccurate. Probably preserves prod behaviour, but a harness that omits `agents`
  entirely would still write the real board on "produce". Owner/author call.

## AC4 -- widened OFFER_ACCEPT: CONFIRMED (0 real false accepts), near-miss rule has a realistic misfire (see below)
Probe (bun, probe.ts importing hx/src/features/huddle/lib/tasks/ask-shape.ts), observed:
- Loop 2's 40 non-acceptances: 40/40 false. Summary line: `non40=40 falseAccepts=0`.
- 25 plausible acceptances (loop 2's 18 accepted + its 13 misses, incl. "yes — produce", "go ahead and produce it",
  "let's produce it", "produce pls", "produce 👍", "produce it now", "**produce**"): 25/25 true (`misses=0`).
- 15 NEW adversarial aimed at the lead-ins: "please don't produce", "sure, produce the report on finance instead",
  "let's produce a new budget", "please produce nothing", "let's not produce it", "go ahead and don't produce",
  "sure sure no", "please, no full version", "yes yes produce later", "let's make it a task for tomorrow",
  "go ahead and put it on the board for tess", "please produce it for finn instead", "ok ok produce it next week",
  "sure — produce? no" -> all false. "let's produce" -> TRUE; I listed it as adversarial but on reflection it IS
  an acceptance ("let's produce [it]"), so it is my mislabel, not a defect.
- Other observed: "yes yes yes produce", "let's let's produce" -> true (the lead-in group is `(...)*`, repeatable;
  harmless). "produce it then"/"produce it too"/"produce, not now" -> false.
- "yes please" still false (by design, loop 2).

### Near-miss rule (mentionsProduceOffer keeps the offer) -- REALISTIC WRONG-PRODUCE PATH FOUND
- :1694 `if (!mentionsProduceOffer(data.text)) await clearPendingDeepConfirm(...)`; mentionsProduceOffer is
  `/\bproduce\b|\bfull version\b/` on the normalised text (ask-shape.ts). Observed true for:
  "no, produce nothing — I just wanted the summary" (an explicit DECLINE, QA Case 4's text),
  "what produce is in season right now?", "Which local farms produce the most organic eggs near me".
- Path (code-read; each step a cited line): (1) deep deliverable ask A -> offer row for A (:1749-1752, :6898).
  (2) user declines: "no, produce nothing — I just wanted the summary" -> not accepted (:1687), but mentions
  produce -> offer KEPT (:1694); turn routes normally. (3) agent's reply to that turn offers something else, e.g.
  "Want me to put the summary on the board?" (inference, not exercised: agents offering board tasks is plausible
  given create_huddle_task exists). (4) user: "yes, put it on the board" (isOfferAccepted -> true, observed; "make
  it a task" also true) within 30 min of A's createdAt -> runProduce(agentId, A.askText) (:1690):
  a produce task for the ask the user just DECLINED, plus a forced auto-work kick when journey is on.
- Same shape with a topical message ("what produce is in season?") between the offer and an unrelated "make it a task".
- Before a7c5df7 step (2) cleared the offer, so this path did not exist. Severity: one unwanted board task,
  recoverable; but a decline keeping an offer alive inverts the user's stated intent. A negation check
  (isNegatedOrAsked) before keeping would close the decline variant; the topical variant needs a narrower match.

## Fail-safe tier pin in the gate's catch: CONFIRMED
- :1759-1770. `askShape` is a function-scope `let` at :1235 (assigned :1246), `routed` and `deepManual` are
  declared before the try (:1594 for deepManual) -> both in scope; tsc exit 0.
- No double-apply: guarded by `!deepManual`. Every path in the try that sets deepManual (:1702 legacy quick,
  :1748/:1750 fresh ask) has no awaited throwable after it within the try (fresh-ask block :1744-1758 is sync;
  legacy quick's recordDeepConfirmVerdict is after the assignment, so a throw there leaves deepManual set and the
  catch skips). `return runProduce(...)` is not awaited, so a runProduce rejection propagates rather than
  reaching this catch.
- Structural test present and passing: ask-shape.test.ts "a failed gate still pins the tier".
- Note: catch path sets no offer (no email) -- documented at :1765.

## Reduced-depth re-checks (all unchanged or still hold at a7c5df7)
- AC1 act -> budget: CONFIRMED. :1747-1748 `route === "act-now"` -> `deepManual = "budget"`; model-policy.ts:209
  manual "budget" -> Terra/high before any ceiling. model-policy.ts unchanged in diff.
- AC2 deliverable -> terra-med + offer, row only if appended: CONFIRMED. :1749-1752; :6894-6898 `if (!out.appended) return;`
  precedes setPendingDeepConfirm.
- AC3 no fresh ask to runProduce: CONFIRMED. runProduce call sites only :1690 (offer accepted) and :1715 (legacy produce);
  structural test "no fresh ask is diverted to runProduce" passes.
- AC5 legacy 'ask' rows: CONFIRMED. :1695-1735 unchanged branch; deep-confirm.server.ts and green-light.ts not in diff.
- AC6 `kind` column: CONFIRMED. deep-confirm.server.ts:51 `ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ask'`; file unchanged.
- AC7 offer before save/return: CONFIRMED. :7141 before saveTurnChunk :7143; :7153 before `return finalResult()`.
- AC8 scorer + strict schema: CONFIRMED. scoreAskLLM sole call :1239; routing.ts unchanged in diff.
- "(you chose this)": CONFIRMED. :4767 keys on `data.modelEscalate?.trim()`.

## Radius challenge
- The opt-in/opt-out journey mismatch above sits in runProduce but touches the semantics of every board-write
  site (:2887 etc.), outside the stated radius.
- mentionsProduceOffer interacts with AC3/AC9 (it lengthens the window in which runProduce can fire on an old ask).
