# VERIFY-second-mailbox-3b
# WHAT:       Independent verifier loop 3, lane 3b: C3, C4, C5, C8, F-cache for the second-mailbox (Trinnex) work.
# WHY:        Loop 2 (2b #1, 2c #1) REFUTED F-cache: delegatedTokenCache keyed by mailbox only, consulted before the no-owner refusal. Fix claimed in a62e6db8; journey 229baa56 rewrote the AADSTS regex.
# SUPERSEDES: nothing (loop-2 lane files VERIFY-second-mailbox-2b/2c remain the loop-2 record).
# SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   huddle origin/claude/cool-cannon-q4puke @ c5a38800; journey origin/claude/cool-cannon-q4puke @ 229baa56. Commands and outputs inline below.

Started 2026-11-06 15:17 UTC. Budget 15 min.

## F-cache — CONFIRMED (observed, mutation-proved)
Code at head (graph-email.server.ts:237-283): no-owner throw at :247 now precedes the cache read; cacheKey = `${owner.trim().toLowerCase()}|${mb}` (:250), same key on set (:281).
Independent probe (scratchpad scripts/zz-probe-fcache.ts, real mailboxAccess, journey + login.microsoftonline mocked via fetch):
- FIXED code: A1/A2_warm -> TOK[a|shared]; B -> TOK[b|shared] (own mint); none/blank("   ")/empty -> THREW "outside EnterpriseDS and no owner"; B_warm -> TOK[b|shared]; mints=3.
- PRE-FIX code (48c34655 file swapped in): B, none, blank, empty, B_warm ALL -> TOK[a|shared]; mints=2. So the probe detects the defect; fix removes it.
Other caches checked: identity.ts calendarMailboxCache keyed by caller login (:152) — returns mailbox NAMES only, and any mailbox it yields is still minted under the caller's own owner (journey scopes to caller user, see C5). No other token cache (grep new Map / access_token in src).
Informational (inferred, negligible): key uses "|" separator; an owner/mailbox pair containing "|" could alias, but owner is server-resolved entra_email, not model input.
