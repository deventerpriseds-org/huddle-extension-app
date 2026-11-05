# VERIFY second-mailbox-trinnex, loop 2, lane 2a (C1, C2, C6, C7)
# WHAT:       Independent verifier verdicts for claims C1, C2, C6, C7 of PR #150 (second mailbox via mailboxAccess).
# WHY:        Loop 1 REFUTED C1 (Dev@EnterpriseDS.io would also be merged); fix claimed in 69ee1464. Loop 1 was killed by a restart.
# SUPERSEDES: nothing (loop 1 artifact VERIFY-second-mailbox-1.md covers loop 1; lanes 2b/2c cover C3-C5, C8).
# SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   origin/claude/cool-cannon-q4puke @ 48c34655; diff vs origin/main; bun scripts/*.test.ts output below.

Started 2026-11-05T22:50Z. Budget 15 min.

Budget hit at 23:13Z (23 min, over the 15 min budget). C6/C7 were only partly read; marked below.

## Suites (branch tree archived from origin/claude/cool-cannon-q4puke @ 48c34655, node_modules symlinked)
OBSERVED: second-mailbox all passed (A1-A8, B1-B3, C1-C7); inbound-email 69/0; schedule-brief 76/0;
mail-subscription 24/0; journey-calendar-edit-exposure 13/0 rc=0; ownership-judge ALL PASS rc=0.
journey `npm test`: NOT re-run (outside lane).

## C1 -- CONFIRMED (observed)
- Independent harness (scratchpad c1.ts) imported origin/main's pickOutlookMailbox and the branch's
  pickOutlookMailboxes. Fed today's real rows (office365 Von.Ellis@ active, outlook Dev@ active, google inactive)
  in 4 orders: branch returns exactly ONE mailbox, and it is identical to main's pick every time
  (von.ellis@ or dev@, depending on journey row order, the same as on main).
- calendar-mailbox.ts:55-56 now keeps only the FIRST app-key mailbox, so Dev@ is no longer merged (loop-1 defect fixed by 69ee1464).
- One mailbox, so each changed caller takes its single-mailbox branch: getOwnerCalendarEvents `if (!extra.length) return first`;
  runInboxReadTool search `if (!extra.length) return {...first}`; the read loop over 1 mailbox returns the same r;
  createDraftForTool tries the one mailbox, then a plain draft in mailboxes[0] with replyFallback=r.error; schedule brief
  extraMailboxes=[]; inbound tagged[] is empty when the main read fails, so the error path is unchanged.
- mailboxAccess for an EDS mailbox (graph-email.server.ts:232-233) = getAppToken() + `${GRAPH}/users/${encodeURIComponent(mailbox.trim())}`,
  the same token type and URL as main's per-function `getAppToken()` + `/users/${encodeURIComponent(mailbox)}` (picker output is already trimmed and lower-cased).
- Fallback mailbox defaultFrom() = HUDDLE_EMAIL_FROM ?? dev@enterpriseds.io (graph-email.server.ts:94), which is EDS, so it uses the app key.
  HUDDLE_GRAPH_APP_DOMAINS is not set anywhere in .github, so the default domain list is used.
- Minor difference (observed, harmless): getOwnerCalendarEvents `.catch(()=>[])` turns a resolver throw into a read of entra_email instead of an exception.

## C2 -- CONFIRMED (observed), caveats
- Harness: Trinnex listed first next to an active EDS row -> EDS is main in every order; Trinnex alone -> main (by design).
- is_active null or the string "false" counts as active (only boolean false is dropped), same as main.
- Caveat 1: EDS row inactive, or its provider is not office365|outlook|microsoft|azure (e.g. google) -> Trinnex becomes main.
  "Connected" means active Microsoft only.
- Caveat 2: a subdomain such as a@mail.enterpriseds.io is NOT app-key (exact-domain match, calendar-mailbox.ts:27-28), so it takes the delegated path.
  It is never main while a bare-domain EDS row exists. Not in today's data.

## C6 -- UNPROVEN (code read only, nothing executed)
- Observed in code: every extra-mailbox loop checks r.ok and logs/skips on failure (inbound-email.server.ts:112-116;
  getOwnerCalendarEvents graph-email.server.ts:697-701; search 1051-1055; schedule-brief.server.ts:340-344). mailboxAccess throws are caught
  inside each per-mailbox function, which returns ok:false. Main is read first, and its result decides ok/error.
- INFERRED risk, not tested: extras are awaited serially with no per-call timeout. An extra Graph/journey call that HANGS
  (rather than errors) delays the main inbox's alerts (delivered after the loop) and the main calendar/search reply, possibly to the hosting ceiling.
- INFERRED: read_email walks the mailboxes main-first and returns the FIRST failure, so a main-mailbox miss followed by an extra error reports the main error.

## C7 -- NOT REACHED at full depth (partial read)
- Observed: email-replies.functions.ts:66-71 saveEmailReplyDraftFn uses row.mailbox (the ledger) + owner: row.owner_email, so the Approve-draft button follows the ledger.
  inbound-email.server.ts:167 records `mailbox: msgMailbox` (the mailbox the message was read from).
- Observed: the MODEL tool path createDraftForTool (graph-email.server.ts:548-580) does NOT consult the ledger. It tries every
  connected mailbox main-first by sender address. A sender who mailed both mailboxes gets the reply drafted in the MAIN mailbox,
  even if the email in question arrived in Trinnex (INFERRED from the code, not executed).
- NOT tested: whether owner_email (= resolveTaskEmail, dev@) resolves in huddle-proxy to the journey user that owns the Trinnex row.
