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
