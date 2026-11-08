<!--
WHAT:          Binary acceptance criteria for the Trinnex OneDrive feed: a SECOND, read-only source
               (Power Automate JSON snapshots in the owner's EDS OneDrive) for the owner's Trinnex
               inbox and one Trinnex calendar, merged into the existing inbound-email watch and every
               calendar reader without changing the EDS Graph path.
WHY:           Huddle's app-only Graph key cannot read the Trinnex tenant. Written cold by an
               independent AC subagent BEFORE implementation (Tier 1: the change admits outside data
               into the owed-reply ledger and the screening gate that decides what reaches the owner).
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      code read at origin/main c80288f5 (files listed under "Sources read").
-->

# Acceptance Criteria — Trinnex OneDrive feed (email + calendar, second source)

Task: add a server-configured, read-only OneDrive JSON feed as a second source for the owner's
Trinnex mailbox and one Trinnex calendar; feed it through the SAME inbound-email watch, screen,
ledger, turn and push, and merge its appointments into every calendar reader, with zero change to
EDS results and byte-for-byte unchanged behaviour when the feed is off.

Sources read (origin/main `c80288f5`):
- `src/features/huddle/lib/email/inbound-email.ts` (InboundMessage, screenMessage, isAutomatedAddress,
  asksSomething, inboundEmailTurnId, inboundEmailDirective, inboundEmailPush)
- `src/features/huddle/lib/email/inbound-email.server.ts` (runInboundEmailWatch, MAX_PER_RUN=5,
  reconcile-before-announce, ensureMailSubscription, emailReplyRef payload)
- `src/features/huddle/lib/email/email-replies.server.ts` (chat.email_replies ledger: recordOwedEmail,
  OWED_STATUSES, settleEmailReply, reconcileRepliedFromSentItems -> hasSentReplyInConversation)
- `src/features/huddle/lib/email/email-replies.functions.ts` (saveEmailReplyDraftFn ->
  createReplyDraftForMessage(row.mailbox, row.graph_message_id); dismissEmailReplyFn)
- `src/features/huddle/lib/email/graph-email.server.ts` (getAppToken, listInboxMessagesSince,
  CalendarEvent, getGraphCalendarEvents — returns offset-less wall times in the Prefer timezone)
- `src/features/huddle/lib/tasks/schedule-brief.server.ts` (BriefItem.sourceId = T-60 key,
  meetingsForDate asks Graph in UTC, graphUtcToIso, localDayBoundsUtc DST two-pass)
- `src/features/huddle/lib/calendar/tools.ts` (get_calendar_events alias vs get_external_calendar_events)
- call sites of getGraphCalendarEvents: `voice/realtime-tools.server.ts:585`,
  `huddle.functions.ts:4811`, `huddle.functions.ts:6380`, `tasks/schedule-brief.server.ts:326`
- `components/HuddleView.tsx` (Save to Drafts card at ~886-991)

Existing systems this EXTENDS (not duplicates):
- the inbound-email watch (`runInboundEmailWatch`) — no second watcher, no second scheduler job type,
  no second cron;
- `screenMessage` / `INBOUND_EMAIL_MODE_DEFAULT` — no second screening function;
- the `chat.email_replies` owed ledger + durable turn + Iris + existing push (`inboundEmailPush`);
- the Graph app token (`getAppToken`) — no new secret, no new app registration;
- `CalendarEvent` and the existing calendar readers — no parallel calendar type or tool.

Placeholders used below (never real ids — this repo is public):
`<CFG.driveOwner>`, `<CFG.emailPath>` (= `/automation/email/emails.json`),
`<CFG.apptPath>` (= `/automation/appointments/appointments.json`), `<CFG.mailbox>` (the Trinnex
address), `<CFG.sourceLogin>`, `<CFG.calendarName>`, `<CFG.subjectPrefix>`, `<CFG.allowSynthetic>`,
`<CFG.maxAgeMinutes>`, `<CFG.maxBytes>`, `<EDS_MAILBOX>` (the resolved EDS Outlook mailbox).

Notation: "feed ON" = config fully present and enabled; "feed OFF" = disabled or any required key
missing. "Observed via" names the check. Unit = a pure-function test run with `bun`; Run = the
watch/route result object; DB = a `chat.email_replies` / `chat.pending_turns` query; Spy = a fetch
spy/mocked fetch recording every outbound URL.

---

## 1. Configuration and the OneDrive read

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-1 | Given feed ON, when the watch runs, then exactly one GET is issued per feed file to Graph `/users/<CFG.driveOwner>/drive/root:<path>` (content or item+content) carrying `Authorization: Bearer <token from getAppToken()>`; no other token source, client id or secret is read. | happy-path | Spy: URL host `graph.microsoft.com`, path contains the configured path; token equals getAppToken's mocked return |
| AC-2 | Given a request payload / job body / tool args containing `driveOwner`, `path`, `mailbox` or `sourceLogin` keys with attacker values, when the feed is read, then the outbound URL and the binding check use ONLY the server config values; the payload values appear in no outbound URL. | error (injection) | Spy URL equals config-derived URL; Unit with a payload carrying `driveOwner: "evil@x"` |
| AC-3 | Given feed ON and a prior successful read that stored eTag `E1`, when the next run reads, then the request carries `If-None-Match: E1` (or an equivalent cTag/eTag compare on item metadata before downloading content); on `304`/unchanged eTag no content download occurs and no new turn, ledger row or calendar change results. | happy-path (change check) | Spy: header present; content endpoint call count 0 on 304; DB row count unchanged |
| AC-4 | Given the file changed (new eTag `E2`) and the new JSON passes validation and ingestion completes, then the stored checkpoint becomes `E2` AFTER ingestion; given ingestion throws mid-way (e.g. enqueueTurn rejects on message 2), then the stored checkpoint stays `E1`, and the next run re-reads `E2` and announces the not-yet-announced records exactly once (already-announced ones are deduped by turn id, AC-31). | regression / error | Unit with a throwing enqueueTurn; inspect stored checkpoint before/after; second run delivers only the remainder |
| AC-5 | Given a validation failure on `E2` (any of §2), then the checkpoint stays `E1`, the last-good snapshot (from `E1`) remains what calendar readers serve (flagged stale per AC-28), and the run result reports `trinnex.status = "invalid"` with a machine reason code — never `ok:true` with zero items. | error | Run result field; calendar reader returns E1 events + warning |
| AC-6 | Given the OneDrive GET returns 403/404/5xx or the network throws, then the watch still completes the EDS pass (EDS messages still screened and delivered as today), returns `trinnex.status = "unreachable"` with the HTTP status code only, and throws nothing. | error / regression | Run result: EDS `decisions` identical to a feed-OFF run with the same mocked Graph inbox; `trinnex.status` set |
| AC-7 | Given any Trinnex failure, then the run result, console output and any GitHub Actions log contain no Trinnex mailbox address, drive owner, subject, sender name, body, or file content — only status, reason code, HTTP code, counts and sender DOMAIN (the same public-log discipline `InboundEmailRunResult.decisions` already follows). | error (privacy) | grep the JSON result and captured console for `@` addresses other than domains; must be 0 |
| AC-8 | Given feed ON, then no code path WRITES to the drive (no PUT/PATCH/POST/DELETE to any `/drive/` URL) during read, validation, ingestion, Save, or Dismiss. | regression (read-only) | Spy: methods on `/drive/` URLs ⊆ {GET} |
| AC-9 | Given a file larger than `<CFG.maxBytes>` (by `size` metadata or Content-Length, or by bytes read), then it is rejected as `too-large` BEFORE `JSON.parse`, the checkpoint does not advance, and last-good is kept. | edge / error | Unit with an oversized body; JSON.parse spy not called |

