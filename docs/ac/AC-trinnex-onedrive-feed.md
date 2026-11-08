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

## 2. Snapshot validation (each failure is its own binary AC)

Every row below: the file is REJECTED, last-good is kept, the checkpoint does not advance, zero new
turns / ledger rows are written from it, and the run result carries the named reason code. Observed
via Unit on the validator (one fixture per row) + Run result `trinnex.email.reason` /
`trinnex.calendar.reason`.

| # | Given (one defect, everything else valid) | Expected reason | Wrong answer would be |
|---|---|---|---|
| AC-10 | body is not JSON / truncated JSON | `parse` | FALSE PASS |
| AC-11 | `schema_version` missing, or `"2.0"`, or the number `1` instead of the string `"1.0"` | `schema` | FALSE PASS |
| AC-12 | email file has `feed_type: "appointments_snapshot"` (files swapped), or the appointments file has `"email_snapshot"` | `feed-type` | FALSE PASS |
| AC-13 | `source` is not `"power-automate-outlook"` (email file) | `source` | FALSE PASS |
| AC-14 | `mailbox` differs from `<CFG.mailbox>` — including a different domain, and including the EDS address — compared case-insensitively after trim (`Von.Ellis@Trinnex.io` vs a lower-case config passes; `von.ellis@trinnex.io.evil.example` fails) | `binding` | FALSE PASS |
| AC-15 | `source_login` differs from `<CFG.sourceLogin>`; or appointments `calendar_name` differs from `<CFG.calendarName>` | `binding` | FALSE PASS |
| AC-16 | `complete` is `false`, missing, or the string `"true"` | `incomplete` | FALSE PASS |
| AC-17 | `snapshot.value` missing or not an array | `schema` | FALSE PASS |
| AC-18 | `published_utc` unparseable, or more than 5 min in the future, or `window_start_utc` > `published_utc`, or (appointments) `window_end_utc` <= `window_start_utc` | `timestamps` | FALSE PASS |
| AC-19 | `synthetic: true` while `<CFG.allowSynthetic>` is false; OR `synthetic: false` (live) while config says live data is NOT authorized; OR `synthetic` missing / non-boolean | `synthetic-mismatch` | FALSE PASS (live data ingested without authorization is the worst outcome) |
| AC-20 | record-level: a message with missing/empty `id`, or unparseable `receivedDateTime`; an appointment with missing `id` or unparseable start/end | that RECORD is skipped (`record-invalid`, counted); the other valid records in the same file ARE ingested | FALSE REFUSAL if the whole file is dropped; FALSE PASS if the bad record is announced |
| AC-21 | record count over a configured cap (proposed default: 200 messages / 500 appointments) | `too-many` (file rejected) | FALSE PASS |
| AC-22 | a single message `body` far longer than `BODY_CAP` | accepted; the directive is still <= `DIRECTIVE_MAX` (3900) chars, exactly as for EDS | FALSE REFUSAL / turn failure |

Status distinctions, observed via the run result and the calendar reader's warning field:

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-23 | Given a valid, fresh (`published_utc` within `<CFG.maxAgeMinutes>`), complete file with `snapshot.value: []`, then status is `empty` and calendar readers report NO warning for Trinnex. | edge | Run `trinnex.*.status == "empty"`; reader warning absent |
| AC-24 | Given a valid, complete file whose `published_utc` is older than `<CFG.maxAgeMinutes>`, then status is `stale` (not `empty`, not `ok`), its events are still served, and calendar readers include a warning naming Trinnex and the snapshot age. | edge | Run status; reader warning contains "Trinnex" and an age |
| AC-25 | Given the feed has never once validated (no last-good), then calendar readers report `unavailable` for Trinnex with a warning, and the EDS events are returned unchanged — never an empty-calendar answer that hides the Trinnex gap. | error | Reader output: EDS events deep-equal feed-OFF output; warning present |

