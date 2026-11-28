# REDTEAM -- actions label auto-task (Tier 1 pre-pass, before the PR)

WHAT:       Adversarial attacks on the Outlook-label auto-task (lib/actions/label-autotask.ts, lib/correspondence/email-labels.ts,
            ledger refresh, settings, Actions display), each one a test in scripts/actions-view.test.ts (prefix `RTL-`).
WHY:        Tier 1 rule: a red-team pre-pass runs before the PR, starting from the AC spelling table / outcome table.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   branch claude_actions-label-autotask, base 3b71dd16; `bun scripts/actions-view.test.ts` -> 331 passed, 3 failed
            (the 3 failures are RTL-3, RTL-4 and RTL-6 below; every other test in the suite passes).

How to read this: a PASS means the code HELD and the test stays as a regression guard. A FAIL means the attack SUCCEEDED.
The test asserts the CORRECT behaviour and fails now. No source was changed. Synthetic data only. No model calls, no
workflow dispatches, no database.

| # | Attack (input) | Expected | Actual | Verdict |
|---|---|---|---|---|
| RTL-1 | Look-alike / near-miss labels: Cyrillic `А`, fullwidth `Ａ`, zero-width space inside, `Action Needed!`, `Needs Action`, `Action Needed (old)`, `Action`, `Not Action Needed`, Turkish `İ` | no match for any | no match for any | held |
| RTL-1b | Same label in other case / NBSP / double spaces | match | match | held (intended) |
| RTL-2 | Setting saved as blanks / NBSP / tab+newline only | `[]` (auto path off) | `[]` | held |
| RTL-3 | Stored record `{attempts: 5, done: false}` with no `gaveUp` flag (older writer, partial record), create failing | 0 createTask calls (the cap is at 5) | **1 call**. The skip reads only `done`/`gaveUp`, never `attempts >= AUTO_TASK_MAX_ATTEMPTS` (label-autotask.ts runLabelAutoTask's first loop; `wouldAutoTaskCount` has the same gap) | **BROKEN** (low: needs a record without the flag) |
| RTL-4 | createTask fails AND saveRecord fails on every pass, 8 passes | at most 5 createTask calls | **8 calls, one per pass, with no limit**. The attempt count lives only in the record, `save` swallows the write error (counted as `autotask:record_failed`), so attempts stay at 0+1 each pass. The cap does not hold when the ledger write fails | **BROKEN** (medium: a runaway retry, one journey create per pass, while the ledger write path is down) |
| RTL-5 | create succeeds, saveRecord always fails, 3 passes | createTask 1 | 1. The approved proposal with `sameItem` is found by `priorRelated` and marked decided | held |
| RTL-6 | Conversation with email A (labelled, tasked in pass 1). Owner completes the task so it leaves the open board. Reply B arrives labelled with the same stripped subject. No AI verdict | 1 task total ("no email is tasked twice / never re-does what I decided") | **2 tasks**. B has its own ref; `priorRelated` returns title matches only when `dismissed`, and A's proposal is `approved`. The conversation-key ref is never a ref of the label proposal. The board read no longer shows A. So a completed task is re-created for the same thread | **BROKEN** (medium. The contract is silent on the cross-pass case, since AC-6.3 covers one pass only. This needs an owner call: is the auto-task once per email or once per conversation?) |
| RTL-7 | Board read fails while the thread verdict points at a PROPOSED proposal | createTask 0, still proposed | 0, proposed | held |
| RTL-8 | A closed (`status: none`) verdict's stale to-do | not used as the title | stripped subject used | held |
| RTL-9 | Thread verdict's proposal dismissed under ANOTHER title, on a sibling email | createTask 0 | 0 | held |
| RTL-10 | `status: "Action Needed"` / `"needs action"` with non-matching categories | 0 tasks (status never interpreted) | 0 | held |
| RTL-11 | Logging: any `console.` in the label modules; the server pass log line's interpolations | none; counts / kinds only | none; only `res.*` counts and kind codes | held |
| RTL-12 | Back-fill DRY RUN: does the label block write? | SELECT only | no INSERT/UPDATE/DELETE/observe/storeContent/saveRecord in the block (the earlier `store()` returns when `!apply`) | held |
| RTL-13 | Content-only refresh overwrites other content / clears labels on an absent key | merges only `categories`/`status`; absent key kept | `l.content || jsonb_strip_nulls(jsonb_build_object('categories',..,'status',..))`, each gated by `EXCLUDED.content ? key` | held (by source read; not run against Postgres) |

## Checked by reading only (no test written: out of time, or held by construction)

- **Wrong owner / mailbox:** loadLabelRows, saveAutoTaskRecord, labelProposalForThread and loadAutoTasked all filter `owner_email = ANY(owners)` with `source = 'email'`. `result_ids` is `NOT NULL DEFAULT '{}'`, so the `||` merge cannot null out. Held by reading. Not run.
- **Hash drift:** categories and status are not in the email hash (the existing LBL-AC-1.4 GUARD). One NOTE, not caused by this change: a `drive_item_etag` identity puts the file eTag in the hash. If the feed rewrites a per-record file when the label changes, that row is re-judged. The eTag rule already existed before this change.
- **"Added to board" row:** the existing LAT-AC-3.32/3.33 already pin the closed state, the count exclusion and that only proposed rows can act. No new attack written.
- **Label removed after creation:** the existing LAT-AC-3.19/3.20 pin it. The auto path has no delete or edit call.

## Tests that FAIL now (the attack succeeded)

- `RTL-3 attempts already at the cap (no gaveUp flag) -> 0 createTask calls`
- `RTL-4 create + record write both failing over 8 passes -> createTask at most 5`
- `RTL-6 same conversation, same title, first task completed -> createTask total 1`
