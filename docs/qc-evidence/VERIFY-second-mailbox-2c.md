# VERIFY second-mailbox-trinnex — loop 2, lane 2c (C8 defect hunt)
# WHAT:       independent adversarial defect hunt over Huddle PR #150 (second, outside-tenant mailbox via mailboxAccess)
# WHY:        loop 1 was killed by a restart before C8 was reached; two loop-1 defects were fixed (69ee1464, journey 7ad91547)
# SUPERSEDES: nothing (lane 2c of loop 2; loop 1 artifact docs/qc-evidence/VERIFY-second-mailbox-1.md never reached C8)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   git diff origin/main...origin/claude/cool-cannon-q4puke (head 48c34655), file:line cites below

Status: IN PROGRESS

## C8.2 ledger id collisions — CONFIRMED-OK (with one inferred duplicate-alert note)
- Observed: `inboundEmailTurnId(m.id)` = `inbound-email-` + 64-bit FNV-1a of the Graph message id (src/features/huddle/lib/email/inbound-email.ts:142-159). Ledger PK `chat.email_replies.id` = that hash (email-replies.server.ts:36); insert is `ON CONFLICT (id) DO NOTHING` (email-replies.server.ts:108). A Trinnex row can never overwrite/settle a von.ellis@ row: no UPDATE on conflict, and settle is by id of a row this owner already holds.
- Collision needs two distinct Graph ids hashing equal in 64 bits: negligible.
- Inferred (not run): one email addressed/CC'd to BOTH von.ellis@ and @trinnex.io arrives as two Graph messages with different ids -> two ledger rows and two Iris alerts/owed counts. No cross-mailbox dedup (e.g. on internetMessageId). Low.

## C8.3 mail subscription — DEFECT (low) in an edge state; webhook path otherwise unchanged
- Observed: mail-subscription.server.ts is NOT in the PR diff. `ensureMailSubscription` always uses `getAppToken()` (mail-subscription.server.ts:106-108) and `resource: users/${input.mailbox}/...` (:144). inbound-email.server.ts:85-99 passes `mailbox = mailboxes[0]`.
- Observed: `pickOutlookMailboxes` (journey/calendar-mailbox.ts) puts an app-key mailbox first only WHEN ONE EXISTS; with only an outside account active (EnterpriseDS connection is_active=false / disconnected) `mailboxes[0]` is the @trinnex.io address -> app-key subscription POST against another tenant's mailbox. Graph refuses it; ensureMailSubscription never throws, so the run continues, but with no row stored `subscriptionAction` returns "create" every 5-minute tick -> a failing Graph call + error log every run. Contradicts the claim "never tries to subscribe an outside mailbox with the app key". Fix shape is the implementer's call.
- Also observed (pre-existing, not in radius): `subscriptionAction` (mail-subscription.ts:65-78) ignores `row.mailbox`, so a change of MAIN mailbox keeps the old subscription.

## C8.5 remaining getAppToken() uses — CONFIRMED-OK except C8.3
- Observed: getAppToken callers = graph-email.server.ts:233 (mailboxAccess app-key branch), :284 createGraphDraft and :814 sendGraphEmail (both gated to the env allow-list `emailFromOptions()`, not user mailboxes), mail-subscription.server.ts:108 (C8.3), artifacts/onedrive.server.ts:47 (mailbox = data-scope email, not an Outlook connection; untouched by PR).

## C8.6 delegated-token cache keyed only by mailbox — DEFECT (medium; OBSERVED by running the real module)
- Code: graph-email.server.ts `delegatedTokenCache = new Map<string,...>()` keyed by `mb` (lower-cased mailbox); the cache hit (`if (hit && hit.until > Date.now()) return ...`) runs BEFORE the `if (!owner?.trim()) throw` refusal.
- Probe (bun, real `mailboxAccess`, only `journey/proxy.functions` mocked to return `TOKEN-FOR-<caller>`):
  `A: TOKEN-FOR-ownerA@enterpriseds.io | B: TOKEN-FOR-ownerA@enterpriseds.io | no-owner: TOKEN-FOR-ownerA@enterpriseds.io | journey calls: 1`
  -> owner B is served owner A's credential; a call with NO owner is served a token instead of being refused (violates the function's own doc: "without it a non-app-key mailbox is refused rather than guessed").
- Reachability (inferred): needs a second journey user whose connections (or a ledger row's `mailbox`) name the same outside address within the token TTL, in the same server instance. Effectively single-user today, so impact is latent; it is still an authorization bypass in the credential path. Also: a disconnect/revocation in journey is ignored for up to ~58 min (TTL - 120 s).

## C8.4 screenMessage self-filter with per-message mailbox — DEFECT (low; OBSERVED)
- inbound-email.server.ts now calls `screenMessage(m, mode, msgMailbox)`; self = `from === mailbox` only (inbound-email.ts:121).
- Probe: mail FROM von.ellis@enterpriseds.io in the @trinnex.io inbox, mode=all -> `{"keep":true,"reason":"all mode"}`; same mail in the EDS inbox -> `{"keep":false,"reason":"self"}`.
- So the owner's own mail sent between his two connected mailboxes (forward-to-self, CC himself) is announced back to him as inbound mail and recorded as owed; the self-filter does not consider the OTHER connected mailboxes (`mailboxes` is in scope at the call site).