## 3. Email: mapping, screening, synthetic gate

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-26 | Given a valid Trinnex record, when mapped, then the `InboundMessage` has `id` = the source-namespaced id (AC-30), `subject`, `receivedDateTime`, `bodyPreview`, `fromAddress`/`fromName` from `from`, `conversationId`, `headerNames` = lower-cased `internetMessageHeaders[].name`, `precedence` / `autoSubmitted` from those headers, and `inferenceClassification` = `null` (ABSENT in the feed; must not be invented as "focused" or "other"). | happy-path | Unit on the mapper with a fixture record |
| AC-27 | Given `isHtml: true`, then `bodyText` is the plain-text rendering (tags and link URLs removed). A body whose ONLY "?" is inside `<a href="https://x.example/p?utm=1">` and which has no ASK phrase yields verdict `no-ask` in `needs-reply` mode. | edge (over-match) | Unit: screenMessage on the mapped record |
| AC-28 | Given `isHtml: true` and a reply whose quoted history (HTML blockquote / "On … wrote:") contains a question while the new text is "Thanks!", then verdict is `no-ask` (quoted history removed before `asksSomething`, as `newTextOnly` does for text). | edge | Unit |
| AC-29 | Given the Trinnex pass, then the SAME `screenMessage` (same mode resolution, default `INBOUND_EMAIL_MODE_DEFAULT` = `needs-reply`) decides every record, and mail FROM either of the owner's addresses (`<CFG.mailbox>` OR `<EDS_MAILBOX>`, case-insensitive) is dropped as `self` in every mode including `all`. There is no second screening function. | happy-path / regression | Unit; grep shows exactly one `export function screenMessage` |
| AC-29a | Given `synthetic: true`, then a record is eligible only if its subject, after trimming leading whitespace, STARTS WITH `<CFG.subjectPrefix>` (case-sensitive); the gate applies in every mode including `all`, and runs BEFORE any ledger write or turn. | happy-path (gate) | Unit: prefix table P-1..P-6 |

### Spelling table — sender / header screening (Trinnex records, mode `needs-reply` unless stated)

Sources: `inbound-email.ts` (AUTOMATED_LOCAL regex, bulk-header rules, self rule, ASK regex);
RFC 3834 §5 (`Auto-Submitted`: `no` = a human sent it; `auto-generated` / `auto-replied` = automated);
RFC 2369 (`List-Unsubscribe`, `List-Id` mark list mail); RFC 2076 (`Precedence: bulk|list|junk`);
RFC 5322 §1.2.2 / §2.2 (header field names are case-insensitive). Body for "asks" rows:
"Can we meet Tuesday?".

