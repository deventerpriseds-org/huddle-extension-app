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
