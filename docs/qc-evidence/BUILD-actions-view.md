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
- D1 re-check after the container restart (2026-11-17): `actions-view` 65/65, `report-from-ledger` 62/62 on a434a54c;
  the `chatInvolvement` resolution confirmed by `git diff origin/main` (main's body intact, the only change is
  `&& kind !== "channel"`). **D1 mutation proofs** (`mutate.sh`, anchors in files, exact test names):
  d1a `quoteIsVerbatim` joins the pieces again -> A-9 **FIRED (control EQUIVALENT)**, exit 0; d1b
  `teamsQuoteHaystack` returns one joined string -> A-9 **FIRED (control EQUIVALENT)**, exit 0; d1c
  `emailQuoteHaystack` joins body + forwarded part -> A-10 **FIRED (control EQUIVALENT)**, exit 0.
- **D4 FIXED (Tier 1)** (cce40415): `chat.task_proposals.owner_correction` (EXISTING nullable column, no new table)
  now holds `{v:2, items:{<itemKey>: correction}}`: one correction per ITEM VERSION (itemKey = thread key + latest
  message id; meetings: meeting id + item). `correctionFor(stored, itemKey)` reads only that version; the pre-D4
  single-object value is read as a map of its one item, so no migration. `withItemCorrection` / `withItemUndo`
  change ONE entry; the server writes inside `BEGIN ... SELECT ... FOR UPDATE ... COMMIT` (`correctItemFor`), so two
  concurrent Wrong?s on two threads both survive. Undo now sends the row's `itemKey` (ActionsView, both Undo
  buttons); the ledger mirror stays per version (one correction per latest-message row).
  Tests: `actions-view` 76/76 (new D4-1..D4-8, D4-E1..E3: the verifier's A/B repro, Undo on B never touches A,
  pre-D4 shape, history per item, end to end through `buildCandidates` + selection with two threads on one shared
  proposal). New real-PostgreSQL suite `scripts/actions-view-server.test.ts` 6/6 (D4-S1..S5: the repro on the real
  SQL, Undo byte-identity of A, per-version ledger mirror, owner scoping, and a deterministic lost-update check where
  a second connection holds the row lock and commits C while B's Wrong? waits). `tsc` exit 0.
  Mutations (all `FIRED (control EQUIVALENT)`, exit 0, restored to HEAD): d4a `withItemCorrection` starts from an
  empty map -> D4-1; d4b `withItemUndo` withdraws every entry -> D4-2; d4c candidates read the last-written entry
  instead of this item's -> D4-E2; d4d `FOR UPDATE` removed -> D4-S5.
- **D2 FIXED** (05579da0): every model call ATTEMPT is recorded BEFORE the call (`ClassifyDeps.recordCall`, now
  required), as an ISO instant appended in one atomic UPDATE to the thread's latest ledger row,
  `result_ids.action_calls` (existing JSONB column; entries older than 48h pruned on append). If it cannot be
  recorded, the pass stops and makes no call. The cap reads `actionCallsToday` = attempts since the owner's local
  midnight, never fewer than verdicts stored today (covers the deploy day), through the pure
  `classifyCallsLeft(used, cap)` (pipeline.ts; `CLASSIFY_PER_PASS` moved there, re-exported by the server).
  `markProcessed` keeps `action_calls` next to `action`. So a timeout (Promise.race does not abort the request),
  a failed proposal write and a failed verdict write all spend the cap. The "hard ceiling is the daily cap" line above
  now holds.
  Tests: `actions-view` 82/82 (D2-1: cap 5, model failing, 10 passes -> exactly 5 model calls, where the verifier's
  probe A gave 50; D2-2: the same for timeout / propose failure / store failure; D2-3: record fails -> 0 calls; D2-4
  `classifyCallsLeft` table incl. a junk count failing closed; D2-5 per local day). `actions-view-server` (real PG)
  13/13: D2-S1..S6 (attempts counted with no verdict; survive `markProcessed`; a missing row throws; owner and day
  scoping; 48h prune; max with verdicts) and **D2-E1: the REAL heartbeat `runActionsClassify` on real SQL, 8 waiting
  Teams chats, model mocked to fail, cap 5, 10 passes 10 min apart (bun `setSystemTime`) -> 5 model calls, 5
  counted**. `correspondence-ledger-sql` 79/79. `tsc` exit 0. (The verifier's probe `caps.ts` predates
  `recordCall` and now stops at the first unit; it is kept as the record of the defect.)
  Mutations: d2a drop `await deps.recordCall(...)` -> D2-1 **FIRED (control EQUIVALENT)**, exit 0; d2a2 the same
  mutation against D2-E1: first run **NOT-APPLIED** (exit 3, my script ran it before writing its anchor file, so
  nothing was tested), re-run -> **FIRED (control EQUIVALENT)**, exit 0; d2b the server passes a no-op `recordCall` ->
  D2-E1 FIRED (control EQUIVALENT); d2c the count reads verdicts only -> D2-S1 FIRED (control EQUIVALENT); d2d
  `markProcessed` drops `action_calls` -> D2-S2 FIRED (control EQUIVALENT); d2e a failed record falls through to
  the call -> D2-3 FIRED (control EQUIVALENT). All exit 0, tree clean afterwards.
- **D6 FIXED** (0b259794): `correctItemFor` first calls `itemBacking(owners, ledgerOwners, proposalId, itemKey)`. A
  thread item is backed only by a stored verdict (`result_ids.action`) whose `key` IS the itemKey AND whose
  `proposalId` IS this proposal, and that verdict's row is the ledger row the mirror is written to (the old code took
  the last `|` segment of the client's string). A meeting item is backed only by THIS proposal's own transcript ref
  (`meeting:<source_item_id>|<norm_title>`). Owner-scoped; a read error refuses (fail closed). It applies to Undo too.
  Tests: `actions-view-server` (real PG) 20/20, new D6-S1..S7: another proposal's itemKey refused; a made-up key
  ending in a real ledger id (the verifier's stamp-any-row path) refused; Undo with an unbacked key refused; the
  refused calls wrote nothing (both proposals + the ledger row byte-identical); the item's own key still works and
  mirrors onto the verdict's row; meeting own-key accepted / sibling-item key refused; another owner sees no backing.
  `tsc` exit 0.
  Mutations: d6a the refusal turned into "treat as backed" -> D6-S1 **FIRED (control EQUIVALENT)**, exit 0; d6a2 the
  same against D6-S2: first run **NOT-APPLIED** (exit 3, my script again ran before writing the anchor file; nothing
  tested), re-run -> **FIRED (control EQUIVALENT)**, exit 0; d6b the verdict query drops the `proposalId` match ->
  D6-S1 FIRED (control EQUIVALENT); d6c the meeting query drops the item match -> D6-S6 FIRED (control EQUIVALENT).
  Tree clean afterwards.
