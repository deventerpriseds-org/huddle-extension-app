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