| # | Input | Documented by | Expected verdict | Wrong answer would be |
|---|---|---|---|---|
| S-1 | from `noreply@vendor.example`, asks | AUTOMATED_LOCAL | drop `automated-sender` | FALSE PASS |
| S-2 | from `no-reply+billing@vendor.example` (+tag) | AUTOMATED_LOCAL, `+tag` stripped | drop `automated-sender` | FALSE PASS |
| S-3 | from `NoReply@Vendor.Example` (case) | code lower-cases | drop `automated-sender` | FALSE PASS |
| S-4 | from `notifications@github.example` | AUTOMATED_LOCAL | drop `automated-sender` | FALSE PASS |
| S-5 | from `notification@x.example` (singular) | AUTOMATED_LOCAL `notifications?` | drop `automated-sender` | FALSE PASS |
| S-6 | from `von.ellis@trinnex.io` (Trinnex self) | self rule, extended to both owner addresses | drop `self` (also in mode `all`) | FALSE PASS |
| S-7 | from `VON.ELLIS@TRINNEX.IO` | self rule lower-cases | drop `self` | FALSE PASS |
| S-8 | from `von.ellis@enterpriseds.io` arriving in the Trinnex inbox | self rule, both addresses | drop `self` (also in mode `all`) | FALSE PASS |
| S-9 | header `List-Unsubscribe: <mailto:u@x.example>`, person-looking sender, asks | RFC 2369 | drop `bulk-header` | FALSE PASS |
| S-10 | header name spelled `LIST-UNSUBSCRIBE` | RFC 5322 case-insensitive names | drop `bulk-header` | FALSE PASS |
| S-11 | header `List-Id: <team.lists.example>` | RFC 2369 | drop `bulk-header` | FALSE PASS |
| S-12 | header `Auto-Submitted: auto-generated` | RFC 3834 | drop `bulk-header` | FALSE PASS |
| S-13 | header `Auto-Submitted: auto-replied` (out-of-office) | RFC 3834 | drop `bulk-header` | FALSE PASS |
| S-14 | header `Auto-Submitted: no`, real person, asks | RFC 3834 (`no` = human) | KEEP | FALSE REFUSAL |
| S-15 | header `Auto-Submitted: No` (value case) | code lower-cases value | KEEP | FALSE REFUSAL |
| S-16 | header `Precedence: bulk` | RFC 2076 | drop `bulk-header` | FALSE PASS |
| S-17 | header `Precedence: first-class`, person, asks | not bulk/list/junk | KEEP | FALSE REFUSAL |
| S-18 | `amy.c@partner.example`, "Can we meet Tuesday?" | ASK (`?`, `can we`) | KEEP ("from a person and asks something") | FALSE REFUSAL |
| S-19 | `amy.c@partner.example`, "Thanks, see you then." | no ASK | drop `no-ask` (KEEP in mode `people`) | FALSE PASS |
| S-20 | `team.lead@partner.example`, asks | over-match negative: not in AUTOMATED_LOCAL | KEEP | FALSE REFUSAL |
| S-21 | `info.sarah@partner.example`, asks | over-match negative | KEEP | FALSE REFUSAL |
| S-22 | `mailroom@partner.example`, asks | over-match negative: whole-local-part match, `mailroom` != `mailer` | KEEP | FALSE REFUSAL |
| S-23 | `bob@notifications.partner.example`, asks | over-match negative: only the LOCAL part is matched | KEEP | FALSE REFUSAL |
| S-24 | subject `Invitation: Design review`, person, no "?" | INVITE_SUBJECT | KEEP | FALSE REFUSAL |
| S-25 | no `internetMessageHeaders` key, person, asks | missing headers must not crash or drop | KEEP | FALSE REFUSAL |
| S-26 | `from` missing entirely | `isAutomatedAddress("")` is true | drop `automated-sender`, no throw | FALSE PASS |
| S-27 | mode `all`, `noreply@vendor.example` | mode `all` keeps all but self | KEEP (still subject to the synthetic prefix gate) | FALSE REFUSAL |
| S-28 | body text `echo "noreply@vendor.example"` from a real person, asks | over-match negative: an address in the BODY is not the sender | KEEP | FALSE REFUSAL |

### Spelling table — synthetic subject prefix (feed `synthetic: true`, example prefix `[TEST]`)

| # | Subject | Expected | Wrong answer would be |
|---|---|---|---|
| P-1 | `[TEST] Can we meet?` | eligible (then screened) | FALSE REFUSAL |
| P-2 | `   [TEST] Can we meet?` (leading spaces) | eligible | FALSE REFUSAL |
| P-3 | `[test] Can we meet?` (case differs) | NOT eligible | FALSE PASS |
| P-4 | `Can we meet? [TEST]` (prefix not at start) | NOT eligible | FALSE PASS |
| P-5 | `RE: [TEST] Can we meet?` | NOT eligible (proposed default; Gap G-3) | FALSE PASS |
| P-6 | empty / null subject | NOT eligible, no throw | FALSE PASS |

