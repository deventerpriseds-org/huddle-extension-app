<!--
WHAT:          Build log for the owner-approved Modules launcher + Actions view (branch claude_actions-view).
WHY:           Owner-approved design 2026-11-16 (actions-proto); this file is written AS the work goes so a
               reclaim or interrupt loses at most one step.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      docs/qc-evidence/AC-actions-view-modules.md; commits on claude_actions-view.
-->

# BUILD: Modules launcher + Actions view

Branch `claude_actions-view`, cut from `origin/main` 4abde5af (fetched 2026-11-16).

## Log

1. Merged `origin/claude_report-from-ledger` (57c55814, not yet on main) so the UNINVOLVED_CHAT_RULE
   (`lib/correspondence/report-from-ledger.ts` `chatInvolvement`) exists ONCE and Actions reuses it. When both
   branches land, git sees the same commit, so no second copy and no conflict.
2. Merged `origin/claude_ac-actions-view-modules` (AC doc sections 0, A-D).
3. AC doc finished: E, E-U (15-row spelling table), F, G, H, I + the owner's answers (96 ACs). Commit 4180f289.
4. Classifier moved in-app: `lib/correspondence/action-classify.ts` is CANONICAL (STEP 2 / STEP 3 / Teams wording
   verbatim, schema, inputs, Tier 1 `admitActionVerdict`, `actionSectionFor`). `scripts/action-scan-steps.ts`
   imports them. `needs-you.ts` keeps the conversation FACTS; its `validateJudgement` now CALLS
   `quoteIsVerbatim` (one verbatim rule). judgeConversation stays only behind the legacy flag + preview script.
