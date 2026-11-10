# VERIFY-fireflies-minutes-1

```
WHAT:          Independent verification (loop 1) of PR #191, branch claude_fireflies-minutes @ f10f2dde --
               Fireflies webhook -> meeting-minutes email + OneDrive transcript.
WHY:           Verifier pass required before merge; claims C1-C12 checked against the owner's handoff
               (cc0c9843-Claude_Code_Fireflies_Huddle_Webhook_Minutes_Handoff.md) and the code, not the PR text.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      scripts/fireflies-minutes.verify.test.ts (adversarial cases, this branch);
               `bun scripts/fireflies-minutes.test.ts` (39 PASS, exit 0); `npx tsc --noEmit -p .` (exit 0, no output).
```

Offline only: no live endpoint, workflow, DB or Fireflies call was made. `docs.fireflies.ai` does not resolve
from this session (ENOTFOUND), so Fireflies' documented header/payload/field names could not be checked.

## Verdict table

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| C1 | Signature + size limit | CONFIRMED (code), header/format UNVERIFIABLE-OFFLINE | minutes.ts:59-79 accepts only `^sha256=[a-f0-9]{64}$`, HMAC-SHA256 of raw body, constant-time XOR compare; empty secret -> false. fireflies.server.ts:432 verifies before JSON.parse / any fetch. Route fireflies-webhook.ts:23-36 rejects content-length > 16384 and re-checks byte length after read. Tests A1-A7 PASS. Caveat: with no Content-Length (chunked) `request.text()` buffers the whole body before the size check (memory, not a bypass). Whether Fireflies V2 really sends `X-Hub-Signature: sha256=<hex>` could not be checked (docs host blocked). |
| C2 | Unrelated events ignored; bad meeting_id rejected | PARTIAL -- unrelated/missing CONFIRMED, "invalid" REFUTED as stated | fireflies.server.ts:443 ignores non-`meeting.transcribed` after the signature check (A8). Missing id -> 400 (A9). But `safeMeetingId` (minutes.ts:350) STRIPS characters rather than rejecting: `../../etc/passwd` -> `etcpasswd` accepted; `ab/c` and `abc` map to the same OneDrive file (V4, V4b). The raw id is still used as the ledger key and GraphQL variable. Only reachable with a valid signature, so low severity. |
| C3 | Settings read per delivery; default Fireflies | CONFIRMED | fireflies.server.ts:452 `loadMinutesSettings` on every delivery; minutes.ts:24-26 anything but `"luna"` -> fireflies; G14, B1-B3 PASS. |
| C4 | No fallback between modes; missing data -> visible error, no email | CONFIRMED | generateMinutes (fireflies.server.ts:298-329): fireflies branch returns before `callModel`; luna branch reads only `sentences` (transcriptForModel) + title/date, never `summary`. Missing data -> `recordEmailSkipped` (ledger `email_error`, shown in MeetingMinutesPanel.tsx:215) and no send. E1, E2, E5, G8 PASS. |
| C5 | Prefer extended_sections; never claim custom when only standard | CONFIRMED in code; field semantics UNVERIFIABLE-OFFLINE | minutes.ts:150-168 custom only when an `extended_sections` entry has content; else standard + `STANDARD_SUMMARY_NOTICE` (fireflies.server.ts:309) and source line "Minutes from the Fireflies summary." Interpretation for owner: handoff step 4 asks for "a visible configuration/error state" when custom output is unavailable; the PR SENDS the standard summary with a notice instead of withholding. Unverified: whether Fireflies fills `extended_sections` for its DEFAULT notes too (then the email would falsely say "your Fireflies custom summary"). |
| C6 | Luna gets full transcript + five-section template | CONFIRMED | MINUTES_INSTRUCTIONS (minutes.ts:179-206) carries every handoff rule for Agenda/Summary/Questions/Decisions/Action Items (action-language ### headings; one plain opening sentence; 2-3 `###` sections; <250 words; <=4 bullets; no #/## in Summary; first names; bold only for names/tools/projects; nested answers; decisions under headings; Next 2 weeks / Beyond; timestamps; unassigned owners), plus "use ONLY facts". transcriptForModel has no truncation. E4 PASS. `missingTemplateSections` refuses a reply missing any heading. |
| C7 | Idempotency in every sequence | REFUTED | See D1 and D2 below. Retry / concurrent / failed-then-retry / resend +/- update emails hold (F1-F6, G4-G7, G10-G12 PASS), but a crashed 'sending' row is never sent, and a racing skip can overwrite 'sending'. The PR test's fake `claimEmail` (test.ts:44-49) omits the 10-minute clause, so the stale-row path was never exercised. |
| C8 | Email and OneDrive independent | REFUTED (partial) | See D3. Inside the `Promise.allSettled` (fireflies.server.ts:467) the two branches are independent (G8, G9 PASS), but `loadMinutesSettings` (email settings, line 452, `getMinutesSettings` un-caught) and `noteDelivery` (line 457) run BEFORE it; a throw there skips OneDrive (V2: uploads 0). |
| C9 | No sensitive text in logs/responses; HTML safe; non-owner cannot read/write settings | REFUTED (two parts); HTML CONFIRMED | HTML: V3 -- 8 injection payloads, every `<`/`>` escaped, only whitelisted tags emitted. D4: Graph response text reaches logs + HTTP body. D5: settings server functions trust a client-supplied identity. |
| C10 | Recipients configurable, none hard-coded in client; subject title+date; no PDF | CONFIRMED (with owner-visible deviation) | grep for `@enterpriseds.io`/`@trinnex.io` in panel + lib/fireflies + route: 0 hits. Address literal exists only server-side in deploy-swa.yml (`FIREFLIES_ONEDRIVE_MAILBOX`). minutesSubject (minutes.ts:234) = title + date (G3). grep pdf/attachment: 0 hits. Deviation: handoff says default recipients = the two named addresses; PR defaults to the owner's linked addresses that the send gate auto-sends to, so the trinnex address is silently left out if it is not AUTO tier (G1 encodes exactly that). |
| C11 | Worst-case wall time vs ~45s | REFUTED | See D6: bounded parts alone sum to ~62s; several Graph calls have no timeout. |
| C12 | Tests + typecheck | CONFIRMED | `bun scripts/fireflies-minutes.test.ts`: 39 PASS, "all passed", exit 0. `npx tsc --noEmit -p .`: exit 0, no diagnostics. |

## Defects (each with a concrete failing scenario)

**D1 (C7) -- a crashed 'sending' row is never re-sent; minutes silently never go out.**
`decideDelivery` (minutes.ts:256-257) returns `skip_in_flight` for ANY `email_status='sending'`, with no age
input, so `claimEmail`'s reclaim clause (minutes-store.server.ts:147, `updated_at < now() - 10 min`) is never
reached. Even if it were, `noteDelivery` sets `updated_at = now()` on every delivery (line 130) and
`recordOneDrive` does too (line 188), so the row can never look 10 minutes old to the delivery that reads it.
Scenario: Luna mode; delivery claims (`sending`), the host kills the request at the ~45s ceiling (see D6) or
the process recycles before `recordEmail`. Fireflies retries (the route answered nothing / 5xx) -> skip_in_flight
-> 200-ish "skipped". Every later retry or resend: same. No email ever, ledger stuck at `sending`.
Reproduced: V1 `decideDelivery({email_status:'sending'})` -> `"skip_in_flight"`.

**D2 (C7) -- `recordEmailSkipped` overwrites another delivery's 'sending' with 'failed'.**
minutes-store.server.ts:178 `CASE WHEN email_status='sent' THEN email_status ELSE 'failed'` also replaces
`'sending'`. Scenario: deliveries A and B arrive together (initial + retry), both read `email_status NULL` ->
decision `send`. A claims and is inside `sendGraphEmail`. B's Luna call returns a reply missing a section
(`luna_template_incomplete`, transient) -> B writes `failed` over A's `sending` and answers 503 -> Fireflies
retries as C -> C sees `failed` -> `send` -> `claimEmail` succeeds on `failed` -> second email while A is
still sending. Narrow window, but it breaks "no sequence sends duplicates". (V5 shows `failed` -> `send`.)

**D3 (C8) -- settings/ledger DB failure blocks the OneDrive save.**
fireflies.server.ts:452 and 457 run outside the `allSettled`. Scenario: Azure PG unavailable for the settings
read -> `getMinutesSettings` throws -> handler throws -> route 503 -> OneDrive never written, though the
OneDrive branch needs no settings. Reproduced: V2 `{"thrown":"settings_db_down","uploads":0}`.

**D4 (C9) -- Graph response text reaches logs and the HTTP response.**
deliverMinutes (fireflies.server.ts:401-405) stores `sent.error` (from graph-email.server.ts: `Graph sendMail
failed (<status>): <Graph error.message or first 200 chars of the response body>`; on token failure
`Graph token request failed (...): <200 chars of AAD response>`), logs it at line 486 and returns it in
`email.error` of the webhook JSON (route line 53). The file header (lines 11-12) says Graph response bodies
are never logged. Exposure is limited to signed callers and server logs; no secret values are included, but
Graph errors can name mailboxes/recipients.

**D5 (C9) -- settings read/write accept a spoofed caller.**
minutes.functions.ts:218-229 `authorisedOwner` takes `caller.entra_email` from the request body;
`resolveTaskEmail` (journey/identity.ts:129-138) falls back to that raw login, and the panel
(MeetingMinutesPanel.tsx:40-43) sends `user.username` with no ID token. The codebase has a real verifier
(`verifyEntraIdToken`, src/lib/entra-verify.server.ts, used by identity/profile.functions.ts) that this does
not use. Scenario: anyone who can POST the server function with `{caller:{entra_email:"<owner address>"}}`
reads recipients + recent meeting titles and can rewrite recipients. If `email_send_enabled` is true for the
owner, the next meeting's minutes go to the attacker's address; otherwise they become a draft. This is the
app-wide caller pattern, but the claim "cannot be read/written by a non-owner caller" does not hold.

**D6 (C11) -- worst case exceeds the ~45s ceiling.**
Bounded: Fireflies query 15s (fireflies.server.ts:192) x2 when the extended_sections retry fires (line 222) =
30s, then Luna 32s (line 335) = 62s before the email is even sent. Unbounded: `getAppToken` (graph-email
token fetch), `sendMail`, OneDrive folder lookup/create and PUT (fireflies.server.ts:89, 104, 255) have no
timeout; PG queries have none. Typical Luna-mode path (Fireflies 2-5s + Luna 20-32s + Graph 1-3s) is already
close to 45s. Combined with D1, a kill after `claimEmail` permanently loses the email.

## Adversarial run output (bun scripts/fireflies-minutes.verify.test.ts)

```
DEFECT V1 C7 stale 'sending' row (crashed attempt) is never re-attempted :: "skip_in_flight"
DEFECT V2 C8 settings read failure still lets OneDrive save run :: {"result":{"thrown":"settings_db_down"},"uploads":0}
OK     V3 C9 html-escape x8 (script, img onerror, a href javascript:, svg in code, em attr-quote, iframe, md link, double-escape)
DEFECT V4 C2 path-shaped meeting_id rejected :: "etcpasswd"
DEFECT V4b C2 distinct ids map to distinct OneDrive files :: ["abc","abc"]
DEFECT V5 C7 'failed' written over an in-flight 'sending' lets a 3rd delivery send too :: "send"
```
(V5 alone only shows `failed` -> `send`, which is intended; the defect is D2's SQL overwrite feeding it.)
A first V3 run used an over-broad regex that flagged escaped text (`&lt;img ... onerror=`) as injection; the
regex was corrected to "any `<`/`>` left after stripping the renderer's own tags" and all 8 pass.

## Not checked
- Live behaviour (Fireflies header/payload names, `extended_sections` semantics, Graph permissions, real
  mailbox) -- requires the deployed route and docs.fireflies.ai, both out of scope for this loop.
