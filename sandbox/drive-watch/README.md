# EDS Drive watch sandbox, November 7, 2026

## Execution status

| Stage | Status | Evidence |
| --- | --- | --- |
| Existing Microsoft environment / cloud-flow creation | PASS | Enterprise Solutions (default), `Default-ee633423-c321-413c-a191-ace8b07e4196`; Office 365 and Free licenses shown in the portal. |
| Developer environment access under Von account | BLOCKED | EDS Dev's Environment (`f013f30e-c694-e87f-8495-5dc1687f9118`) returned permission denied. No new registration or paid trial. |
| Outlook -> Google Sheets -> notification email | PASS, one real event | Flow and run links below; independently read `Events!A3:K3`; Outlook independently confirms notification delivery. |
| Google Drive files.watch | PENDING APPROVAL | Receiver and helper are prepared; no channel registered and no webhook received yet. |
| Huddle architecture review | COMPLETE | Source trace below. No Huddle runtime edits. |
| Webhook -> Iris suggestion -> Android receipt | BLOCKED | No approved/deployed receiver or development Huddle adapter yet. No end-to-end latency distribution claimed. |

## Real Power Automate evidence

- Flow: [HUDDLE-SBX-Email-To-Google](https://make.powerautomate.com/environments/Default-ee633423-c321-413c-a191-ace8b07e4196/flows/e2aa77e2-bdcc-4c08-aeb2-92a116e639d3/details).
- Run: [08584075375990582853715355516CU16](https://make.powerautomate.com/environments/Default-ee633423-c321-413c-a191-ace8b07e4196/flows/e2aa77e2-bdcc-4c08-aeb2-92a116e639d3/runs/08584075375990582853715355516CU16).
- Actual email subject: `HUDDLE-PA-SBX-20261107-GOOGLE-B`.
- Sheet: [Events](https://docs.google.com/spreadsheets/d/1E5amZw1z4FXz-JckCYKul41JHhYJY1pK6ERQm7rHCK0/edit), row 3. Row 2 is an earlier direct-connector test and is excluded from Power Automate success.
- Source `EDS-Outlook-PowerAutomate`; type `new_email`; status `received`; priority `Low`; action `Generate test reply`; version `1`.
- Event ID is the original Outlook message ID. Notes contain the actual flow run ID.
- Action badges: Outlook trigger succeeded, 0.5 s; Insert row succeeded, 0.9 s; Send email succeeded, 0.7 s. Overall history displays 2 s.
- Trigger filter `HUDDLE-PA-SBX-`. Notification subject `HUDDLE-SBX-ALERT-Synthetic-Feasibility` does not match it.

| Timestamp | UTC, November 7, 2026 | Source |
| --- | --- | --- |
| Send click | 16:34:25.840 | Browser observation |
| Inbox receipt | 16:34:29 | Row value from Outlook trigger |
| Sheets action start | 16:34:47 | Power Automate action properties |
| Sheets action end | 16:34:47 | Power Automate action properties, seconds displayed |
| Write-request expression | 16:34:47.0309588 | Row `Processed UTC`; evaluated before the API write, not a Google commit timestamp |
| Notification received | 16:34:50 | Independent Outlook message search |

Inbox receipt to Sheets action start: approximately 18 seconds. Inbox receipt to notification delivery: approximately 21 seconds. These are one-sample measurements, with provider clocks and second-rounded UI timestamps. No p50/p95 or Google commit-time precision claimed.

Earlier diagnostic: flow `4947a915-2cc5-4a6d-bf0d-0a942db652c8`, run `08584075381230857616485175740CU27`; inbox receipt 16:25:46, trigger start 16:26:02, notification receipt 16:26:04 UTC. That flow tested Outlook only and was switched off before the full-path test. It does not count as Sheets success.

## Rate-limit policy

The connector returned HTTP 429 during worksheet discovery, column discovery and save validation. Save error was `DynamicOperationRequestClientFailure`, Google Sheets operation `GetTable`. Client request IDs: `fd1d4e1d-a5c3-4d46-8acd-bde12b2dbfc2`, `0b8cbd42-d371-4252-84f4-4d2c4378e5ec`, `5e859ef9-4090-42b7-973a-5f0c8658892e`. The error alone does not establish which caller exhausted the quota. Later worksheet discovery recovered and the real run passed.

For continued tests: cache metadata, stop on the first 429, honor Retry-After, use at least a 15-minute cooldown when unspecified, and allow only one deliberate retry after cooldown. Do not rotate accounts or connections to evade a quota. Do not run bursts of test emails. Read one bounded range for independent verification. The helper persists a circuit breaker and coalesces reads at 15 seconds minimum; maintenance is one five-minute timer.

## Prepared receiver and helper

`receiver/` is a standalone Azure Functions Node v3 programming-model package, compatible with the inspected Node 22 / runtime 4 host. It is NOT Huddle application source and is NOT deployed. `apps-script/` contains the Google authorization, registration, evidence and reconciliation helper.

The browser-created Apps Script project is `HUDDLE-SBX-Drive-Watch`, script ID `14PocIGt15cU85BBVtm8BsNMJH5sRhuF-wuFTz961kNPyBcqHMs3UsZTy`. It is not deployed or authorized. Check editor content against this committed source before running.

Azure inspection: existing resource group `EnterpriseDS_ResourceGRP`, app `eds-tools-api`, Linux Node 22, Functions extension `~4`, shared Dynamic plan `EastUSLinuxDynamicPlan`. `az functionapp function list` returned `[]`. This does NOT prove that replacing its deployment bundle is harmless. Before any deployment, retain a recoverable copy of its current bundle and confirm its ownership/use. Deploying can restart the app. No Azure resources, app settings or application bundles have been changed.

### Approval boundary and setup

1. Obtain approval to add the token-validated public callback on the existing app and, if needed, replace/restart its bundle. Do not create a billable resource or silently substitute another application.
2. Install the committed Apps Script code and explicit manifest. Its requested Google scopes are read-only Drive, read-only Sheets, outbound HTTPS, and management of this script's maintenance timer. The code itself hardcodes the one synthetic spreadsheet. Google OAuth scopes are broader than that code restriction; the owner must grant consent interactively.
3. Run `preparePublicConfig` to create a secret in Script Properties and print only its SHA-256 digest and channel prefix. Transfer only these non-secret values into Azure settings. Never print or commit the raw token.
4. Deploy the Apps Script `doPost` web app as the owner with external access, after approval. All requests still require the random shared token; no anonymous read endpoint exists.
5. Deploy the isolated Azure function with settings `HUDDLE_SBX_CHANNEL_PREFIX`, `HUDDLE_SBX_TOKEN_SHA256`, `HUDDLE_SBX_APPS_SCRIPT_URL`; optionally bind `HUDDLE_SBX_RESOURCE_ID` after registration. The callback validates the Google channel token before logging or forwarding anything. No raw token or request body is logged.
6. Set Script Property `RECEIVER_URL` to the actual deployed EDS callback URL. Enable Drive API for the default Apps Script project through its Drive advanced service. Grant Google consent securely, then run `registerWatch` once. Pending channel state is persisted before registration so an early sync can be validated. Record returned resource ID and expiry.
7. Verify Google's sync and update headers in Azure logs and `showEvidence`. Then send a new real Outlook test email through the existing Power Automate flow, and match the row Event ID in the webhook helper's reconciliation evidence. Do not fabricate callbacks for PASS evidence.
8. `enableMaintenance` adds at most one five-minute timer. Renewal requests begin within one hour of expiry; old channels remain accepted through expiration. Message numbers are not assumed consecutive or ordered. Persistent receipt hashes and Event ID + Version hashes suppress duplicate processing. Reads never modify the Sheet, preventing a feedback loop.
9. `stopSandboxWatch` retires known channels and removes the helper's timer. Disable the Power Automate sandbox flow after completing measurements if continued listening is not required.

Limits: reconciliation reads only `Events!A1:K101`, keeps 100 event and receipt hashes and at most 8 KB of evidence. This is deliberately a bounded feasibility helper, not a production event store. No Iris call, Android push or reply send is implemented here.

### Local validation

Run `node --test sandbox/drive-watch/receiver/test.js sandbox/drive-watch/apps-script/test.cjs`. Eight tests passed locally, including invalid-token rejection, expiry/resource checks, pending-sync race preparation, persistent duplicate suppression and 429 circuit breaking. These unit tests use synthetic stubs and do not count as cloud integration execution.

## Huddle pipeline trace and adaptation

- `src/features/huddle/lib/email/mail-subscription.server.ts`: maintains Graph Inbox subscriptions and persists them in `chat.graph_mail_subscriptions`.
- `src/routes/api/public/graph-mail-notify.ts`: validates subscription/clientState, checks alert hours, pulls the scheduled watch forward and kicks the existing inbound email runner.
- `src/features/huddle/lib/email/inbound-email.server.ts`: resolves the connected Outlook mailbox separately from the data owner, reads Inbox, screens messages, records owed replies, then enqueues an Iris durable turn with `notify: 'push'`, `internal: true`, `journey.enabled: false`, and `emailReplyRef`.
- `src/features/huddle/lib/email/inbound-email.ts`: drops self mail even in `all` mode, and filters bulk/automated/Other/no-ask messages in normal modes. A notification from the owner's own mailbox will be dropped. Keep that production screening unchanged.
- `src/features/huddle/lib/email/email-replies.server.ts`: owns `chat.email_replies`, the proposed reply and ownership checks. `propose_email_reply` dispatch in `huddle.functions.ts` stores the suggestion. `email-replies.functions.ts` saves a real threaded Graph draft only after a user tap; it never sends it.
- `src/features/huddle/lib/tasks/turns.server.ts`: `enqueueTurn` deduplicates by turn ID and execution uses an atomic claim.
- `src/features/huddle/lib/huddle.functions.ts` around lines 7988-8087: after reply persistence, the away gate and `turnPushStyle` select the notification; `invokeJourneyTool('send_push')` targets `channel: 'messages'`, `app: 'huddle'`, a per-turn notification ID/tag, and a deep link. Optional Web Push is an additional path.
- `registerBridgeFcmToken` around line 8440 routes device registration through journey's existing `register_push_token`, namespaced `fcm:app:huddle:`. Android bridge and journey delivery implementation are outside this repository; this review traces the Huddle-side call boundary only.

Adaptation: add a separate development-only, owner/file/source/type-allowlisted event adapter after the authenticated webhook has fetched the Sheet. Resolve owner identity on the server. Deduplicate on owner + source + Event ID + Version, and enqueue an Iris internal durable turn through the existing runner. Do not loosen `screenMessage`, add another push sender, or create tasks. A Sheets event alone is not a valid Graph message ID: use a synthetic response preview/card, or preserve and validate an actual Outlook message reference before using the existing Save to Drafts action. Never auto-send replies.

Before PASS for Huddle, correlate real webhook receipt, durable turn ID, stored suggestion and Android device receipt to one original synthetic Event ID. Then collect 10 paced distinct end-to-end samples, one duplicate scenario, p50/p95 and failure counts. None of those downstream outcomes has been observed yet.

References: [Google Drive push notifications](https://developers.google.com/workspace/drive/api/guides/push), [Azure Functions Node reference](https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node?pivots=nodejs-model-v3).

## Live Drive webhook execution, 2026-11-07 20:03–20:09 UTC

**Test 1 PASS; Test 2 PASS for real Power Automate content change delivery. Test 3 review complete, runtime integration BLOCKED pending development adapter deployment and Android delivery observation.** No production change or paid resource was created.

### Correlated event
- Subject: HUDDLE-PA-SBX-20261107-DRIVE-C
- Flow ID: e2aa77e2-bdcc-4c08-aeb2-92a116e639d3
- [Successful real run](https://make.powerautomate.com/environments/Default-ee633423-c321-413c-a191-ace8b07e4196/flows/e2aa77e2-bdcc-4c08-aeb2-92a116e639d3/runs/08584075248762454217507063652CU00)
- Run ID: 08584075248762454217507063652CU00
- Send click: 20:06:30.207Z; inbox receipt: 20:06:33Z.
- Trigger start/end UI: 20:06:49Z, duration 0.4 s.
- Sheets insert start/end UI: 20:06:49Z / 20:06:51Z, duration 1.7 s, succeeded.
- Processed UTC row value: 20:06:49.7617906Z. This is evaluated before the write, not an exact Google commit timestamp.
- Inserted connector row ID: 5702ffc8d00149bd80d1f4dc2016ce4a. Events record read back independently by the webhook helper; Notes contains the real run ID above.
- Notification inbox delivery independently verified by Outlook search: 20:06:53Z.
- Azure webhook receipt: 20:07:02.225Z; helper receipt: 20:07:03.444Z; matching event read/ingested: 20:07:04.159Z.
- Inbox to email delivery: 20 s; inbox to Azure webhook: 29.225 s; inbox to event ingestion: 31.159 s.
- Write expression to Azure webhook: 12.463 s. Rounded write-action end to webhook about 11.2 s. No claim of precise commit-to-webhook latency.
- One webhook-correlated sample; no p50/p95 claim.

### Real Google registration and receipt headers
Channel: HUDDLE-SBX-7b0a1557-69ae-4898-accd-6d697c0d0d60-73c4a319-bca9-4192-b4a1-6ae8175c1355
Resource: 4QZN1w-3LG0r6CD41uxJ7dA_5y4
Registered 20:03:40Z. Expiration: 2026-11-08T19:03:40Z.
Initial sync reached Azure 20:03:41.141Z and helper 20:03:42.167Z, message number 1.
Real update receipt:
```json
{"azure_received_utc":"2026-11-07T20:07:02.225Z","helper_received_utc":"2026-11-07T20:07:03.444Z","headers":{"x-goog-channel-id":"HUDDLE-SBX-7b0a1557-69ae-4898-accd-6d697c0d0d60-73c4a319-bca9-4192-b4a1-6ae8175c1355","x-goog-resource-id":"4QZN1w-3LG0r6CD41uxJ7dA_5y4","x-goog-resource-state":"update","x-goog-message-number":"201329","x-goog-changed":"content,properties","x-goog-channel-expiration":"Sun, 08 Nov 2026 19:03:40 GMT"}}
```
These sanitized Azure-generated receipt envelopes were persisted in the helper execution evidence. The receiver also emits them to Azure context.log; separate Azure Monitor retention/query was not verified. No tokens are included.

### Executed error handling and deployment
- eds-tools-api originally contained only host.json. Original and Azure Files backup SHA256 both bed39ce327ea421b377e41505ea7569bef1144f25c4b424e78558a60c0ded136.
- Added only HuddleDriveNotify files. App settings updates failed both CLI and direct ARM with Cannot find ServerFarm EastUSLinuxDynamicPlan, despite matching plan ID, subscription and East US location.
- Isolated non-secret sandbox-config.json fallback allowed operation without repairing or changing hosting. Raw channel token stays in Apps Script properties. Endpoint returned 403 to a deliberately unauthenticated probe.
- Initial sync reconciliation returned Google 403. User activated Sheets API; real update reconciliation then succeeded.
- Explicit replay audit at 20:08:41Z returned {"ok":true,"duplicate":true}, evidence_unchanged true. This audit replays an existing real receipt and is not claimed as a second real Google delivery.
- One time-based maintainWatchAndReconcile trigger verified in Apps Script UI. Every five minutes; renews near expiration and reconciles bounded rows. Renewal across actual expiration and deliberately missed-webhook recovery have not been observed.
- Reconciliation also found the older GOOGLE-B event once; that older event is not attributed to the new update.
- Main Power Automate flow remains enabled; diagnostic flow was previously disabled. Maintenance is active. No Huddle adapter, Iris turn, proposed reply or Android push has been executed.
