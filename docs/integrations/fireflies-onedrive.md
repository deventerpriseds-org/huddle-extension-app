# Fireflies transcripts to OneDrive

Huddle receives Fireflies Webhooks V2 at `/api/public/fireflies-webhook`. The route accepts only signed requests, listens for `meeting.transcribed`, fetches the full transcript from Fireflies GraphQL, and writes a Markdown file through Huddle's existing Microsoft Graph client.

## OneDrive result

Files are saved under `/Automation/transcripts` as `fireflies-{meeting_id}.md`. The meeting ID makes the path stable, so a webhook resend replaces the existing transcript file instead of creating another copy. The document includes the meeting title/date, attendees, summary and action items when available, plus timestamped speaker lines.

Fireflies Webhooks V2 delivers events for meetings owned by the webhook account. This matches the initial scope of capturing the account owner's meetings. Resend events for transcript changes can be enabled in Fireflies; the stable file path will be updated.

## Server configuration

Add these values as server-side secrets in the Huddle deployment:

- `FIREFLIES_API_KEY`: the Fireflies API bearer token.
- `FIREFLIES_WEBHOOK_SECRET`: the signing secret configured for the Fireflies Webhooks V2 endpoint.
- `FIREFLIES_ONEDRIVE_MAILBOX` (optional): mailbox whose OneDrive receives transcripts. If omitted, Huddle uses the first configured `HUDDLE_EMAIL_FROM` mailbox.

The route reuses Huddle's existing Microsoft Graph app credentials. That app must already have the OneDrive write permission used by Huddle's artifact mirror.

## Fireflies configuration

After this route is deployed, create a Webhooks V2 configuration in Fireflies:

1. Set the URL to the deployed Huddle origin plus `/api/public/fireflies-webhook`.
2. Set the same signing secret as `FIREFLIES_WEBHOOK_SECRET`.
3. Subscribe to `meeting.transcribed`.
4. Enable resend on transcript changes if updated transcripts should replace earlier files.
5. Send a test event and confirm a real transcribed meeting produces a file under `/Automation/transcripts`.

Keep both Fireflies secrets in the deployment's secret store. Do not put them in browser code or commit them to the repository.
