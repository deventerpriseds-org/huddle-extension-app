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

| 3 | 2026-08-20 | Deployed a "semantic 1:1 owner-resolution" fix and reported it shipped; user hit the same Finn→Tess mis-route again. | The fix was a **no-op**: (a) `resolveOwnerLLM` returned `null` for BOTH "keep with addressed agent" AND "failure", and the caller fell back to keyword `laneOwnerFor` on either → the mis-route it replaced came right back; (b) the candidate enum was `data.members` = `[finn-reid]` only in a 1:1, so the classifier could never pick another owner. | The independent `verifier` subagent's LIVE run (a fresh `followup-…-tess-sutton` turn appeared, no quota fallback) — NOT tsc, which was green. | Shipped a fix whose success path was structurally unreachable; "tsc clean + mechanism looks right" is not proof for a behavior fix. | (a) A behavior/routing fix is NOT "done" until an independent verifier confirms the OBSERVABLE outcome live — tsc/mechanism review is necessary, not sufficient. (b) A sentinel that means two different things (null = keep AND fail) is a bug smell — make "success/keep" distinct from "failure". (c) Check the actual data shape at the call site (a 1:1's `members` is the single addressed agent, not the team). |

| 4 | 2026-08-20 | Treated the recurring "phantom hand-off — heads-up push fired but no message in the owner's chat" as fully covered by the owner-resolution (mis-route) fix. | Two SEPARATE bugs. Bug #1 = wrong owner (mis-route). Bug #2 = a legitimate follow-up turn is stored under the RAW `entra_email` (`Von.Ellis@EnterpriseDS.io`) while the client back-fill (`getAllTurnUpdates`→`getUserTurnsSince`) queries under the CANONICAL `resolveTaskEmail` (`dev@enterpriseds.io`); `lower(user_email)` never matches → the finished turn can't render even though its push (which resolves the email separately) fired. | The actual `chat.pending_turns` rows: `followup-%` keyed under `Von.Ellis@EnterpriseDS.io`, but all 205 `u-%` interactive turns keyed under `dev@enterpriseds.io`. The email divergence was right there. | Diagnosed a two-cause symptom as one cause; didn't check the WRITE-side key against the READ-side query until forced. | Before calling a "notification fired but content missing" bug fixed, verify the write key and the read query use the SAME identity — grep every enqueue site's `user_email` against the reader's filter. A push firing proves nothing about whether the row is *matchable* by the renderer. |

## Note on what createOutlookEvent actually does (the real answer #2 was blocking)
`createOutlookEvent` (`execute-tool/index.ts:1701`) invokes `send-unified-notification` with
`channels:['OUTLOOK_EVENT']` and an `outlookEvent.reminder` — it **creates the Outlook event only**.
It does NOT arm journey's own full-screen alarm (`scheduled_notifications` → `calendar_events` channel
→ AlarmSoundService). So a relayed appointment that Iris drops into Outlook gives the user **Outlook's
native reminder**, not the journey/Huddle full-screen alarm — which is exactly what the user reported
seeing. (Journey's full-screen alarm for external events comes from `notification-scheduler` →
`calendar_event_reminder`, and only after `calendar-delta-sync` pulls the event back into
`external_calendar_events` — a lagged round-trip, not something `createOutlookEvent` arms directly.)
