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

## C3 Dedupe and state across processes -- CONFIRMED, two LOW gaps

- Builder suites (re-run): ai-quota-alert 49/0; ai-quota-alert-sql 12/0 on real local PG through the real
  `email-replies.server` module and its bootstrap (D1 concurrent raise across 4 instances -> exactly one alerted, D6
  dismissed not reopened, D7 concurrent successes -> one cleared, D8 next outage reopens the same row).
- Own probe `scratchpad/probe-state.ts`: two monitors (two instances) share a fake store that copies the SQL `WHERE`
  semantics (times in ms):
```
t=0      A quota                              alerted       row=owed      notices=outage
t=5000   owner dismisses
t=6000   B quota (same outage)                already_open  row=dismissed notices=outage
t=70000  A quota (after throttle)             already_open  row=dismissed notices=outage
t=80000  B success                            cleared       row=replied   notices=outage,recovered
t=90000  A quota (2nd outage)                 throttled     row=replied
t=100000 B quota (2nd outage)                 alerted       row=owed      notices=outage,recovered,outage
t=110000 B non-quota 500                      not_quota     row=owed      (no new notice)
```
- SQL reading: `raiseAiQuotaAttention` upserts only `WHERE e.kind='ai_quota' AND e.owner_email=lower($2) AND
  e.status='replied'`. An open or dismissed row writes nothing and returns false. `clearAiQuotaAttention` moves
  owed/drafted/dismissed to replied. `settleAttentionForHuddle` now excludes `ai_quota`. Every other `UPDATE` or
  `SELECT` on `chat.email_replies` is filtered by id or by `kind IN ('email'|'chat'|'feed')`, so no email or chat
  sweep can touch the row, even though it stores the job name in `graph_message_id`.
- LOW gap 1 (throttle): the instance that raised outage 1 throttles its own quota errors for 60 s. If another
  instance clears outage 1 and outage 2 starts inside that window, a lone error there is dropped
  (`C quota (outage 2, only error) -> throttled, row=replied`). The next quota error after 60 s alerts. In a real
  outage the errors repeat, so the alert is late by up to 60 s, not lost.
- LOW gap 2 (owner): heartbeat jobs (meeting minutes, correspondence, proposals, confirm-asks) pass no owner and fall
  back to `getFeedsConfig()?.ownerLogins[0]`. With `HUDDLE_ONEDRIVE_FEEDS` unset that is null, so a quota error in
  Fireflies minutes logs `kind=... quota=true` and returns `no_owner`, with no bell row. Correspondence and proposals
  are off without that config anyway. Whether prod sets it is UNPROVEN here, because I did not read live config.
  feed-staleness uses the same `ownerLogins[0]` owner, so this follows an existing pattern.
- Raw-fetch path (`probe-response.ts`, synthetic 429 `Response`, PG URL unset so the store fails safely):
  `[ai-job] job=Grooming failed kind=429 insufficient_quota quota=true`, then `[ai-quota] raise failed Error`. A
  hypothetical site that reads the body BEFORE the lazily imported hook clones it logs `kind=429` with no quota flag,
  so the quota error is missed. All four edited sites (groom, focus, ceremony-script, and actions/proposals through
  callOpenAIRouter) do NOT read the body on `!ok`, so none is affected today. This is a latent trap for future sites.

## C5 Logs never echo input -- CONFIRMED

All new log lines in the diff: `aiFailureLogLine` (job sanitised `[^\w:./ -]` and capped at 60, plus kind),
`raise/clear/notice failed <ErrorName>`, `alert raised/cleared job=<job>` (job is a constant or `agentTurnJob`'s
letters-only prefix). `aiFailureKind` returns a status, a known code, `timeout`, or the error class name only.
Probe: 0 log lines contained the body marker `USERTEXT-SHOULD-NOT-LOG`, and probe-state's `"secret user text"` 500
logged 0 lines with "secret". `scripts/proposals-preview.ts` swaps its private `judgeFailureKind` for the shared
`aiFailureKind`, which has the same body (diff read: the moved function is byte-identical).

## Mutation proofs (`mutate.sh`, anchors in files under scratchpad/mut, exit code read)

| guard | mutation | test name | verdict | exit |
|---|---|---|---|---|
| G1 (bundle, builder unproven) | openai-responses.server imports `./ai-quota/ai-quota.server` instead of hooks | `G1 the shared helper imports the client-safe hooks, never ai-quota.server` | FIRED (control EQUIVALENT) | 0 |
| C2 (bundle, builder unproven) | registry assignment replaced by `void ({...} satisfies AiQuotaHooks)` | `C2 registry filled by the server module` | FIRED (control EQUIVALENT) | 0 |
| dedupe | `if (!opened) return "already_open"` -> `if (false) ...` | `Q2 still one notice` | FIRED (control EQUIVALENT) | 0 |
| dismiss (real PG) | raise WHERE `status='replied'` -> `IN ('replied','dismissed')` | `D6 dismissed row is not reopened` | FIRED (control EQUIVALENT) | 0 |
| non-quota | `if (!quota) return "not_quota"` -> `if (false) ...` | `Q5 no notice` | FIRED (control EQUIVALENT) | 0 |

