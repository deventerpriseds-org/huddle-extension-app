# VERIFY-second-mailbox-1 — independent verifier pass on the second-tenant (Trinnex) mailbox change

WHAT:       Adversarial verification of claims C1-C8 for journey-voice PR #99 and huddle-extension-app PR #150
            (branch `claude/cool-cannon-q4puke`), written incrementally as each claim is tested.
WHY:        The change hands a delegated Graph mail+calendar credential across two services; a regression
            would leak a credential to a model or break the owner's existing EnterpriseDS mailbox features.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   huddle origin/claude/cool-cannon-q4puke @ 9c0e8a8d vs origin/main @ 08457bc0;
            journey origin/claude/cool-cannon-q4puke @ 3c310f49 (fresh clone in verifier scratchpad).

Conventions: OBSERVED = read in source / command output this pass. INFERRED = reasoning, not executed.

## Journey side (read first)

- OBSERVED `execute-tool/index.ts` serve(): `get_mail_access_token` refused with 401 unless
  `mintCaller(...) === 'service_role'`; `mintCaller` (`_shared/push-auth.ts`) returns service_role ONLY when
  the bearer constant-time-equals `SUPABASE_SERVICE_ROLE_KEY`. A user JWT returns `owner_jwt` -> 401; anon/none -> 401.
- OBSERVED `getMailAccessToken` filters `calendar_connections` by `.eq("user_id", userId)` + provider in
  (outlook, office365) + is_active, matches `provider_account_email` case-insensitively, then reads the refresh
  token via RPC `get_calendar_connection_tokens`. It performs NO `.update()` — nothing written back.
- OBSERVED huddle-proxy `/tool` gate: Bearer must equal `JOURNEY_PROXY_TOKEN`; user resolved from
  `caller.entra_email` via `user_email_aliases` (ilike) then `profiles.email` (ilike); forwards to execute-tool
  with the service-role bearer; returns `exec.result` serialised in `output` (so the token comes back in `output`).
- OBSERVED residual journey-side exposure: journey's OWN model tool executors call execute-tool with the
  SERVICE-ROLE bearer and a MODEL-CHOSEN tool name, and hand the JSON back to the model:
  `_shared/tool-executor.ts:88` (used by `twilio-realtime-bridge/index.ts:689`, `msg.name`),
  `hybrid-assistant-api/index.ts:294` (`toolCall.function.name`), `conversation-relay-handler/index.ts:105`,
  `twilio-voice-handler`. None of them allow-lists the tool name. The new gate treats them as authorised.
  The tool is not advertised in `toolDefinitions`, so a model emitting it requires hallucination or injection
  (INFERRED low likelihood) — but the claim "no model path can obtain it" is NOT true on the journey side.

## C1 — no behaviour change for an all-EnterpriseDS owner: **REFUTED** (observed)

- OBSERVED (journey DB, Supabase MCP, read-only, non-secret columns only, 2026-11-05): user
  `a3378f93-…` (dev@ canonical; von.ellis@ is an alias) has **TWO active Microsoft connections, both EnterpriseDS**:
  `office365 Von.Ellis@EnterpriseDS.io is_active=true` and `outlook Dev@EnterpriseDS.io is_active=true`
  (plus two inactive google rows). No @trinnex.io row exists yet.
- OBSERVED origin/main `pickOutlookMailbox` returned the FIRST Microsoft row only. The branch's
  `pickOutlookMailboxes` (calendar-mailbox.ts:37-55) returns BOTH, and every changed caller now loops over all:
  - `runInboundEmailWatch` (inbound-email.server.ts:82-116) now also reads **dev@'s inbox** and can raise
    owed-email alerts/ledger rows for mail sent to dev@ — alerts the owner never received before.
  - `getOwnerCalendarEvents` (graph-email.server.ts:684-705), `meetingsForDate` extra loop
    (schedule-brief.server.ts) and the voice calendar tool now MERGE dev@'s calendar into von.ellis@'s.
    A meeting on both calendars appears twice (different Graph event ids), so the brief lists it twice and
    the T-60 seeder (keyed by event id) can mint two reminders (INFERRED from id-keying; not executed).
  - `runInboxReadTool` search merges dev@ results; `createDraftForTool` tries dev@ as a reply mailbox.
- Graph URL shape / token type for EDS mailboxes IS unchanged (`mailboxAccess` app-key branch,
  graph-email.server.ts:231-234 = `/users/{mailbox}` + `getAppToken()`), so per-call URLs match main.
  The regression is in WHICH mailboxes are called, not how.
- Pre-existing (not introduced): journey's order is unordered, so on main the single "main" mailbox could already
  flip between von.ellis@ and dev@ between requests. The branch's partition keeps both in the app-key group in
  journey order, so "main" (subscription resource, plain-draft fallback, calendar error decider) still flips.

## C2 — non-EDS account can never become main while an EDS one is connected: **CONFIRMED** (observed), with caveat

- OBSERVED journey `getMyConfig.fetchCalendarConnections` (execute-tool/index.ts:2965-2971): `.eq('user_id')`, no
  `.order()` — rows are unordered.
- OBSERVED `pickOutlookMailboxes` returns `[...appKey, ...nonAppKey]` (stable partition), and every reader takes
  `[0]` as main. Covered by the test run below.
- Caveat (INFERRED, by design): "connected" = `is_active !== false`. If the EDS rows go inactive, Trinnex becomes
  main, and `ensureMailSubscription` (mail-subscription.server.ts:144) then tries an app-key subscription on
  `users/{trinnex}` which fails every run (logged, non-fatal).
