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
     `callOpenAIResponses`, with the five-section minutes template (Agenda / Summary / Questions /
     Decisions / Action Items, `lib/fireflies/minutes.ts` `MINUTES_INSTRUCTIONS`). A reply missing any
     section is not emailed.

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

`chat.fireflies_meetings` holds one row per meeting: deliveries seen, minutes source, email status,
recipients, error, OneDrive path and status, and a hash of the meeting **input**
(transcript + summary).

- **A retry of a meeting already emailed** sends nothing. The OneDrive file is still re-upserted.
- **Concurrent deliveries** race for an atomic `UPDATE … SET email_status='sending'` claim. Exactly
  one of them emails.
- **A Fireflies resend with changed content** updates the OneDrive file. It emails an
  "Updated meeting minutes" message only when **Email again when Fireflies updates a meeting** is on.
  That setting is off by default.
- **A failed send** (Graph, Luna or network) answers 503 so Fireflies retries, and the retry sends
  once. Permanent problems, such as no summary in Fireflies-summary mode, answer 200 with the error
  in the body.

Nothing logs or stores transcript text, summary text, keys or Graph bodies. Only ids, statuses and
short error codes are kept.

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
3. Event: `meeting.transcribed`.
4. Resend on changes: safe to enable (see idempotency above).
5. Send the test event. Then verify a real meeting end to end in each mode: one email, the OneDrive
   file, and a "sent" row under *Recent meetings*.
