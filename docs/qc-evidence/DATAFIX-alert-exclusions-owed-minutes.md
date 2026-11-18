<!--
WHAT:          The one-off data fix for ACT:alert-exclusions: dismiss the 7 Huddle meeting-minutes emails still
               "owed" in chat.email_replies (each got an Iris alert + draft before the exclusion list existed).
WHY:           Owner 2026-11-18: "Meeting minutes should not trigger Iris to send me a draft in the chat." The new
               screen stops NEW ones; these 7 were already counted as replies he owes.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      pre-check azure-pg-query run 44372851721 (job 135044052087): exactly 7 rows, all from_name "EDS Dev",
               domain enterpriseds.io, status owed, subject "Meeting Minutes: ...". AC-50..AC-53.
-->

# Data fix — dismiss the 7 owed meeting-minutes rows

## The 7 ids (read 2026-11-18 18:45 UTC, run 44372851721)

| id | received_at (UTC) | subject (cut) |
|---|---|---|
| 5ee90a7f43bc3f6d | 2026-11-16 15:40 | Meeting Minutes: the participant's recent professional background and … |
| 473e842a4a8f6be7 | 2026-11-16 16:13 | Meeting Minutes: Assess leadership and collaboration improvements … |
| 770af23aa19ad3ca | 2026-11-17 15:11 | Meeting Minutes: Clarify team capacity and work visibility … |
| 867eae2c3e1d2dd3 | 2026-11-17 16:09 | Meeting Minutes: UX and quality controls … |
| 0d00b703c3a9fc47 | 2026-11-17 16:36 | Meeting Minutes: Clarify how weekly engineering work should be summari… |
| 34c1ddfbfef92bf9 | 2026-11-18 14:28 | Meeting Minutes: Clarify how custom work is scoped and budgeted … |
| 8c217760feaa0232 | 2026-11-18 14:36 | Meeting Minutes: Clarify participation in territory plan presentations … |

## The fix (by explicit id only)

`settled_at = received_at`, not `now()` (AC gap G3): these were never answered, so stamping them "settled today"
would make Iris's next alert card read "Settled today: 7+" for the day. Nothing is deleted; the Iris alert turns stay
in chat history.

```sql
UPDATE chat.email_replies SET status = 'dismissed', settled_at = received_at, updated_at = now()
 WHERE id = ANY(ARRAY['5ee90a7f43bc3f6d','473e842a4a8f6be7','770af23aa19ad3ca','867eae2c3e1d2dd3','0d00b703c3a9fc47','34c1ddfbfef92bf9','8c217760feaa0232'])
   AND status IN ('owed','drafted') AND kind = 'email' AND subject ~ '^(Updated )?Meeting Minutes: ';
```

## Undo (exactly these ids)

```sql
UPDATE chat.email_replies SET status = 'owed', settled_at = NULL, updated_at = now()
 WHERE id = ANY(ARRAY['5ee90a7f43bc3f6d','473e842a4a8f6be7','770af23aa19ad3ca','867eae2c3e1d2dd3','0d00b703c3a9fc47','34c1ddfbfef92bf9','8c217760feaa0232'])
   AND status = 'dismissed';
```

## RESULTS

Run 2026-11-18 18:57 UTC, azure-pg-query run 44374957433 (job 135051536015):

| measure | value |
|---|---|
| owed email replies before | 20 |
| rows updated | `UPDATE 7` (exactly the 7 ids) |
| owed email replies after | 13 |
| meeting-minutes rows still owed | 0 |

AC-50 (exactly 7 before the write): met. AC-51 (by id only, rowCount 7, undo SQL above): met. AC-52: owed dropped by
exactly 7; "Settled today" is unaffected because settled_at = received_at (all before today except 34c1ddfbfef92bf9 and
8c217760feaa0232, received 2026-11-18, which DO count as settled today: +2, not +7). AC-53 (stay dismissed on the next
run) is checked after deploy.
