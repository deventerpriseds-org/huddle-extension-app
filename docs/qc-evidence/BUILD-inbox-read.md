# BUILD: inbox read tools (`search_email`, `read_email`)

# WHAT:       Read-only agent tools that search and read the owner's own Outlook inbox on demand.
# WHY:        Agents can draft/reply and the inbound watch pushes new mail, but "Did Professor Lee
#             email me about the 702 deadline?" had no tool that could answer it.
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file (branch claude_inbox-read)

Branch: `claude_inbox-read` off `origin/main` 32f50e4. Additive only. Not merged, no PR.

## Step 1 - survey (what already exists, extended rather than duplicated)

| Existing piece | Where | How this build uses it |
|---|---|---|
| App-only Graph client `getAppToken()` | `lib/email/graph-email.server.ts:101` | Reused unchanged for both new reads |
| `listInboxMessagesSince` (Mail.Read, proven HTTP 200 in graph-permission-check run 38799786649) | `graph-email.server.ts:249`, sole caller `inbound-email.server.ts:103` | Not touched. New functions sit beside it and use the same Mail.Read grant |
| Owner mailbox resolver `resolveCalendarMailbox(caller) ?? caller.entra_email` | `lib/journey/identity.ts:154`; same expression in inbound watch (`inbound-email.server.ts:82`), calendar tool, reply drafts | Reused verbatim. The model is never given a mailbox parameter |
| 403 -> `needsConsent` precedent | `lib/artifacts/onedrive.server.ts:79` | Same shape: `{ok:false, needsConsent:true, error}` |
| Graph-gated tool push | `huddle.functions.ts` OpenAI path (~3644) and Lovable path (~6071); voice `realtime-tools.server.ts` (~372) | New tools pushed inside the same `graphEmailConfigured()` blocks |
| Voice NATIVE dispatch set | `realtime-tools.server.ts` `NATIVE` | Both names added, else they fall through to journey |

## Step 2 - implementation + wiring (tsc exit 0)

| File | Change (all additive) |
|---|---|
| `src/features/huddle/lib/email/inbox-read.ts` | NEW. Pure half: `SEARCH_EMAIL_TOOL` / `READ_EMAIL_TOOL` schemas, `buildInboxSearchQuery` ($search KQL vs $filter+$orderby), `cleanEmailBody` (HTML->text, whitespace, cap default 4000 / hard 12000), `formatReceived` (owner tz), `mapGraphMailError` (403 -> `needsConsent`), `finishSearchHits` |
| `src/features/huddle/lib/email/graph-email.server.ts` | Appended `searchInboxMessages`, `readInboxMessage` (GET only, same `getAppToken`), and `runInboxReadTool` - the ONE executor every surface calls; mailbox = `resolveCalendarMailbox(caller) ?? caller.entra_email`, never from args |
| `src/features/huddle/lib/huddle.functions.ts` | OpenAI path: push both tools inside the existing `graphEmailConfigured()` block, dispatch branch before `get_external_calendar_events`. Lovable path: two `tool()` entries in the same gated block |
| `src/features/huddle/lib/voice/realtime-tools.server.ts` | Push both inside the existing Graph-gated email `try`, names added to `NATIVE`, dispatch branch |

Graph query shape: free text or a sender NAME -> `$search` (KQL `from:`, `received>=`, `received<=`; unread post-filtered because KQL here cannot express it, so it over-fetches 3x). Otherwise -> `$filter` led by `receivedDateTime ge` (Graph needs the `$orderby` property first in `$filter`), default lookback 90 days, `from/emailAddress/address eq '<addr>'` with OData quote doubling, `isRead eq false`.

