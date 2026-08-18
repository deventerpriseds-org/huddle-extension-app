# Accuracy log — wrong-first-answers & the behavioral fix each one implies

Purpose (user instruction, 2026-08-18): *"you being wrong so often is dangerous, you need to be
running a log of when that happens to gather insights on behavioral changes we can make to optimize
your performance, accuracy and first-shot completions."*

This is a running log. **Append an entry every time a first answer turns out to be wrong** — one row
per miss. Each entry names the claim, the ground truth, the *single source that would have settled it
up front*, the root-cause pattern, and the concrete behavioral rule that would have prevented it. The
value is the compounding pattern across entries, not any single row.

## The recurring pattern (what the misses have in common)
**Answering a factual/capability question from a PARTIAL or PROXY source instead of the ground-truth
primary source — and stating it with unearned confidence.** Every miss below is a variant of the
org-wide "Ground-truth before answering" rule being skipped. The two highest-leverage guards:

1. **Capability-absence claims are the most dangerous.** Before saying "X can't do Y" / "there is no
   tool for Y" / "that isn't implemented", the bar is: grep **every** place the capability could live
   (both repos, all `tool-definitions`, the proxy passthrough, the runtime tool-assembly), not one
   file for one name. A single-file grep proves nothing about absence.
2. **The user's stated observation IS ground truth.** If the user says "Iris already does X" / "I saw
   X happen", and my analysis concludes "X is impossible/absent", **my analysis is the thing that's
   wrong** — treat their observation as the fact to *explain*, never the thing to contradict. Reconcile
   to their reality; don't argue the code at them.

## Log

| # | Date | Wrong first claim | Ground truth | The one source that would have settled it | Root-cause pattern | Behavioral rule added |
|---|------|-------------------|--------------|-------------------------------------------|--------------------|-----------------------|
| 1 | 2026-08-18 | "Streaming isn't implemented yet." | Incremental per-agent streaming **is** implemented (`run-turn.ts`, `kickNextChunk`, resumable turns). | The code (`run-turn.ts`), not the CLAUDE.md backlog note. | Trusted a stale doc/backlog note as current state. | For any "is X built/done?" question, read the **code on origin**, never a backlog/status note. Docs describe intent; code is truth. |
| 2 | 2026-08-18 | "Agents have no tool to create Outlook events." | Journey exposes `create_outlook_event` / `create_google_event` / `create_calendar_event` (`_shared/tool-definitions.ts:313-355`), dispatched in `execute-tool` (`case 'create_outlook_event'` → `createOutlookEvent`). Iris uses it — as the user said. | journey `_shared/tool-definitions.ts` + `execute-tool/index.ts`, **and** the user's own statement "Iris has been doing so successfully." | Grepped ONE file (`huddle.functions.ts`) for ONE name (`Create_Calendar_Event`), called absence; also contradicted the user's direct observation. | (a) Never claim tool/capability absence from a single-file/single-name grep — sweep both repos + all tool-definition sources + proxy passthrough. (b) When the user reports observed behavior, treat it as ground truth to explain, not to override. |

## Note on what createOutlookEvent actually does (the real answer #2 was blocking)
`createOutlookEvent` (`execute-tool/index.ts:1701`) invokes `send-unified-notification` with
`channels:['OUTLOOK_EVENT']` and an `outlookEvent.reminder` — it **creates the Outlook event only**.
It does NOT arm journey's own full-screen alarm (`scheduled_notifications` → `calendar_events` channel
→ AlarmSoundService). So a relayed appointment that Iris drops into Outlook gives the user **Outlook's
native reminder**, not the journey/Huddle full-screen alarm — which is exactly what the user reported
seeing. (Journey's full-screen alarm for external events comes from `notification-scheduler` →
`calendar_event_reminder`, and only after `calendar-delta-sync` pulls the event back into
`external_calendar_events` — a lagged round-trip, not something `createOutlookEvent` arms directly.)
