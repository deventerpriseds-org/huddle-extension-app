# VERIFY deep-ask-hybrid, loop 4
# WHAT:       independent verification of 8e9bccd (fixes from loop 3) against a7c5df7
# WHY:        loop 3 REFUTED the near-miss rule and flagged runProduce's opt-out journey check
# SUPERSEDES: nothing (loop 3 report on origin/claude_verify-deep-ask-hybrid-3 remains the record for a7c5df7)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   commands + observed output below; probe at scratchpad probe.ts (not committed)

Checked out: `git checkout --detach 8e9bccd`. Diff vs a7c5df7: 3 files (huddle.functions.ts +9/-9,
ask-shape.ts -9, scripts/ask-shape.test.ts +2/-5). No other src/ file changed.

## Suite (full re-run, observed)
- `npx tsc --noEmit -p .` -> TSC_EXIT=0
- `bun scripts/ask-shape.test.ts` -> ALL PASS, exit 0 (incl. new "any non-acceptance retires the offer",
  updated "produce honours the journey toggle")
- `bun scripts/verdict-memory.test.ts` -> ALL PASS, exit 0
- `bun scripts/green-light.test.ts` -> ALL PASS, exit 0
- `bun scripts/router-winners.test.ts` -> 20 passed, 0 failed, exit 0

## (a) Near-miss rule removed: CONFIRMED
- `grep -rn mentionsProduceOffer src scripts` -> no matches (rc=1). Export gone from ask-shape.ts; import gone
  from huddle.functions.ts; the two test checks are removed.
- huddle.functions.ts:1682-1694: in the `kind === "offer"` branch, an accepted reply (inside TTL) returns
  runProduce at :1689. Any other reply reaches the unconditional `await clearPendingDeepConfirm(email, data.huddleId)`
  at :1694. clearPendingDeepConfirm (deep-confirm.server.ts:111-124) is a DELETE of the row.
- Loop 3's path, re-run through a state machine that mirrors :1682-1694 and calls the real exported
  isOfferAccepted (observed):
  - offer A -> "no, produce nothing — I just wanted the summary" -> step1 produced=null, rowAfter1=null ->
    "yes, put it on the board" -> step2 produced=null
  - same decline -> "make it a task" -> produced=null
  - "what produce is in season right now?" -> "make it a task" -> produced=null
- With the row deleted, getPendingDeepConfirm returns null on the next turn, so neither branch fires.
  runProduce has exactly 2 call sites (:1689 offer accepted, :1715 legacy `ask` row produce). The legacy one
  needs a kind='ask' row, and the offer path never writes one (setPendingDeepConfirm(..., "offer") at :6898).
- MUTATION (sed, then `git checkout` restore, tree clean after): changing :1694 to
  `if (!/produce/.test(data.text)) await clearPendingDeepConfirm(...)` -> ask-shape.test FAIL
  "any non-acceptance retires the offer" (1 FAILED). FIRED.
- Residuals (not refutations):
  1. A known trade-off of the fix: "produce it tomorrow?" -> "produce" now produces nothing (observed:
     step2 produced=null). The near-miss case from loop 2 AC4 comes back on purpose. The safe direction is
     a lost offer, never a wrong produce.
  2. Inference, not exercised: clearPendingDeepConfirm swallows errors (`catch { /* best-effort */ }`). If
     the DELETE fails, the offer survives, and a later acceptance phrase within OFFER_TTL_MS (30 min) would
     still produce the declined ask. This only happens on a DB error.

## (b) runProduce is opt-in: CONFIRMED
- :1613 `const journeyOn = data.agents?.[agentId]?.journey?.enabled === true;`. quick_create_task plus
  assignCreatedJourneyTasks sit inside `if (journeyOn && data.caller?.entra_email)` (:1616-1645), and
  runScheduledAutoWork sits inside `if (journeyOn)` (:1652-1659). These are the only three side effects.
- Predicate truth table (observed, same expression): agents absent=false, agent absent=false,
  journey absent=false, enabled:false=false, enabled:true=true.
- This matches the other board-write sites: `agentBackend = agentsCfg[nextId] ?? { backend: "lovable" }` (:2175),
  and the gates `agentBackend.journey?.enabled` (:2887, :3099, :3434, :6174) are also falsy when absent.
  Loop 3's opt-in/opt-out caveat is CLOSED.
- Real users keep the write: HuddleView.tsx:1638 sends `agents: backendsCfg.agents`. defaultAgents()
  (agent-backends.ts:143-170) sets `journey: { enabled: true }` for every agent, and the persist merge
  (agent-backends.ts:250-268) keeps the persisted value and forces `{enabled:true}` on the v<3 migration. So
  a real client turn sends enabled:true unless the user toggled journey off for that agent in
  AgentSettingsDrawer (:304/:436). That is the same rule as every other board write.
- MUTATION: reverting :1613 to `!== false` -> ask-shape.test FAIL "produce honours the journey toggle" (1 FAILED). FIRED.

## Reduced-depth re-checks at 8e9bccd (each still holds)
- AC1 act -> budget: :1747-1748 `if (route === "act-now") { deepManual = "budget";`; model-policy.ts:209
  manual budget -> Terra/high. model-policy.ts not in diff. CONFIRMED.
- AC2 deliverable -> terra-med + offer, with a row only if appended: :1750-1752; :6895 `if (!out.appended) return;`
  comes before setPendingDeepConfirm at :6898. CONFIRMED.
- AC3 no fresh ask to runProduce: only call sites are :1689 and :1715; the structural test passes. CONFIRMED.
- AC4 whole-reply acceptance via the exported isOfferAccepted (observed): 43 non-acceptances (the test's 25
  plus loop 3's 15 adversarial plus 3 more) -> falseAccepts=0. 23 acceptances -> misses=0. Note: the probe
  rebuilt the 40/25 sets from the test file and loop 3's report, since loop 3's exact probe file was not
  committed. CONFIRMED.
- AC5 legacy rows: the `else if (pending)` branch (:1695-1735) is unchanged in the diff. CONFIRMED.
- AC6 kind column: deep-confirm.server.ts:51 `ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ask'`;
  file not in diff. CONFIRMED.
- AC7 offer before save/return: ensureProduceOfferDelivered :7141 comes before saveTurnChunk :7143, and :7153
  comes before `return finalResult()` :7155. CONFIRMED.
- AC8 scorer/schema: scoreAskLLM sole call at :1238; routing.ts not in diff. CONFIRMED.
- Breadcrumb "(you chose this)": :4767 keys on `data.modelEscalate?.trim()`. CONFIRMED.
- Gate-catch fail-safe pin: :1765-1768 unchanged; the structural test passes. CONFIRMED.

## Radius challenge
- The opt-in change also gates assignCreatedJourneyTasks (it is inside the same `if`). I tested it as part
  of (b); it is not a separate risk.
- The voice hooks (useVoiceCallRealtimeSpeak.ts:371/594) send `journey: agentCfg?.journey?.enabled` as a
  scalar in a different payload. They are not a sendHuddleMessage `agents` map, so they are outside this
  path. useVoiceCallRealtime.ts:122 sends the full `backendsCfg.agents` map, so real voice 1:1 turns keep
  the write too. Read, not exercised live.
- No DB writes, no deployed-service calls, and no live QA run this loop.

## Verdict
CONFIRMED: (a), (b), AC1-AC8, breadcrumb, gate-catch pin. REFUTED: none. UNPROVEN: none in scope. The two
residuals under (a) are a deliberate trade-off and a DB-error-only window.
