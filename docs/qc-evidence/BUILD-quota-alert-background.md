# BUILD -- background AI-job quota alert (bell + Iris 1:1)

<!--
WHAT:          Build log for raising ONE "OpenAI is out of credit" alert (bell item + Iris 1:1 notice, no model
               call) when ANY background AI job hits a quota error, auto-clearing on the next success, and
               logging each background job's failure KIND (never message text).
WHY:           Owner 2026-11-17: the OpenAI account hit `429 insufficient_quota` and no alert reached him. The
               existing alert (fallbacks.ts isQuotaError + QUOTA_OUTAGE_INLINE -> HuddleView toast
               `openai-quota-outage`) only fires inside a chat turn; background jobs only counted failures.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_quota-alert-background (base origin/main 80a7cf0e); tests listed below.
-->

All data in tests is synthetic (`.example` addresses). Logs carry job names, kinds and counts only.

## Step 0 -- base

- `git fetch origin`; `origin/main` = `80a7cf0e`. Branch `claude_quota-alert-background` created from it.

## Step 1 -- core (extends the existing pieces; no parallel detector)

| piece | file | what |
|---|---|---|
| shared failure kind | `lib/fallbacks.ts` `aiFailureKind` | moved from `scripts/proposals-preview.ts` (which now imports it) |
| detector | `lib/fallbacks.ts` `isQuotaError` | UNCHANGED, reused |
| bell kind | `lib/attention/attention.ts` `SYSTEM_KINDS` += `ai_quota` | same rules as `feed` (always listed/counted, not in "What counts") |
| bell row store | `lib/email/email-replies.server.ts` `raiseAiQuotaAttention` / `clearAiQuotaAttention` | one row per owner; row status = persisted outage state |
| monitor (pure) | `lib/ai-quota/ai-quota.ts` | onFailure / onSuccess, per-instance throttle, store dedupes cross-instance |
| job context + hooks | `lib/ai-quota/ai-quota.server.ts` | AsyncLocalStorage job context; `noteAiFailure` / `noteAiSuccess` / `noteAiResponse` no-op outside a job |
| central helpers | `lib/openai-responses.server.ts` | `callOpenAIRouter` / `callOpenAIResponses` report outcome (wrapper around unchanged inner body) |
| Iris notice | `executeClaimedTurn` `systemNotice` branch | fixed-text reply saved with NO model call, then the EXISTING push block |
| agent turns | `executeClaimedTurn` | non-user turns run as job `Agent turn (<prefix>)` |

`tsc --noEmit`: clean after adding the `ai_quota` icon to `AttentionBell.tsx` (`Record<BellKind,...>` caught it).

## Step 2 -- every background job wired (job context set at the job's entry)

| job (bell name) | entry wrapped | model calls reached |
|---|---|---|
| Auto-work | `routes/api/public/run-autowork.ts` | callOpenAIResponses / Router via agent work |
| Grooming | `run-grooming.ts` | groom.ts raw chat/completions (`noteAiResponse`) |
| Stand-up | `run-standup.ts` | ceremony-script raw fetch (`noteAiResponse`), agent turns |
| Review digest / Review recheck | `run-review-digest.ts` / `run-review-recheck.ts` | agent turns |
| Priority check / Schedule brief | `run-priority-check.ts` / `run-schedule-brief.ts` | agent turns |
| Ceremony | `run-ceremony.ts` | ceremony-script, agent turns |
| Inbound email | `run-inbound-email.ts` | Iris email-alert turns |
| Meeting minutes and triage | heartbeat `processDueFirefliesMeetings` (scheduler.server.ts) | fireflies.server |
| Correspondence and Actions classifier | heartbeat `runCorrespondenceIngest` (incl. `runActionsClassify`) | callOpenAIRouter; `classify_timeout` reported |
| Task proposals | heartbeat `runProposalsPass` | proposals extract/judge (callOpenAIRouter); `extract_timeout`/`judge_timeout` reported |
| Confirm-intent asks | heartbeat `fireDueConfirmAsks` | agent turns |
| Agent turn (<id prefix>) | `executeClaimedTurn` for every non-user turn (autowork-, standup-, groom-, followup-, integrate-, worker sub-turns ...) | runHuddleTurn -> callOpenAIResponses / Router |

The scheduler (`fireJob`) POSTs to the routes above, so cadence fires are covered by the route wrappers.
NOT wrapped (interactive, unchanged): the user's own `u-`/`xapp-` turns -- they keep the existing toast.
`tsc --noEmit`: clean.

## Step 3 -- offline suite

`bun scripts/ai-quota-alert.test.ts`: **44 passed, 0 failed** (Q1 one row + one notice, Q2 no duplicate, Q3 concurrent -> one, Q4 success clears + recovery, Q5 non-quota logs kind only, Q6 throttle, Q7 no owner, N1 zero fetch while raising/clearing, N2 notice payload, N3 source-order guard, B1 bell, K1 kind helper, J1, C1 job context).

## Step 4 -- real SQL suite