Every restore was asserted against HEAD by mutate.sh. Caveat on G1: it is a source-text guard. It proves that the
helper's import line is checked. It does not prove the bundle property, which C4 measures directly.

## C6 Changes to existing behaviour -- CONFIRMED for the four listed; THREE the BUILD list misses

Confirmed from the diff: (1) `listOpenAttention` sorts `kind IN ('feed','ai_quota')` first; (2) routes and agent turns
run in a job context; (3) `settleAttentionForHuddle` excludes `ai_quota`; (4) `KIND_ICON.ai_quota = CreditCard`.
Tokens: the AttentionBell diff only adds an icon import and a map entry. A grep of AttentionBell.tsx for hex,
`rgb(`, and `(text|bg|border)-(red|blue|...)-N` returns nothing, so no raw colour is used.

Missed by the BUILD "Existing behaviour that changes" list:
- **M1 (MEDIUM, spec deviation, owner decision):** on recovery Iris posts a SECOND fixed message,
  "OpenAI calls are working again. The out-of-credit alert has cleared.", as a durable turn with `notify:"push"`.
  So an outage causes two chat messages and two phone pushes. The spec says ONE chat message, and "both clear".
  The recovery message also posts when the owner had dismissed the bell row. The code switch is
  `recoveryNotice` (ai-quota.ts, default true; ai-quota.server.ts does not set it).
- **M2 (LOW):** every successful model call inside a background job now runs `UPDATE chat.email_replies ... kind='ai_quota'`
  at most once per 60 s per owner per instance, plus one owner-resolution lookup the first time.
- **M3 (LOW):** agent-turn and background failures that were silent before now print `[ai-job] job=... failed kind=...`
  (including the classify/extract/judge timeouts). These are new log lines, and they hold no content (C5).
- `cross-app-turn-gate` G7 goes red pre-merge (see the suite table). It is not in CI.

## C7 Merge with current main (#266) -- CONFIRMED clean

Scratch worktree at 457356ac, `git merge origin/main` (27146c4d): no conflicts, 10 files from #266. After the merge,
`actions.server.ts` still has its classify_timeout hook next to #266's cap code. On the merged tree:
ai-quota-alert 49/0, -sql 12/0, router-winners 39/0, router-redteam 12/0, barge-deadline 13/0, barge-route 10/0,
turn-push 9/0, turn-catchup 5/0, turn-identity ALL PASS, attention / attention-focus pass, feed-staleness 98/0 and
23/0, proposals-preview 15/0, correspondence-ingest 186/0, actions-view 90/0 (82 to 90 from #266),
actions-view-server 28/0, report-from-ledger 103/0, cross-app-turn-gate 91/1 (the same G7). `tsc --noEmit` exit 0
on the branch and on the merge. `npm run build` exit 0 on the merge; `AsyncLocalStorage` appears only in the lazy
`ai-quota.server-*.js` chunk. The one build "error" line is the existing `web-push` node:util externalisation
warning.

## Verdict

| claim | result |
|---|---|
| C1 no regression to normal turns | CONFIRMED (suites equal to base; diff read) |
| C2 no model call for the notice | CONFIRMED (probe + order read); LOW hardening note |
| C3 dedupe / clear / dismiss / non-quota | CONFIRMED (suites, real PG, two-instance probe); two LOW gaps |
| C4 browser bundle | CONFIRMED (client grep, compared with base) |
| C5 logs | CONFIRMED |
| C6 behaviour changes | CONFIRMED + 3 unlisted (M1 MEDIUM) |
| C7 merge with main | CONFIRMED clean |
| UI: bell row renders with the CreditCard icon; Iris's message shows in dm-iris-chase; phone push arrives | **UI-UNVERIFIED**, no browser or device run in this loop |
| live end to end (real enqueueTurn -> push on prod) | NOT REACHED (no live DB or workflows, by brief) |

PASS 7/7 code claims | FAIL 0 | UI-UNVERIFIED 1 | **Verdict: MERGE-PENDING-UAT.** Before calling the work done,
the owner decides M1 (keep or drop the second recovery message and push), and a verify-uat run checks the bell row and
Iris's message after landing. Until then the status is NOT YET UAT-VERIFIED.
