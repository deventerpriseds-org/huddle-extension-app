# VERIFY-deep-ask-hybrid-2

<!--
WHAT:       Independent verification (loop 2) of fix commit 74883ca, diffed against 24e578a.
WHY:        Loop 1 (VERIFY-deep-ask-hybrid-1.md) refuted AC4 and AC9 and flagged AC1 (o3/Sol spend) and AC3 (non-answer produce route).
SUPERSEDES: nothing (loop 1 file stays on claude_verify-deep-ask-hybrid-1)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; commands run against detached HEAD 74883ca in an isolated worktree.
-->

Commit 74883ca (claude/intelligent-hawking-qj88qu), diff vs 24e578a: 4 files
(qa-produce-quick.mjs, scripts/ask-shape.test.ts, huddle.functions.ts, tasks/ask-shape.ts).
No DB or deployed service touched. Started 18:19 UTC.

## Suite (observed)
- `npx tsc --noEmit -p .` -> no output, tsc_exit=0
- `bun scripts/ask-shape.test.ts` -> every line PASS, "ALL PASS", exit=0 (incl. the 3 STRUCTURAL regex checks)
- `bun scripts/verdict-memory.test.ts` -> "ALL PASS", exit=0
- `bun scripts/green-light.test.ts` -> "ALL PASS", exit=0
- `bun scripts/router-winners.test.ts` -> "20 passed, 0 failed", exit=0

## AC1 -- act ask runs on the BUDGET tier (Terra-high), never o3/Sol: CONFIRMED (normal path)
- huddle.functions.ts:1731-1733: `route === "act-now"` -> `deepManual = "budget"`; difficulty left at 3.
- Persona site :4723-4728 passes `{ manual: deepManual }` to resolveByDifficulty; model-policy.ts:208-209
  returns `gpt-5.6-terra / high` for manual "budget" BEFORE any ceiling logic.
- Observed (bun, scratchpad tier.ts), iris-chase, manual "budget" vs unpinned:
  ```
  d=3 ceil=none  budget-> gpt-5.6-terra/high | unpinned-> gpt-5.6-sol/high
  d=3 ceil=o3    budget-> gpt-5.6-terra/high | unpinned-> o3/high
  d=3 ceil=sol   budget-> gpt-5.6-terra/high | unpinned-> gpt-5.6-sol/high
  d=3 ceil=terra budget-> gpt-5.6-terra/high | unpinned-> gpt-5.6-terra/high
  d=3 ceil=luna  budget-> gpt-5.6-terra/high | unpinned-> gpt-5.6-luna/high
  d=4 (identical pattern for all five ceilings)
  ```
- Resume chunks: `routed` is rebuilt with no `difficulty` (:1137) and deepManual is unset (gate is `!resume`),
  so a continuation resolves at difficulty 2 (Luna-high per DIFF_RUNG) -- not o3/Sol.
- No other reader of `routed.difficulty` after the gate (grep: only :1729, :1736, :4724, :4735).
- Side findings (not refutations of the AC as written):
  1. A Luna-capped agent is RAISED to Terra-high for an act ask: the manual override returns before the
     ceiling is applied (model-policy.ts:208-212). Whether a "luna" ceiling should hold here is an owner call.
  2. Fail-open path (code-read, NOT exercised): the pin is assigned inside the try at :1591-1749. Store calls
     catch internally (deep-confirm.server.ts:81,109,123,169), but `resolveCallerEmail` -> `resolveTaskEmail`
     -> `resolveCanonicalEmailByLogin` (journey/identity.ts:129-139) has no catch. If that throws, the catch
     at :1745 "proceeds without gate" and a difficulty-3 1:1 ask resolves unpinned (o3/high or Sol/high, with no
     needsConfirm under a sol ceiling). routeDeepAsk does not depend on the DB, so it could be hoisted out of
     the try. Same exposure existed before the hybrid.
  3. Stale comment at :4713-4715 still says "a fresh 1:1 deep ask is confirm-gated".

## AC3 -- no fresh deep ask is diverted to runProduce: CONFIRMED
- ask-shape.ts:38-40: `routeDeepAsk(shape)` takes only the shape and returns "act-now" | "answer-with-offer";
  the type `DeepAskRoute` (:26) no longer has "produce". tsc exit 0, so no caller passes a second arg.
- grep `runProduce(` in src -> exactly two call sites: huddle.functions.ts:1677 (pending.kind==="offer" AND
  inside TTL AND isOfferAccepted) and :1700 (legacy kind==="ask" row AND classifyConfirmReply==="produce").
  Both run `pending.askText`, never a fresh ask. The fresh-ask block :1729-1744 only sets deepManual /
  difficulty / produceOffer / reason and never returns.
