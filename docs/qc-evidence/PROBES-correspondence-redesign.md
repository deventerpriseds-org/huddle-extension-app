# Probe results for the correspondence redesign (counts only)

WHAT: results of scripts/correspondence-probes.ts (P-1..P-6 from docs/qc-evidence/AC-correspondence-redesign.md on
branch claude_ac-correspondence-redesign) on the owner's REAL files, 2026-11-14. Runs 43546742993 (Teams, Fireflies)
and the follow-up email run after the snapshot.value fix (415a87c8 + fix). Counts, header names and fixed-vocabulary
values only -- this repo is public.

| Probe | Result | Consequence for the build |
|---|---|---|
| P-1 Content-Class | **absent on all 127 emails** | cannot detect invites by Content-Class |
| P-1 calendar headers | `x-ms-exchange-calendar-series-instance-id` on **16**, `x-ms-exchange-calendar-originator-id` on **15** | **this** is the invite/response/cancellation signal (Exchange stamps calendar items); subjects carry no "Invitation:" prefix (0) |
| P-1 automated / bulk headers | list-unsubscribe 18, auto-submitted 11, precedence 10, x-servicenow-generated 10, x-ms-exchange-organization-bulkcategory 10, x-ms-engage-notification 7 (Viva Engage) | not-a-person / broadcast signals present |
| P-2 subjects | Re: 16, minutes/notes/recap/summary 13, Fw: 5, Fireflies-ish 1; Invitation:/Accepted:/Declined:/Canceled: **0** | minutes are mostly internal senders with a subject keyword, not a vendor domain |
| P-5 recipients | `toRecipients` is a STRING, `;`-separated when >1 (28); no `<>`, no quotes | split on `;`, trim, lowercase |
| P-5 owner position | To alone **93**, To with others **24**, CC only **6**, nowhere (list/BCC/alias) **4** | "addressed to me" removes few; calendar, minutes and automated signals carry most of the cleanup |
| P-5 To size | 1: 98, 2-3: 19, 4-10: 5, >10: 4 | |
| P-3 Teams chats | 59 chats: **meeting_ 40**, 1:1 (unq.gbl.spaces) 18, group (thread.v2) 1; 32 chats have no non-owner sender | meeting chats dominate |
| P-6 Teams mentions | 4 messages with mentions (2 of the owner, 2 of others) | @mentions are rare: cannot be the main group-chat signal |
| P-4 Fireflies action_items | a STRING per meeting; every line a bullet; 5-36 lines; no headings, no owner/name structure; a `(mm:ss)` stamp on some lines in 2 of 10 meetings | split on lines, strip the bullet and a trailing stamp; owner cannot be inferred (owner confirms in triage) |