`bun scripts/ai-quota-alert-sql.test.ts` (local PostgreSQL 16): **12 passed, 0 failed** -- D1 four concurrent "instances" -> one row, one notice; D3 no duplicate; D4 listed first; D5 talking to Iris does not clear; D6 dismiss holds for the outage; D7 concurrent successes clear once; D8 next outage reopens; D9/D10 kind + owner isolation.

## Step 5 -- mutation proofs (`mutate.sh`, anchors in files, exact test names, exit code read)

| # | guard | mutation | test | verdict (exit) |
|---|---|---|---|---|
| M1 | SQL raise opens only from no row / auto-cleared | drop `AND e.status = 'replied'` | D1 concurrent raise (4 instances) -> exactly one alerted | FIRED, control EQUIVALENT (0) |
| M2 | monitor notifies only the caller that opened the row | `if (false) return "already_open"` | Q2 second quota error -> already_open | FIRED, control EQUIVALENT (0) |
| M3 | only quota errors alert (existing isQuotaError) | `if (false) return "not_quota"` | Q5 non-quota -> not_quota | FIRED, control EQUIVALENT (0) |
| M4 | success clears through the store | `cleared = false` | Q4 success -> cleared | FIRED, control EQUIVALENT (0) |
| M5 | talking to Iris does not settle the row | drop `'ai_quota'` from settleAttentionForHuddle exclusion | D5 talking to Iris does NOT clear it | FIRED, control EQUIVALENT (0) |
| M6 | notice branch reads systemNoticeResult before the model path | `const notice = null` | N3 the branch is driven by systemNoticeResult(record.payload) | FIRED, control EQUIVALENT (0) |
| M7 | failure KIND is logged | drop `kind=${kind}` | Q5 kind logged | FIRED, control EQUIVALENT (0) |
| M8 | bell always lists ai_quota | `SYSTEM_KINDS = ["feed"]` | B1 listed even with every owner kind off | FIRED, control EQUIVALENT (0) |
| M9 | empty notice text never short-circuits a turn | drop the non-empty check | N2 empty notice text is not a notice | FIRED, control EQUIVALENT (0) |
| M10 | one shared kind helper | local copy in proposals-preview.ts | K1 preview script imports the shared copy | FIRED, control EQUIVALENT (0) |

First M10 attempt (replace the alias line) was INERT -- the K1 check reads the import line; re-aimed at the import (the real
"second copy" defect). First M1/M5 runs were UNDETERMINED: `/tmp` was full (other sessions' `corr-*` clusters plus this
suite's own leaked `aiquota-*` dirs); the SQL suite now removes its cluster in `finally`, then both FIRED.

## Step 6 -- build check found a client-bundle hazard; fixed

- First `vite build` (rc=0) put `node:async_hooks` into the client `routing-*.js` chunk: `openai-responses.server.ts`
  statically imported `ai-quota.server.ts`, and `routing.ts` (client-reachable) reaches that helper. Vite shims the
  node module empty, so `new AsyncLocalStorage()` would throw when the chunk evaluates in a browser.
- Fix: `lib/ai-quota/hooks.ts` (no imports at all) forwards through a `globalThis` registry that `ai-quota.server.ts`
  fills when it loads (loading it is what starts any job). The helper and the raw-fetch sites import only `hooks.ts`.
- Rebuild rc=0: the only `async_hooks` text left in `routing-*.js` is the AI SDK's own guarded diagnostics lookup
  (`mo("node:async_hooks")`), not this code. `ai-quota.server` appears in public assets only as a LAZY chunk behind
  `executeClaimedTurn` -- the same pattern as the existing `turns.server` / `email-replies.server` lazy chunks.
- New guards: G1 (helper never imports ai-quota.server; hooks.ts has no imports), C2 (registry forwards, only inside
  a job, kind only).

## Step 7 -- final counts (head of branch)

| check | result |
|---|---|
| `npx tsc --noEmit` | clean (0 lines) |
| `npx vite build` | rc=0 |
| `bun scripts/ai-quota-alert.test.ts` | 49 passed, 0 failed |
| `bun scripts/ai-quota-alert-sql.test.ts` | 12 passed, 0 failed |
| `bun scripts/feed-staleness.test.ts` / `-sql` | 98 / 23 passed, 0 failed |
| `bun scripts/attention.test.ts` / `attention-focus.test.ts` | all passed |
| `bun scripts/proposals-preview.test.ts` | 15 passed, 0 failed |
| `bun scripts/correspondence-ingest.test.ts` | 186 passed, 0 failed |
| `bun scripts/actions-view.test.ts` | 82 passed, 0 failed |
| `bun scripts/barge-deadline.test.ts` / `approach-override.test.ts` | 13 passed / rc=0 |

## Existing behaviour that changes (additive otherwise)

1. `listOpenAttention` ordering: `ai_quota` rows sort first alongside `feed` rows (no existing row changes position
   relative to another existing row).
2. Agent-initiated durable turns and the scheduled job routes now run inside an AsyncLocalStorage job context; the
   shared helpers fire-and-forget an outcome report. No return value, error or timing of any model call changes.
3. `scripts/proposals-preview.ts` uses the shared `aiFailureKind` (identical body) instead of its local copy.
4. Bell icon map gains `ai_quota` (CreditCard); shown only when such a row exists.