5. Coordinator: the ledger branch landed on main as ece03e60 (#257). Merged origin/main; took main's versions of the
   rule files (identical to what I built on) and re-applied: channels follow the uninvolved rule (owner answer:
   `thread.tacv2` treated like a group; test U-11 updated to the new decision); the script's quote check now uses
   the shared `quoteIsVerbatim`; `assembleLedgerPlan` added to report-from-ledger.ts so the report and Actions
   assemble facts the same way; meeting items carry the heading (assignee) they sat under
   (`splitActionItems().headings`), and Actions lists only the owner's or unassigned ones
   (`meetingItemIsOwnersOrUnassigned`; no heading = shown, fail open).
6. Server: `lib/actions/{actions.ts, pipeline.ts, actions.server.ts, actions.functions.ts}`.
   - Storage, NO new table: verdict in the latest message row's `result_ids.action`; `markProcessed` now keeps it;
     `owner_correction JSONB` on `chat.task_proposals` and `chat.correspondence_ledger` (added only when missing);
     `actions_settings JSONB` on `chat.attention_settings` (+ `urgent_kinds` nullable so an Actions-only row reads
     as the bell's default).
   - Every listed item is backed by a `chat.task_proposals` row via the EXISTING `proposeFromSource` (todo as the
     title; the quote as the title when the todo wording is not grounded). Meetings use the EXISTING triage rows.
   - Buttons: the EXISTING `actOnProposalFn`, plus `from:"actions"` which (a) lets it run when
     `correspondence.proposals` is off but the ingest is on, (b) allows triage without `meetingTriage`, and
     (c) settles the bell row for the same email message / Teams chat on Done / Dismiss (X-6).
   - Heartbeat: `withActionsClassify` after the ingest pass; once per 10 min per process; at most 6 calls per pass and
     no call started after 20 s; daily cap setting (default 150, owner zone day).

7. UI: `ModulesLauncher.tsx` (rail button, header pill, phone sheet) built on the SHARED `LauncherList` that Apps now
   also uses (AC-M-12); Priorities / Schedule left the rail, the header pills and the bottom bar; the bottom bar's
   columns are derived from its entry list (`bottomGridClass`); phone top bar shows the view's name (`VIEW_TITLE`);
   `ActionsView.tsx` uses WidgetPage + CollapsibleSection (now exported; `defaultOpen` added), the ViewSwitcher pill
   anatomy for filters, the bell's labelled-button and What-counts anatomy, the checklist's "Proposed" menu chip on
   phones and Iris's reply-card anatomy. Chat checklist labels: "Add as task" / "Done".
8. Tests: `scripts/actions-view.test.ts` 62/62; ledger SQL (real PostgreSQL 16) 79/79 incl. AI-9 (verdict survives
   markProcessed); touched suites green: task-proposals 199, task-proposals-sql 45, meeting-triage 69,
   meeting-triage-sql 34, meeting-triage-server 7, attention (all), needs-you 77, correspondence-ingest 186,
   onedrive-feed (0 FAIL), report-from-ledger 39, feed-staleness 98. fireflies-minutes G3/G5/G8 red as on main.
   `npx tsc --noEmit` clean; `npm run build` exit 0.
9. Mutation proofs (mutate.sh, every one `FIRED (control EQUIVALENT)`, exit 0, tree restored to HEAD):
   m1 quote-verbatim admission (A-2), m2 8-char floor (A-4), m11 open_item false -> none (A-1), m3 channel clause
   (S-4), m4 fail-open on missing mention data (S-10), m5 judged version never re-sent (E-3), m6 daily cap (E-4),
   m9 uninvolved chats never become units when the switch is ON (E-1), m7 decided proposals not listed (F-1),
   m8 correction hides only its own version (G-4), m10 markProcessed keeps result_ids.action (AI-9).
10. Looked at it (local dev server, UAT identity, no DB): desktop rail with Modules + Apps and the Modules popover;
    header pills Huddle / Board / Files / Modules; Actions page frame; 390px bottom bar = 5 equal 73px x 44px columns
    (Huddle, Board, Modules, Files, Apps), Modules sheet in light and dark, no horizontal scroll, top bar "Actions".
    NOT looked at: a POPULATED Actions list (rows, buttons, Wrong? panel, suggested reply) -- the local server has no
    data. That needs `actions-view-checks.mjs` on the live app after deploy, plus the owner's eye.

### Expected AI calls per day
One call per thread VERSION (a new message in the thread = a new version). The first day back-fills since Monday and
hits the cap (150). After that: roughly the number of email conversations + Teams chats that get a new message from
someone else in a day, minus Teams group chats he is not part of (skipped before any call). Measured volume is not
known to this session; the hard ceiling is the daily cap (150) and the throughput ceiling is 6 per 10 minutes
(864/day theoretical, never reached because of the cap). Meeting items make NO model call.

## Loop-2 fixes

Fixes for the defects in `VERIFY-actions-view-2.md` (verifier probes copied to
`docs/qc-evidence/verify-actions-view-2-probes/`, paths made repo-relative). Started 2026-11-17.

- Merge: `origin/main` 19903a7e (#261, stored forwarded part) merged first (cf1700ba); one conflict in the
  `report-from-ledger.ts` imports, resolved as the union (branch's needs-you imports + main's `forwardedPartText`).
- **D1 FIXED** (`action-classify.ts`): `emailQuoteHaystack` / `teamsQuoteHaystack` now return a LIST of pieces
  (email: latest-OTHER body, and the stored forwarded part as its own piece; Teams: each OTHER message), and
  `quoteIsVerbatim` checks each piece separately -- never a joined string. Tests A-9 (Teams stitch), A-10 (body +
  forwarded-part stitch), A-11 (a quote inside one piece still admits). Probe `quote.ts`: Q15 and Q21 now `false` /
  `not_checked`. `actions-view` 65/65.
- Merge: `origin/main` a4c1d6dd (#262, uninvolved-chat findings) merged after D1. Conflict in `chatInvolvement`:
  kept main's body (never-throwing wrapper around `chatInvolvementOf`, shared `teamsOwnerIds` / `isOwnerMessage`,
  `Array.isArray` mention guards, `owner_maybe_mentioned`) and added ONLY the branch's channel rule (`kind === "channel"`
  hidden like a group). After: `report-from-ledger` 62/62, `actions-view` 65/65 (S-4 channel PASS), `tsc` exit 0.