## 4. Email: source-aware identity, once-per-email, ledger, Save/Dismiss

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-30 | Given the SAME raw id string `X` arriving once from EDS Graph and once from the Trinnex feed, then the two turn ids differ, the two ledger ids differ, and neither equals `inboundEmailTurnId(X)` computed the other way (e.g. the Trinnex id hashes a source-namespaced key such as `trinnex:` + `X`). EDS turn ids for EDS messages stay EXACTLY `inboundEmailTurnId(graphId)` (unchanged formula). | happy-path / regression | Unit: compute both; assert inequality; assert EDS id equals current formula |
| AC-31 | Given a Trinnex record already announced, when the same snapshot is re-read (unchanged eTag, or changed eTag because a different record was added, or a 12h-lookback re-read), then no second turn is enqueued and no second push fires for it (`enqueueTurn` returns not-fresh). | happy-path (dedupe) | DB: `chat.pending_turns` count for that id == 1; push spy count == 1 |
| AC-32 | Given a Trinnex turn id, then it does not match `^u-\d+$` and does not start with `xapp-` (those render as a "You" bubble). | regression | Unit regex |
| AC-33 | Given a kept Trinnex record, then `recordOwedEmail` writes one `chat.email_replies` row with `mailbox` = `<CFG.mailbox>` and a field that marks the source as Trinnex (a new column or an unambiguous id/mailbox convention), owner key = `resolveTaskEmail(caller)` (same as EDS), status `owed`; the owed count in the next directive includes it. | happy-path | DB row; directive text contains the incremented owed count |
| AC-34 | Given a Trinnex owed row, when the run reconciles (`reconcileRepliedFromSentItems`), then NO Graph request is made for that row (no `/users/<CFG.mailbox>/…` URL at all), the row stays `owed`, and EDS rows reconcile exactly as before. | error (no wrong-tenant call) | Spy: zero Graph URLs containing the Trinnex mailbox; EDS settle count unchanged vs feed-OFF |
| AC-35 | Given a Trinnex alert turn, then the reply card renders Dismiss and NOT "Save to Drafts" (no Edit-first draft button either), and the directive does NOT tell the owner to tap Save to Drafts; it says a draft cannot be saved to the Trinnex mailbox from Huddle yet. | happy-path (no write path) | UI test / Playwright on a seeded Trinnex turn; directive string assertions |
| AC-36 | Given a crafted call `saveEmailReplyDraftFn({emailId: <trinnex ledger id>})` (button hidden but the server fn hit directly), then it returns an explicit refusal (ok:false with a reason naming Trinnex), makes ZERO Graph calls (`createReplyDraftForMessage` not invoked), and the row status stays `owed`. | error (server-side gate, not UI-only) | Spy on createReplyDraftForMessage call count == 0; DB status |
| AC-37 | Given a Trinnex owed row, when `dismissEmailReplyFn` is called, then the row becomes `dismissed`, the owed count drops by 1, and no Graph call is made. | happy-path | DB status; counts fn |
| AC-38 | Given a Trinnex alert, then the phone push title follows the existing `inboundEmailPush` shape ("New email from <name> …", sticky) — no new sender, no new channel; and `ensureMailSubscription` is NOT called for the Trinnex mailbox (no Graph subscription on another tenant). | regression | Push spy payload; spy on ensureMailSubscription args |
| AC-39 | Given 4 EDS and 4 Trinnex kept messages in one run, then the per-run cap is enforced deterministically and documented (proposed default: one shared cap of `MAX_PER_RUN` = 5 across both sources, oldest first by `receivedDateTime`); the undelivered ones are delivered on the next run, none lost, none duplicated. | edge | Run `delivered` count; second run delivers the remainder |
| AC-40 | Given a Trinnex record whose `receivedDateTime` is older than the watch lookback (`INBOUND_EMAIL_LOOKBACK_HOURS_DEFAULT` = 12h, or the run's `lookbackHours`), then it is not announced (the same window as EDS). | edge | Unit with nowMs fixed |

## 5. Calendar: merge into every reader

Readers: `meetingsForDate` (schedule brief + lookahead + T-60 seed ids via `BriefItem.sourceId`),
`get_external_calendar_events` in `voice/realtime-tools.server.ts` and in BOTH
`huddle.functions.ts` dispatch sites, and the tool descriptions in `calendar/tools.ts`.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-41 | Given feed ON with one valid Trinnex appointment in the window, then EACH of the four call sites returns the EDS events unchanged (same order, same fields, deep-equal to a feed-OFF run with the same mocked Graph) PLUS the Trinnex event, which is labelled by source (e.g. `source: "trinnex"`) so the agent can say which calendar it is on. | happy-path | Unit/integration per call site with mocked Graph + mocked drive |
| AC-42 | Given a Trinnex appointment, then its `CalendarEvent.id` (and therefore `BriefItem.sourceId`, the T-60 key) is source-namespaced, can never equal any EDS Graph event id, and is IDENTICAL across two refreshes of the snapshot in which that appointment is unchanged or only moved/renamed. | happy-path / dedupe | Unit: two snapshots, same appointment id, different subject/start -> same id |
| AC-43 | Given a recurring Trinnex series with two occurrences in the window, then two events with two distinct ids are returned, each stable across refresh. | edge | Unit |
| AC-44 | Given the EDS Graph read fails (e.g. 403 missing Calendars.Read), then the Trinnex events are still returned AND the EDS error is still surfaced exactly as today (not swallowed by the Trinnex success). Conversely, a Trinnex failure never changes the EDS result or turns an EDS success into an error. | error / regression | Per call site: result contains Trinnex events + the existing EDS error string |
| AC-45 | Given a Trinnex appointment with `isAllDay: true` on 2026-11-10, then it maps to `isAllDay: true`, `meetingsForDate` renders it with `startIso: null` and `day: "2026-11-10"` (no midnight-UTC shift to the 9th in America/New_York). | edge | Unit on meetingsForDate output |
| AC-46 | Given `organizer`, `location` in the record, then `CalendarEvent.organizer` / `location` are populated the same way the Graph mapper does (name, else address; displayName trimmed, else null); `subject` empty -> `(no subject)`. | happy-path | Unit |

### Time zone (the format trap: Graph returns OFFSET-LESS wall times in the zone named by the Prefer header, and `meetingsForDate` asks for UTC then pins with `graphUtcToIso`)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-47 | Given a Trinnex event at 09:00-09:30 America/New_York on 2026-11-09 (EST, UTC-5), when read with `timeZone: "UTC"`, then `start` represents 14:00 UTC on 2026-11-09 and `graphUtcToIso(start)` == `2026-11-09T14:00:00.000Z` (or `…T14:00:00Z`). | happy-path | Unit on mapped event + graphUtcToIso |
| AC-48 | Same event read with `timeZone: "America/New_York"` -> `start` wall time `2026-11-09T09:00:00` (offset-less, matching Graph's own format so every consumer formats it the same). | happy-path | Unit |
| AC-49 | DST: an event at 09:00 America/New_York on 2026-07-15 (EDT, UTC-4) read in UTC -> 13:00 UTC; on 2026-10-31 (EDT) -> 13:00 UTC; on 2026-11-01 (the day DST ends, EST) -> 14:00 UTC; on 2026-03-08 (DST starts) 09:00 -> 13:00 UTC. | edge (DST) | Unit, four fixtures |
| AC-50 | Given the source record carries only `start`/`end` WITHOUT offset plus `startWithTimeZone`/`endWithTimeZone` WITH offset, then the instant is taken from the offset-bearing field; an offset-less source value is never re-read as server-local or as UTC by accident (the 4-5 hour-early defect `graphUtcToIso` documents). | error | Unit: fixture with the two fields disagreeing in format |
| AC-51 | Given `meetingsForDate("2026-11-09", "America/New_York", …)`, then the Trinnex event's `day` is `2026-11-09` and it is briefed on that day; an event at 23:30 America/New_York on 2026-11-09 (04:30Z on the 10th) is still briefed on the 9th. | edge | Unit |

### Window overlap (window = the requested [start, end), half-open, as Graph calendarView treats it)

| # | Event vs requested window W=[10:00,11:00) | Expected | Wrong answer would be |
|---|---|---|---|
| AC-52 | event 09:00-10:00 (ends exactly at W.start) | excluded | FALSE PASS |
| AC-53 | event 11:00-12:00 (starts exactly at W.end) | excluded | FALSE PASS |
| AC-54 | event 09:30-10:15 (starts before, ends inside) | included | FALSE REFUSAL |
| AC-55 | event 10:45-11:30 (starts inside, ends after) | included | FALSE REFUSAL |
| AC-56 | event 08:00-13:00 (spans W entirely) | included | FALSE REFUSAL |
| AC-57 | zero-length event at 10:30 | included | FALSE REFUSAL |
| AC-58 | Given the requested range extends beyond the snapshot's [`window_start_utc`, `window_end_utc`], then events in the covered part are returned AND a warning says the Trinnex calendar is not covered for the uncovered part — never a silent "nothing scheduled" for that part. | error | Reader warning present; covered events present |

## 6. Feed OFF — byte-for-byte unchanged

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-59 | Given the feed disabled OR any required key unset, when the inbound watch runs with a fixed mocked Graph inbox, then the returned `InboundEmailRunResult` JSON is byte-identical to the pre-change output for the same inputs (no added keys, including no `trinnex` key), the enqueued turn ids and payloads are identical, and directive strings are identical. | regression | Golden-file test: serialize result + payloads, compare against a fixture captured at `c80288f5` |
| AC-60 | Given feed OFF, then ZERO requests are made to any `/drive/` URL, and no checkpoint/eTag storage is read or written. | regression | Spy; DB/table untouched |
| AC-61 | Given feed OFF, then each of the four calendar call sites returns output deep-equal to pre-change for the same mocked Graph response, including the error branches (Graph not configured; 403). | regression | Golden outputs per call site |
| AC-62 | Given feed OFF, `bun scripts/inbound-email.test.ts` and the existing schedule-brief / router suites pass unchanged (no edited expectations). | regression | test runner output; `git diff` of existing test files shows additions only |

## 7. Performance and reliability (proposed defaults — confirm)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-63 | Given the drive GET hangs, then it is aborted at <= 10 s per file and the EDS pass still finishes in the same run; the whole watch run with feed ON adds <= 15 s over feed OFF in the worst case. | performance | Timed unit with a never-resolving fetch mock |
| AC-64 | Given a calendar reader call (voice or chat), then the Trinnex contribution is served from the last validated snapshot without re-downloading when the eTag is unchanged, adding <= 1 s at p95 on an unchanged file. | performance | Timed run; Spy shows a 304 / no content GET |
| AC-65 | Given the watch fires every five minutes and the file is unchanged, then each run costs at most one conditional metadata/content request per file (no content download). | performance | Spy request count per run |

## Goal -> AC coverage

- "Trinnex mail reaches Iris like EDS mail does, once" -> AC-1, AC-26, AC-29, AC-31, AC-33, AC-38, AC-39, AC-40
- "Only real people asking something; never my own mail, bulk or robots" -> AC-27..AC-29a, S-1..S-28
- "Synthetic only until I authorize live" -> AC-19, AC-29a, P-1..P-6
- "Trinnex never gets confused with EDS (ids, drafts, reconciliation)" -> AC-30, AC-32, AC-34..AC-37, AC-42
- "Trinnex meetings appear in my brief, reminders and calendar answers, in the right time" -> AC-41..AC-51
- "A broken or old feed is said out loud, never shown as an empty day" -> AC-5, AC-6, AC-23..AC-25, AC-44, AC-58
- "Nothing I have today changes" -> AC-6, AC-30, AC-41, AC-44, AC-59..AC-62
- "No private data in public logs; no new secret; read-only" -> AC-1, AC-2, AC-7, AC-8
- Every AC traces to a goal above; no orphans found.

## Gaps / open questions for the owner

- G-1 Where the eTag checkpoint and last-good snapshot live (a new small table vs an existing store).
  Either works for these ACs; it must survive a process restart (SWA cold start), so in-memory alone
  does NOT satisfy AC-4/AC-5.
- G-2 Per-run cap: one shared cap of 5 across both sources (proposed) vs 5 per source.
- G-3 Synthetic prefix and replies: should `RE: [TEST] …` count? Proposed default NO (P-5), because a
  wrong YES lets non-test mail through before live data is authorized.
- G-4 The same meeting on both calendars (same `iCalUId`): show both labelled (proposed, no data loss)
  or merge into one; and whether one or two T-60 reminders fire. Needs a decision before T-60 seeding.
- G-5 Stale threshold `<CFG.maxAgeMinutes>`: the feed refreshes only on source events, so an idle
  file can be legitimately old. The email side should NOT warn on age; the calendar side needs a
  threshold (proposed 24 h) or a "no change since" phrasing rather than a warning.
- G-6 Sent-items reconciliation for Trinnex is impossible without a feed of Sent Items, so Trinnex owed
  rows settle only by Dismiss. Confirm that is acceptable, or add a sent-items snapshot later.
- G-7 The T-60 seeder that consumes `BriefItem.sourceId` was not found by grep in `src/` at
  `c80288f5` (only the producers). AC-42 is written against `sourceId`; the implementer must name the
  consumer, or confirm none exists yet.
- G-8 The instant-alert route (`mail-subscription.server.ts`) has no Trinnex equivalent; Trinnex
  alerts arrive on the five-minute tick only. Confirm acceptable.
