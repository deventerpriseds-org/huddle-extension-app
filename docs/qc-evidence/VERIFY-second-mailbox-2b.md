<!--
WHAT:       Independent verifier verdicts for claims C3, C4, C5 of the second-mailbox (Trinnex) change, loop 2 lane b.
WHY:        Loop 1 (VERIFY-second-mailbox-1.md) was killed by a restart before reaching the Huddle half of C3, and C4/C5; it also REFUTED journey C3 (model executors could call execute-tool with model-chosen names). Claimed fix: journey 7ad91547.
SUPERSEDES: nothing (lanes 2a/2c run alongside; together they supersede VERIFY-second-mailbox-1.md)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   journey origin/claude/cool-cannon-q4puke 7ad91547; huddle origin/claude/cool-cannon-q4puke 48c34655
-->
# VERIFY second-mailbox loop 2b (C3, C4, C5)

Started 2026-11-05 22:50 UTC. Budget 15 min.

## C3 -- no model / voice / debug / UI path, and no journey model executor, can obtain a mail token: CONFIRMED (code read, observed)

Huddle (origin/claude/cool-cannon-q4puke 48c34655):
- `journeyFetch` (the only fetch that carries JOURNEY_PROXY_TOKEN to huddle-proxy) is module-private in
  proxy.functions.ts:35 and its only `/tool` caller is `invokeJourneyTool` (proxy.functions.ts:142).
  `git grep journeyFetch|JOURNEY_PROXY_URL -- src` finds no other caller. Other JOURNEY_PROXY_TOKEN
  readers (turn-gate.ts:217, mail-subscription.server.ts:92, scheduler.server.ts:226,
  huddle.functions.ts:7611, graph-mail-notify.ts:36) use it as an inbound webhook secret / clientState,
  not to call huddle-proxy.
- Gate at proxy.functions.ts:128: `SERVER_ONLY_JOURNEY_TOOLS.has(toolName) && !opts.allowServerOnly` -> refused.
  `git grep allowServerOnly -- src` -> exactly ONE caller, graph-email.server.ts:246, with the hardcoded
  toolName "get_mail_access_token" (line 241). The debug server fn `invokeJourneyToolDebug`
  (proxy.functions.ts ~250) calls invokeJourneyTool without opts -> refused.
- Name-variant bypass ("GET_MAIL_ACCESS_TOKEN", trailing space): passes Huddle's Set check, but
  huddle-proxy matches only the exact string (huddle-proxy/index.ts:203) and execute-tool has no
  implementation of any variant (no `case`, no getMailAccessToken import) -> nothing mints. Not a bypass.

journey (origin/claude/cool-cannon-q4puke 7ad91547):
- `getMailAccessToken` is imported ONLY by huddle-proxy/index.ts:17 (git grep across supabase/functions).
- execute-tool/index.ts:3368 refuses the name for every caller before any dispatch; toolName is taken
  raw from the body at :3349 with no normalisation.
- No journey function calls huddle-proxy: `git grep huddle-proxy|JOURNEY_PROXY_TOKEN` outside
  huddle-proxy hits only comments plus drain-huddle-turns (which calls HUDDLE, outbound). So journey's
  model executors (tool-executor.ts, hybrid-assistant-api, twilio bridges) can only reach execute-tool,
  which refuses. Loop-1 REFUTATION is resolved.

## BUDGET HIT 23:13 UTC (started 22:50). Remaining items below are recorded at the depth reached.

## C4 -- token never logged / echoed / returned to a model: CONFIRMED for the paths read; huddle-proxy outer catch NOT REACHED
- journey mail-access-token.ts:75 logs only `res.status` + the AADSTS code; returns the token only under `result`.
- huddle-proxy/index.ts:203-208 returns the token to Huddle (the intended recipient); error branch returns only `r.error` (an enum).
- Huddle graph-email.server.ts:248-267: on failure throws one of three fixed sentences built from the error CODE
  (`parsed.error ?? r.error`), never `r.output`; the token is kept in `delegatedTokenCache` and used locally in Authorization headers.
  The only console.* calls in the file (701, 740, 776, 1054) print Graph error text, not the token.
- mailboxAccess is called directly by server code, not through the model tool-dispatch loop, so no tool-result trace captures it.
- NOT REACHED: huddle-proxy's outer try/catch body; whether any Huddle caller rethrows Graph `res.text()` that could contain the token (not expected).

## C5 -- only the caller's own connection; no write-back; resolveUserId resolves Huddle's identities: PARTIAL
- CONFIRMED (observed): mail-access-token.ts selects calendar_connections `.eq("user_id", userId)` + `.eq("is_active", true)` +
  exact match on provider_account_email, where userId = huddle-proxy `resolved.userId`. The only other DB call is the RPC
  get_calendar_connection_tokens (migration 20250928050345:107), which reads tokens and INSERTs into oauth_token_audit -- it
  does not touch calendar_connections. No `.update`/`.upsert` anywhere in the minter.
- Huddle mailboxes come from resolveOutlookMailboxes(caller) (journey's list of the caller's connections), never from model args.
- NOT REACHED: the live DB check that `dev@enterpriseds.io` resolves through profiles.email and `von.ellis@enterpriseds.io` through
  user_email_aliases (code at huddle-proxy resolveUserId is alias-first, then profiles; the identity rows were not queried).
- DEFECT (inferred, low): Huddle `delegatedTokenCache` (graph-email.server.ts:237/266) is keyed by MAILBOX only, not owner+mailbox.
  If a second Huddle user's resolved mailbox list (or entra_email fallback) ever contains a mailbox cached for another user, they get
  that user's token without journey's per-user check. Effectively single-user today.

## Suites: NOT REACHED (journey npm test, huddle bun scripts/second-mailbox.test.ts not re-run in this lane).
