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
