# VERIFY-quota-alert-background-2

<!--
WHAT:       Independent verification of branch claude_quota-alert-background (head 457356ac), loop 2.
WHY:        Loop 1 was killed by an interrupt after recording one claim (C3 suites). This loop re-runs every suite
            and derives every claim, with the job-context wrapping of every turn and route checked first.
SUPERSEDES: nothing (loop 1 file stays as the record of what it reached).  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   commands and output quoted below, run 2026-11-17 in an isolated worktree (synthetic data only).
-->

Verifier: independent subagent. Started 04:45 UTC, budget 40 min. Branch under test `457356ac`, merge base
`80a7cf0e`, origin/main `27146c4d` (#266). Baseline = a detached worktree at `80a7cf0e`.

## Suite counts, branch vs base (re-run this loop)

| suite | branch 457356ac | base 80a7cf0e |
|---|---|---|
| ai-quota-alert | 49 pass / 0 fail | absent |
| ai-quota-alert-sql (local PG) | 12 / 0 | absent |
| router-winners (`test:router`) | 39 / 0 | 39 / 0 |
| router-redteam | 12 / 0 | 12 / 0 |
| barge-deadline | 13 / 0 | 13 / 0 |
| barge-route | 10 / 0 | 10 / 0 |
| turn-identity | ALL PASS | ALL PASS |
| turn-push | 9 / 0 | 9 / 0 |
| turn-catchup | 5 / 0 | 5 / 0 |
| attention / attention-focus | all passed | all passed |
| feed-staleness / -sql | 98/0, 23/0 | 98/0, 23/0 |
| proposals-preview | 15 / 0 | 15 / 0 |
| correspondence-ingest | 186 / 0 | 186 / 0 |
| actions-view / -server | 82/0, 26/0 | 82/0, 26/0 |
| **cross-app-turn-gate** | **91 / 1 FAIL** | 92 / 0 |

Builder counts reproduce. The builder did not run `cross-app-turn-gate`: its `G7 REGRESSION: not one existing
public route file is modified` goes red because the branch edits run-ceremony/run-autowork/run-grooming/run-standup/
run-review-digest/run-review-recheck. G7 compares each file to `origin/main` byte for byte, so it goes green again
once the branch is on main, and no workflow in `.github/workflows` runs it. Severity LOW, but it is an existing
guard firing on this branch that the BUILD record leaves out.

## C1 No regression to normal turns -- CONFIRMED (by suites + diff reading), one LOW note

- Router/turn suites identical on branch and base (table above): router-winners 39, router-redteam 12,
  barge-deadline 13, barge-route 10, turn-push 9, turn-catchup 5, turn-identity ALL PASS.
- Diff of `openai-responses.server.ts`: `callOpenAIRouter`/`callOpenAIResponses` become `try { out = await inner(input);
  noteAiSuccess(); return out } catch (e) { noteAiFailure(e); throw e }`. Same argument, same returned object, same
  error object re-thrown. The hooks are synchronous registry lookups that start a `void` async IIFE, so they add no
  await to the call.
- `executeClaimedTurn`: user turns (`isUserTurn(id)`) call `fn()` directly. Agent turns run inside `runAsAiJob`,
  which is `AsyncLocalStorage.run(ctx, fn)` and returns fn's own promise. The push block after it reads
  `record.payload`, not `data`, so the notice branch's stub `data` does not change the push.
- The nine run-* routes and the scheduler wrap the same call in `runAsAiJob(job, email, () => call(...))` with the
  arguments unchanged. The scheduler's wrapper falls back to `fn()` if the module import fails.
- LOW note: `await import("./ai-quota/ai-quota.server")` now runs at the top of EVERY claimed turn, user turns
  included, before the worker branch. If that module ever failed to load, every durable turn would go to failTurn.
  It loaded cleanly in the build and in the suites, so this is a fragility, not an observed defect.

## C2 No model call for Iris's fixed-text notice -- CONFIRMED, one LOW hardening note

Probe `scratchpad/probe-notice.ts` against `systemNoticeResult`:
```
null / undefined / string / array / systemNotice:true / systemNotice:"hi"      -> null
missing agentId / empty agentId / numeric text / whitespace-only text          -> null
user-like {text:"systemNotice: OpenAI is out of credit"}                       -> null
nested payload.data.systemNotice / __proto__ JSON pollution                    -> null
valid {systemNotice:{agentId:"iris-chase",text:"ok"}}                          -> NOTICE agent=iris-chase
valid but agentId "nobody"                                                     -> NOTICE agent=nobody
5000-char text                                                                 -> NOTICE len=2000 (capped)
```
- Order in `executeClaimedTurn` (read at huddle.functions.ts:8226-8247): worker check, then `systemNoticeResult`,
  then `saveTurnChunk(..., done=true)`; `Input.parse` and `runHuddleTurn` sit only in the `else` branch. The notice
  branch has no `callOpenAI*`, `generateText`, `fetch(` or `runHuddleTurn` (also asserted by the builder's N3).
- Can a user forge one? Both client entry points drop unknown keys: `enqueueHuddleTurn` stores
  `EnqueueTurnInput.parse(raw)` (a plain zod v3 `z.object`, no passthrough/catchall in the file, so `systemNotice`
  is stripped -- inference from zod's documented default), and `/api/public/run-agent-turn` builds its payload from an
  allow-list in `cross-app/turn-gate.ts:393-406`. So only server code can write one.
- LOW hardening: the notice is recognised by payload shape alone, not also by the `aiquota-` id prefix, and any
  `agentId` is accepted. Not reachable from a client today.

## C4 Browser bundle -- CONFIRMED

`npm run build` exit 0 on branch and base. Client output is `.output/public/assets` (96 js files).
```
async_hooks          branch: routing-DvBbT-Lc.js   base: routing-D95syoP0.js   (same library code on both:
                     `r=mo(\`node:async_hooks\`)` next to `node:diagnostics_channel`, an optional lookup) -> PRE-EXISTING
AsyncLocalStorage    branch: ai-quota.server-612L0nwL.js only
static import of ai-quota.server from any client chunk: none (loop over every chunk for from"./ai-quota.server-")
how it is reached:   huddle.functions-D8UCkG_v.js -> `await import(\`./ai-quota.server-612L0nwL.js\`)` (lazy, inside
                     executeClaimedTurn, which never runs in a browser)
openai-responses.server chunk imports only ./hooks-De6XJlLT.js (no node import)
```
So no browser chunk loads `node:async_hooks` because of this change. The lazy server chunk sits in the client
directory in the same way base already ships `turns.server-*.js` there. That is the existing pattern, not a new leak.
