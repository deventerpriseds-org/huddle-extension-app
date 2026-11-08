<!--
WHAT:          Independent verifier loop 1 for PR #159 (OneDrive JSON feed as a second email/calendar source).
WHY:           Tier 1: the change admits outside data into the owed-reply ledger and the screening gate.
               An independent read grading each AC in docs/ac/AC-trinnex-onedrive-feed.md.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      origin/claude_trinnex-onedrive-feed @ 6ddd84dd; AC file at origin/claude_ac-trinnex-onedrive-feed.
-->
# VERIFY trinnex-onedrive-feed loop 1

Status: in progress. Findings appended per claim.

## Commands run (observed)
- `bun scripts/onedrive-feed.test.ts` -> all passed. inbound-email 69/0, schedule-brief 76/0, mail-subscription 24/0, ownership-judge ALL PASS, journey-calendar-edit-exposure 13/0.
- `npx tsc --noEmit -p .` -> rc=0, no output.
- Adversarial probe (scratch, not committed): S-1..S-28, P-1..P-6, validation, TZ, window, HTML.
- Run 42436419080 job log read (head ec501651, an EARLIER commit than PR head 6ddd84dd).

## Verdicts
CONFIRMED: AC-1,2,3,5,8,9,10,11,12,14,16,17,21,22,23,25,26,27,29,29a,30,31,32,33,34,36,38,39,40,41,42,45,46,47,48,49,52-58,59,60,61,62,64,65; S-1..S-28; P-1..P-6.
REFUTED: AC-4 (letter), 6 (minor), 7, 13, 15, 18, 19 (live-config half), 20, 24, 28 (bare blockquote), 35, 44, 50 (one spelling), 63.
UNPROVEN: AC-37, 43, 51.

## Defects
D1 (HIGH, observed) graph-permission-check.yml passes feed_config / own_addresses as step env; GitHub prints the env block in the PUBLIC job log. Run 42436419080 log shows the full feed config (work mailbox address, drive owner, owner logins, subject prefix) in plain text.
D2 (MEDIUM, code-read) huddle.functions.ts propose_email_reply (~L4014-4049) builds the card detail without draftable; only emailCardFor's alert-turn path adds draftable:false. A revision turn ("Edit first" -> Iris re-proposes) has no emailReplyRef, so the card for a feed email shows Save to Drafts; tap -> server refusal. Edit first also still shown on feed cards (AC-35 says no).
D3 (MEDIUM, code-read) getOwnerCalendarEvents: if the EDS read fails (or Graph unconfigured in meetingsForDate), feed events are discarded; AC-44 wants them returned alongside the EDS error.
D4 (MEDIUM, probe) validateEnvelope rejects the WHOLE file when one record lacks an id (AC-20 wants record-level skip).
D5 (LOW-MED, probe) htmlToText keeps <blockquote> text: "Thanks!" + quoted question -> kept as an ask (AC-28). Outlook From/Sent and On..wrote forms are handled.
D6 (LOW-MED, probe) appointment start given as {dateTime, timeZone:"Eastern Standard Time"} with no offset field is read as UTC -> 5h shift (AC-50 spelling).
D7 (LOW, probe) no check of source, calendar_name, future published_utc, window_start>published (AC-13/15/18); live config accepts synthetic:true or missing synthetic (AC-19).
D8 (LOW) no stale/max-age warning for an old but valid calendar snapshot (AC-24; G-5 open).
D9 (LOW, inferred) timeouts are per request (8s); token + metadata + content are serial, so one file can add >16s (AC-63 <=10s/file).
D10 (LOW) eTag checkpoint written at validation, before ingestion (AC-4 letter); mitigated because every run re-reads last-good and turn ids dedupe.
D11 (INFO) live evidence: both synthetic emails screened self, so the KEEP -> ledger -> turn -> push path has never run live on feed data.