- grep `isGreenLight|hasGreenLit` in src -> no caller in huddle.functions.ts; isGreenLight is used only by
  classifyConfirmReply (deep-confirm.server.ts:232), i.e. the legacy-row branch.
- Residual (inside AC5's scope, not a regression): only setPendingDeepConfirm caller now writes kind "offer"
  (huddle.functions.ts:6876), so a legacy "ask" row can only be one written before deploy, and those expire
  in 2h (deep-confirm.server.ts:103). During that window, a NEW long ask containing "get started"/"proceed"
  sent while a legacy row is pending is classified "produce" and runs runProduce on the OLD askText. This is
  the pre-hybrid behaviour, bounded to 2h after deploy.

## AC2 -- deliverable/null -> terra-med, difficulty 2, offer appended, row only if appended: CONFIRMED (re-check)
- :1734-1738 else-branch (shape "deliverable" or null): deepManual="terra-med", routed.difficulty=2,
  produceOffer set. Resolver for manual "terra-med" -> LADDER rung gpt-5.6-terra/medium (model-policy.ts:29, :211-212).
- ensureProduceOfferDelivered :6868-6877: `if (!out.appended) return;` precedes setPendingDeepConfirm. Unchanged in this diff.

## AC7 -- both terminal paths deliver the offer before save/return: CONFIRMED (re-check)
- Chunked done path: :7119 `await ensureProduceOfferDelivered()` then :7121 saveTurnChunk(..., true, finalResult()).
- Sync path: :7131 then `return finalResult()` at :7133. Partial path (:7111-7115) returns before either (loop-1 gap, see below).

## AC4 -- anchored whole-reply match, <=60 chars, 30-minute TTL at the call site: CONFIRMED
- ask-shape.ts:49-60: OFFER_ACCEPT is `^...$` anchored; `n.length > 60` -> false; isNegatedOrAsked first.
  OFFER_TTL_MS = 1800000 (observed). Call site :1674 `Date.now() - pending.createdAt <= OFFER_TTL_MS && isOfferAccepted(data.text)`;
  an accept-shaped reply past the TTL falls to :1679 clearPending and routes normally.
- Probe (bun, scratchpad offer.ts / offer2.ts), observed:
  - Loop-1 counterexamples, all 9 -> false (incl. "no, produce nothing — I just wanted the summary",
    "nah. maybe produce later", "Can you make it a task for Thursday to call the dentist",
    "Which local farms produce the most organic eggs near me", "put it on the board for Finn to look at",
    "thanks. the produce aisle at Kroger was empty today lol", "ok and what about the full version of the vitamin list...").
  - 40 NEW adversarial non-acceptances -> 40/40 false. Includes: "no", "no produce", "no, produce", "not now, produce later",
    "do not produce it", "no thanks, the full version isn't needed", "full version? no", "the full version can wait",
    "produce it tomorrow", "produce it later", "make it a task later", "maybe make it a task", "should i make it a task?",
    "put it on the board?", "work it up later", "produce the grocery list for tonight", "produce a budget for march",
    "make it a task to buy milk", "put it on the board under finance", "work it up for finn", "ok produce nothing",
    "yes, but not the full version", "never mind, produce", "no, make it a task", "nah put it on the board",
    "stop, produce", "cancel. produce", "wait produce", "skip it, work it up", "yes — don't produce", "sure, produce later".
  - Plausible acceptances: 18/25 accepted, e.g. "produce please", "yes, produce it", "please produce it", "ok, produce",
    "Full version!", "I'd like the full version", "send me the full version please", "yes, make it a task",
    "sure, put it on the board", "yes produce the full version", "Produce.", "yes, produce.", "Yes. Produce", "  PRODUCE  ".
  - MISSED (returns false): "yes — produce", "yes - produce", "go with the full version", "go ahead and produce it",
    "do the full version", "let's produce it", "produce it please 🙏", "produce 👍", "produce pls", "produce it now",
    "yes, produce it now", "**produce**" (the raw markdown of the offer line itself), "yes please".
- Consequence of a miss (code-read, :1674-1679): a near-miss acceptance is NOT safe-retried. It CLEARS the
  pending offer and routes the reply as a normal message, so a follow-up "produce" finds no pending offer.
  No wrong produce task is ever created (fails safe); the cost is the user losing the offer. "yes please" missing is by design.
