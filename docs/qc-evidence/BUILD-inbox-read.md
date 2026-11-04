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

## Step 3 - offline suite (resumed after a container restart, 2026-11-04)

`scripts/inbox-read.test.ts`, run with `npm run test:inbox-read`. It replaces fetch (token and Graph answer from
fixtures; any other host throws) and mocks `journey/identity` with `mock.module`. **68 passed, 0 failed.**
Sections: 1 query builder (19), 2 body cleaning (9), 3 owner tz (3), 4 error mapping (4), 5 shaping (4),
6 network half with GET-only and 403 assertions (9), 7 executor mailbox scoping (7), 8 read-only source scan (3),
9 wiring on OpenAI/Lovable/voice, inside the Graph gate and outside the send gate (10).

## Step 4 - mutation proofs (`mutate.sh`, baseline + mutated + restored runs each; tree clean after)

| # | Defect reinstated | File | Check that must fail | Outcome |
|---|---|---|---|---|
| M1 | mailbox taken from `args.mailbox` before the resolver | graph-email.server.ts | 7b | FIRED |
| M2 | 403 no longer mapped to needsConsent | inbox-read.ts | 4a | FIRED |
| M3 | OData single-quote doubling removed | inbox-read.ts | 1k | FIRED |
| M4 | `read_email` issued as POST | graph-email.server.ts | 6g | FIRED |
| M5 | 12000-char hard cap removed | inbox-read.ts | 2g | FIRED |
| M6 | names dropped from voice `NATIVE` (would fall through to journey) | realtime-tools.server.ts | 9h | FIRED |
| M7 | voice push moved OUTSIDE the `graphEmailConfigured()` gate | realtime-tools.server.ts | 9f | FIRED |
| M8 | owner zone not resolved (browser zone used) | graph-email.server.ts | 7g | FIRED |
| M9 | unread post-filter disabled | inbox-read.ts | 5a | FIRED |
| M10 | OpenAI push placed INSIDE the `send_email` gate | huddle.functions.ts | 9b | FIRED |
| M11 | Lovable `search_email` not registered | huddle.functions.ts | 9d | FIRED |
| M12 | empty-id guard removed (would GET /messages/) | graph-email.server.ts | 6i | FIRED |

12/12 FIRED, 0 INERT, 0 NOT-APPLIED. The first attempt passed `"FAIL 7b"` as the pattern; mutate.sh prefixes
`FAIL ` itself, so it reported "a DIFFERENT test failed ... NOTHING IS PROVEN" for all 12. Re-run with bare names.

## Step 5 - pre-merge suites

`npx tsc --noEmit` exit 0. test:voice-tools 36/0, test:email-gate 73/0, test:router 39/0, test:inbox-read 68/0.

## Step 6 - merge latest origin/main, re-run (2026-11-04)

`git fetch` then `git merge --no-edit origin/main` -> "Already up to date." origin/main is still 32f50e4, the
branch point, so there was nothing to merge (no merge commit). Re-run on that tree: tsc exit 0,
test:voice-tools 36/0, test:email-gate 73/0, test:router 39/0, test:inbox-read 68/0.

Additive check, `git diff --numstat origin/main...HEAD`: no `src/` file has a deleted line (the only `1` is
package.json's trailing-comma line). The inbound watch (`inbound-email.server.ts`), draft/reply,
`send_email` gating and push are untouched. Checks 9b/9e/9g pin the new tools OUTSIDE the send gate.

Lane complete. Not merged to main and no PR, by instruction. Not live-verified: no Graph call from this
session reached a real mailbox, so "works against a real inbox" is unproven until it is deployed and asked.
