# Fireflies → meeting minutes email + OneDrive transcript

Huddle receives Fireflies Webhooks V2 at `/api/public/fireflies-webhook`. For each signed
`meeting.transcribed` delivery it fetches the meeting from Fireflies GraphQL. It then does two
independent things at the same time; either one can fail without stopping the other:

1. **Emails meeting minutes** through Huddle's existing Graph mail sender (`sendGraphEmail`), in the
   mode chosen in **Settings → Account → Meeting minutes**:
   - **Fireflies summary** (default). Uses the custom summary sections Fireflies exposes
     (`summary.extended_sections`) when present. Otherwise it uses Fireflies' standard summary, and the
     email says so at the top, so it never claims the custom template was used.
   - **Luna from transcript.** Sends the full timestamped transcript to the `gpt-5.6-luna` tier through
     `callOpenAIResponses`, with the five-section minutes template (Focus / Summary / Questions /
     Decisions / Action Items, `lib/fireflies/minutes.ts` `MINUTES_INSTRUCTIONS`). A reply missing any
     section is not emailed.

   For either mode, the email subject is `Meeting Minutes: {theme} MM/DD/YYYY, hh:mm AM/PM` in America/New_York. Huddle derives the theme from the Focus section (explicit theme label first, then its first agenda heading), then falls back to the meeting title. Fireflies' custom `Agenda` section is normalized to `Focus`; its standard outline is also labeled `Focus`.

   Neither mode ever falls back to the other. If the selected mode's data is missing, no email is sent.
   The reason (`fireflies_summary_missing`, `transcript_missing`, `luna_*`) is recorded on the meeting
   row and shown in the Settings panel under *Recent meetings*.
2. **Saves the transcript** as Markdown to OneDrive `/Automation/transcripts/fireflies-{meeting_id}.md`
   in `FIREFLIES_ONEDRIVE_MAILBOX`'s drive. The stable path means a retry or resend overwrites the same
   file.

## Recipients

Recipients are configurable in the Settings panel. The default is the owner's own linked addresses
(`identity.profile_emails`) that Huddle's existing send gate (`lib/email/self-send-gate.ts`) will send
to automatically. Any other address makes the gate refuse the whole send. The panel warns about such an
address before it is saved as a recipient, and the meeting row records the refusal. No address is
hard-coded in client code.

## Retries and resends (idempotency)

`chat.fireflies_meetings` is both the work queue and the record: deliveries seen, minutes source, email
status / recipients / error, OneDrive path / status, a hash of the meeting **input** (transcript + summary),
`pending_email` / `pending_onedrive`, attempts and a per-meeting **lease**.

- **One worker per meeting.** A heartbeat leases a meeting for 3 minutes (`FOR UPDATE SKIP LOCKED`), so two
  heartbeats never work the same meeting; a crashed worker's lease simply lapses and the meeting is retried.
- **Retry of a delivery** (same or no `reprocessed_at`) queues nothing new: no second email, no re-upload.
- **Resend** (`reprocessed_at` newer than stored, Fireflies' documented rule) re-queues OneDrive, and the
  email only if *Email again when Fireflies updates a meeting* is on AND the input hash changed.
- **Failures** retry with backoff (1, 2, 4 … 30 min, 12 attempts). A refusal by the send gate or bad
  recipients is final. A failed queue write answers 503, which Fireflies retries (5 times).
- **Pass time budget** (verify loop 3, D9). The host stops a pass at about 45s. The email send must start
  by 30s into the pass, and Luna only gets the time left before that (at most 25s), so a slow Fireflies
  answer cannot push the send past the ceiling. Too little time is a counted failure, retried on a fresh pass.
- **Passes that never finish.** Each claim counts one unfinished pass and each finished pass resets it. After
  5 stopped passes in a row the meeting records `gave_up:pass_did_not_finish` instead of retrying forever.
- Remaining window: a worker killed after Graph accepted the email but before the row was written would
  send once more when the lease lapses. The row is written immediately after the send to keep this small.

Nothing logs or stores transcript text, summary text, keys or Graph bodies — only ids, statuses and short
error codes.

## Server configuration

| Setting | Kind | Purpose |
|---|---|---|
| `FIREFLIES_API_KEY` | secret (repo/org Actions secret → SWA app setting) | Fireflies GraphQL bearer token |
| `FIREFLIES_WEBHOOK_SECRET` | secret | Webhooks V2 signing secret; `X-Hub-Signature: sha256=<hex>` HMAC of the raw body |
| `FIREFLIES_ONEDRIVE_MAILBOX` | plain value in `deploy-swa.yml` | whose OneDrive gets transcripts; also the minutes owner (settings key) |
| `FIREFLIES_OWNER_EMAIL` | optional | overrides the minutes owner if it differs from the OneDrive mailbox |

The Graph app already holds `Files.ReadWrite.All` and `Mail.Send`. This was confirmed by
`graph-permission-check.yml` run 42813217097 on 2026-11-10.

**Do not merge while either secret is missing.** The route answers `503 not_configured` to every
delivery without the signing secret. `fireflies-api-check.yml` reports whether both secrets are
present, plus the live Summary schema and which summary fields come back filled. It reports shapes
only, never content.

## Fireflies configuration (after the route is deployed)

1. URL: the deployed Huddle origin + `/api/public/fireflies-webhook`.
2. Signing secret: the same value as `FIREFLIES_WEBHOOK_SECRET`.
3. Events: `meeting.transcribed` **and** `meeting.summarized` (Fireflies-summary mode needs the second;
   Fireflies' own docs list it as a separate, later event).
4. *Resend when a meeting's notes change*: safe to enable (see idempotency above).
5. Send the test event. Then verify a real meeting end to end in each mode: one email, the OneDrive
   file, and a "sent" row under *Recent meetings*.
