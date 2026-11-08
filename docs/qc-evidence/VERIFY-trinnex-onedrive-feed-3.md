# VERIFY-trinnex-onedrive-feed-3
# WHAT:       Independent verifier loop 3 for the OneDrive feed PR (claude_trinnex-onedrive-feed).
# WHY:        Loop 1 refuted D1..D10; loop 2 was killed by an interrupt. This loop re-derives the fixes (7f59c9a1),
#             the owner-directed self-rule removal (d186cf12) and the new config workflow (19720b4c).
# SUPERSEDES: VERIFY-trinnex-onedrive-feed-2.md (killed, treat as not run)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   tested head d186cf12 (detached from origin/claude_trinnex-onedrive-feed)

## Claims

### Suites (observed, head d186cf12)
- onedrive-feed.test.ts: all passed | inbound-email.test.ts: 69/0 | schedule-brief: 76/0 | schedule-brief-dedupe: 21/0
- mail-subscription: 24/0 | ownership-judge: ALL PASS | journey-calendar-edit-exposure: 13/0 | tsc --noEmit: rc=0

### Fix re-derivation (observed unless marked)
- D1 CONFIRMED: graph-permission-check FEED_CONFIG = `inputs.feed_dry_run && secrets.HUDDLE_ONEDRIVE_FEEDS`; old feed_config/own_addresses inputs removed. Residual (inferred, low): section-6 dry run prints sender DOMAINS per record; with live mail, internal senders reveal the work-mailbox domain. Secret masking covers the whole JSON string only.
- onedrive-feed-config.yml CONFIRMED no private value printed: inputs are public EDS values; token/mailbox/source_login masked before use and never echoed; only config KEYS printed; python errors print no data.
- D2 CONFIRMED: propose_email_reply adds draftable:false when isFeedId(row.graph_message_id); graphMessageId is stored from m.id (feed: prefix); email-reply-ask parses it; HuddleView renders copy-only; server draft path also refuses feed ids.
- D3 CONFIRMED: getOwnerCalendarEvents keeps feed events on EDS failure with ok:false/error; meetingsForDate keeps items and returns error; buildBrief pushes `meetings: <error>` and keeps items.
- D4 PARTIAL: id-less / array records dropped and `skipped` set (probe: 4 records -> recs=2 skipped=2), but nothing reads `skipped` (no log/warning) -- the count is dead data.
- D5 PARTIAL: reply header tail, blockquote and URL query strings dropped (probe H1/H2/H3). Nested blockquote leaks the outer quote's tail: `<blockquote>a<blockquote>b?</blockquote>c?</blockquote>` -> "c?" survives. EDS path does not call htmlToText (only mapFeedMessage does).
- D7 CONFIRMED: wrong/case-different source -> wrong_source; live config refuses synthetic true/missing/"false"; published >10 min ahead -> bad_timestamps (5 min ok); email window_start > published -> bad_timestamps.
- D8 CONFIRMED (code): >7d-old calendar snapshot adds warning. D9 CONFIRMED (code): one AbortSignal.timeout(10s) shared by metadata + content.
- Self rule (d186cf12) CONFIRMED against new intent: verdict = screenMessage(m, mode, msgMailbox) for both sources; isFromOwner removed everywhere (grep: no references).
- Flood: notBefore drops pre-enable mail (probe: 02:59 dropped, 03:01 kept, duplicate id deduped); MAX_PER_RUN=5 shared across EDS+feed, checked before recordOwedEmail; turn id = inboundEmailTurnId(m.id) (once per email). CONFIRMED.

### Re-graded ACs
- AC-29 / S-6..S-8 (re-graded to owner intent d186cf12): probe of screenMessage(m, mode, workMailbox): work address -> self (default and all), upper-case work address -> self, EDS address into the work mailbox -> kept "from a person and asks something" (all mode: kept). CONFIRMED against new intent. Side effect the owner accepted: his own EDS->work forwards/CCs that ask something will be announced.
- AC-44 CONFIRMED: brief and both get_external_calendar_events paths return feed events + the EDS error (ok:false); the model receives JSON.stringify(r) with both.
- AC-35 PARTIAL (letter) / UI-UNVERIFIED: card for a feed email renders Copy reply + Edit first + No reply needed, no Save to Drafts; directive says "Do NOT mention Save to Drafts". AC text also says no Edit-first button; Edit first remains, but it only prefills a revision, which now re-renders with draftable:false (no draft path). Not observed in a browser.
- D6 still present (code): object `start {dateTime, timeZone:"Eastern Standard Time"}` with no startWithTimeZone is read as UTC (windowBoundMs). Bites only if the live flow omits startWithTimeZone -- not determinable from public evidence.
- D10 unchanged; mitigated by last-good re-read + once-per-email turn ids.
- Regression baseline: live app / browser golden path NOT RUN (no UI change outside the email card; no browser run in this loop).
