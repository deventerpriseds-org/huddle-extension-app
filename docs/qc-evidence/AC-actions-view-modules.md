<!--
WHAT:          Acceptance criteria for the Huddle "Modules" launcher and the new "Actions" view (owner-approved
               design 2026-11-16, prototype actions-proto/index.html), written cold by an independent AC subagent.
WHY:           Tier 1 parts (what "needs you", the uninvolved-chat filter, resolved-item exclusion, the Wrong?
               correction write) need a cold adversarial AC set plus a spelling table before any code is written.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      origin/main 0fae2693 (files listed under "Sources read"); @microsoft/microsoft-graph-types@2.40.0
               microsoft-graph.d.ts (Chat, ChatMessage, ChatMessageMention); prototype + notes.md in the session scratchpad.
-->

# Acceptance Criteria: Modules launcher and Actions view

**Task:** Add a labelled **Modules** launcher (built like Apps) that holds Priorities, Schedule and a new
**Actions** page. Actions lists, since Monday, the email, Teams and meeting items that need the owner and are
not yet resolved, grouped into sections. Each row has the existing proposal actions, plus Draft reply, Open in
Teams and a new Wrong? correction. It also has filters and "What shows" settings, including an uninvolved-chat
filter that is on by default.

**Base read:** `origin/main` at `0fae2693`. No code was changed.

**Sources read (this session):**
`components/Rail.tsx`, `AppsLauncher.tsx`, `ViewSwitcher.tsx`, `HuddleApp.tsx` (VIEWS, FULL_WIDTH_VIEWS, activeTitle),
`JourneyWidgets.tsx` (WidgetPage, CollapsibleSection, PrioritiesView, ScheduleView), `ProposalChecklistItem.tsx`,
`AttentionBell.tsx` (controls, POLL_MS), `HuddleView.tsx` (NAV_VIEWS), `store.ts` (View union),
`lib/proposals/proposals.functions.ts`, `proposals-store.server.ts` (chat.task_proposals DDL), `engine.ts` (F15, decideProposal),
`lib/correspondence/ledger.server.ts` (chat.correspondence_ledger DDL incl. `content`), `source-item.ts` (content shapes),
`needs-you.ts` (ConversationFacts, validateJudgement, judgeConversation, reportBucket), `bell.ts` (decideChatThread),
`ingest-pass.ts` (activeProcessors), `lib/external-feeds/teams-log.ts` (parseTeamsLog, ownerUserId), `onedrive-feed.ts`
(CorrespondenceConfig, ownerSenderIds), `lib/attention/attention.ts` (toAttentionItem, safeLink, SETTINGS_KINDS),
`lib/email/email-replies.functions.ts` (saveEmailReplyDraftFn), `email-replies.server.ts` (chat.email_replies DDL),
`email-reply-ask.ts`, `scripts/action-scan-steps.ts` (STEP2/3 prompts, SCHEMA, HIDE), `scripts/correspondence-ingest.test.ts` (TO-1..3).

**Existing systems this EXTENDS (and must not duplicate):**

| Need | Existing system | What the ACs require |
|---|---|---|
| Launcher | `AppsLauncher.tsx` `AppList` / `RailAppsButton` / `AppsSheet` | Modules reuses that anatomy. A second hand-copied launcher is not allowed (AC-M-12). |
| Page frame | `JourneyWidgets.tsx` `WidgetPage`, `CollapsibleSection` | Actions uses the same frame and the same section component. |
| Row actions | `actOnProposalFn` + `chat.task_proposals` (approve lease, F15 cross-source dismiss) | Add as task / Edit / Done / Dismiss go through it (AC-C-1). No parallel action endpoint. |
| Draft reply | `saveEmailReplyDraftFn` + `chat.email_replies.proposed_reply` + `propose_email_reply` tool | Same function and the same row. No second reply ledger. |
| Teams link | `attention.ts` `safeLink` + `email_replies.source_link` | Same https-only rule. |
| "Needs you" classifier | `needs-you.ts` judge (`validateJudgement`, `judgeConversation`) and `scripts/action-scan-steps.ts` STEP 2/3 | ONE in-app classifier after the move (AC-E-1). |
| Source store | `chat.correspondence_ledger` (+ `content`) | The read source. Ledger rows are never copied into a new table. |
| Bell | `AttentionBell.tsx` / `chat.email_replies` | Unchanged (owner 4A). Must reconcile on resolved state (AC-I-8). |

New structures that seem needed, flagged for sign-off rather than assumed: a **classification store** (OQ-2) and a
**correction (Wrong?) store** (OQ-11).

---

## 0. Changes to EXISTING behaviour (each needs the owner's thumbs-up before build)

| # | Existing behaviour today | What it becomes | Why | Impact on you | Reversible? | Approved? |
|---|---|---|---|---|---|---|
| X-1 | Rail has its own Priorities and Schedule icons (`Rail.tsx` `items`). | They move into Modules. | Owner design 1A. | Two clicks instead of one. | Yes (list edit) | **Yes, 1A** |
| X-2 | The phone bottom bar has 5 entries plus Apps in `grid-cols-6`, including Priorities and Schedule. | Huddle, Board, Modules, Files, Apps (5 columns). | Owner design 1A. | Two taps instead of one. | Yes | **Yes, 1A** |
| X-3 | Desktop header pill row (`ViewSwitcher` `variant="inline"`) shows Huddle, Board, Priorities, Schedule, Files. | The prototype shows Huddle, Board, Files, Modules. | Same list drives both layouts. | Priorities/Schedule leave the header pills too. | Yes | **NOT stated in the brief. Confirm.** |
| X-4 | In-chat checklist rows (`ProposalChecklistItem`) say **Approve** and **Mark done**. | "Add as task" and "Done", if "everywhere" includes the chat checklist. | Owner chose these names. | The chat checklist menu changes words. | Yes | Confirm the scope of "everywhere" (OQ-15) |
| X-5 | Phone top-bar title is the active huddle's name on every view except Polish (`HuddleApp.tsx` `activeTitle`). | Actions would show "Iris Chase" too, unless fixed. Fixing it for Actions alone, or for all views, changes Priorities/Schedule/Board/Files too. | Bug noted in the prototype notes. | Title reads correctly. | Yes | Confirm (OQ-19) |
| X-6 | Dismissing in the bell settles only the bell row. Dismissing in chat settles only the proposal. | An Actions Done/Dismiss on an item that also has a bell row or email_replies row settles both (one decision everywhere, AC-I-8). | Cross-surface counts must agree. | The bell count drops when you act in Actions. | Yes | Confirm (OQ-20) |
| X-7 | Classification runs only as the preview script (`action-scan-steps.ts`, OneDrive HTML report). It stores nothing in Huddle. | It runs in-app and stores results. Model calls happen on the ingest pass once the switches are on. | Actions needs stored classification. | Per-pass AI cost. The preview script is retired or made to call the same module. | Yes (switch) | Implied by the brief. Confirm the switch, which is OFF today. |
| X-8 | The owner put Teams out of scope ("email report for now, no teams", 2026-11-14), and the bell's "What counts" hides the Teams checkbox (`SETTINGS_KINDS`). | Actions shows Teams rows, a Teams filter and a Teams source toggle. | Approved design includes Teams. | Teams items become visible in a new place. | Yes | The approved design includes it. Note the reversal of 11-14. |
| X-9 | The noise categories hidden in the preview come from `PREVIEW_HIDE_CATEGORIES` (an env var). | A stored per-owner setting. | Config-centric rule. | Settings move to the page. | Yes | Implied |

The bell itself is **unchanged** (owner 4A). AC-I-6 and AC-I-7 hold that line.

---

## A. Modules launcher, rail and navigation (Tier 2)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-M-1 | Given desktop (>= md), when the app loads, then the rail shows, in order: H tile, Huddles, Board, Artifacts, Memory, divider, then **Modules** and **Apps** as labelled buttons. There is NO Priorities icon and NO Schedule icon. | happy | Playwright: `nav button[aria-label="Priorities"]` count 0; `[aria-label="Modules"]` count 1 with visible text "Modules" |
| AC-M-2 | Given desktop, when Modules is clicked, then a popover opens to the right (side=right, align=start), with header "Modules" and exactly three rows in order: Priorities, Schedule, Actions. Each row has a label and a one-line blurb. | happy | Playwright: popover text; 3 `li` |
| AC-M-3 | Given the popover is open, when "Priorities" / "Schedule" / "Actions" is clicked, then the store view becomes `priorities` / `schedule` / `actions`, the matching page renders, and the popover closes. | happy | Playwright: h1 text equals "Priorities" / "Schedule" / "Actions"; popover detached |
| AC-M-4 | Given view is priorities, schedule or actions, then the Modules button has `aria-current="page"` and the active style. Apps does not. Given any other view, then Modules is not marked current. | happy | DOM attr on 6 views |
| AC-M-5 | Given the Actions row in Modules, then it shows a count badge equal to the Actions page's **All** count (AC-D-2), and the two numbers agree within one refresh. Given 0, then no badge (or "0", but never blank-vs-number mismatch). | reconciliation | Read badge text; open Actions; compare |
| AC-M-6 | Given the `View` union in `store.ts`, then it includes `"actions"`, and `HuddleApp.tsx` `VIEWS` has an `actions` entry. A missing entry fails `tsc` (the existing Record<View> guard). | regression | `npx tsc --noEmit` passes; removing the entry fails it |
| AC-M-7 | Given the phone bottom bar, then it renders exactly 5 equal-width columns: Huddle, Board, Modules, Files, Apps. There is no empty column and no wrap at 390px or 320px width. The grid column count is derived from the entry count, not the literal `grid-cols-6`. | edge | Playwright 390x844 and 320x640: 5 buttons; each button's width within 1px of the others; no element with x+width > viewport |
| AC-M-8 | Given phone, when Modules in the bottom bar is tapped, then a bottom sheet opens with title "Modules", a description line, and the same three rows as AC-M-2. Choosing one sets the view and closes the sheet. | happy | Playwright: `[role=dialog]` title; after tap the dialog is gone |
| AC-M-9 | Given phone and view in {priorities, schedule, actions}, then the Modules column is `aria-current="page"`. Given view polish, then Apps is current and Modules is not. | happy | DOM |
| AC-M-10 | Given the Apps launcher, then it still lists Polish, Sidecar (Coming soon), Prompto (Coming soon) and opens Polish. Modules items never appear in Apps, and Apps items never appear in Modules. | regression | Playwright on both launchers |
| AC-M-11 | Given every touch target in the Modules sheet and the bottom bar, then each is at least 44px tall. | edge | boundingBox().height >= 44 |
| AC-M-12 | Given the source, then the Modules list and the Apps list are rendered by one shared list component (parameterised), not two copies of `AppList` markup. | extend-not-duplicate | Code read: one list component imported by both launchers |
| AC-M-13 | Given the header pill row on desktop (X-3), then it matches whatever the owner approves for X-3. Until approved, it keeps Priorities and Schedule. | regression | DOM text of inline switcher |
| AC-M-14 | Given keyboard only, when focus is on Modules and Enter is pressed, then the popover opens and items are reachable by Tab/arrow, and Esc closes it and returns focus to the Modules button. | edge (a11y) | Playwright keyboard |

## B. Actions page layout (Tier 2, except where marked)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-B-1 | Given view `actions`, then the page uses `WidgetPage` (header bar `bg-surface`, h1 "Actions" `text-sm font-semibold`, edge-to-edge scrolling body). The sidebar and the context panel stay visible on desktop, as on Priorities/Schedule. | happy | DOM classes; Sidebar and ContextPanel present |
| AC-B-2 | Given the header, then it shows the window start as "Since Monday, <Mon D>" in America/New_York (or the owner's configured zone), computed per AC-E-9. | happy | Text equals the computed date |
| AC-B-3 | Given items exist, then sections render in this order: "Needs your reply", "To-do for you", "FYI with an action", "From meetings". Each uses `CollapsibleSection` with a count in brackets equal to its row count. | happy | DOM order; count text vs `li` count |
| AC-B-4 | Given "Needs your reply", then it is followed by a collapsed-by-default group "Answered by your reply (n)". Expanding it lists the n settled items. Its n is NOT included in All or in any section count. | happy / reconciliation | Collapsed on first load (fresh localStorage); expand -> n rows |
| AC-B-5 | Given a section with 0 rows, then that section is not rendered (or renders "None"), but never a header with a count that disagrees with its rows. | edge | DOM |
| AC-B-6 | Given a row, then it shows: source icon (email / Teams / meeting), title, who (sender or chat), source label, time ("Mon 9:12" / "Today 8:40" in the owner zone), and one reason line. When a quote exists, the reason line contains the quote in quotation marks. | happy | DOM per row |
| AC-B-7 | Given there are no rows because classification has never run for this owner, then the page shows a distinct state that says classification has not run yet (or that the switch is off), NOT "You're all caught up". | error (Tier 1 adjacent) | Switches OFF in config -> page text; no "caught up" string |
| AC-B-8 | Given classification ran and nothing is open, then the page shows an "all caught up" state, and still shows the "Answered by your reply (n)" group when n > 0. | edge | Fixture |
| AC-B-9 | Given the read fails (server error, DB down), then the page shows an error state with a retry, not an empty list and not a crash. | error | Force fn to throw -> text "Couldn't load" + Retry button |
| AC-B-10 | Given rows have been hidden by "What shows" settings, then the header shows "What shows · N hidden" with N equal to the number excluded by AC-D-5..D-8. | reconciliation | Count vs fixture |
| AC-B-11 | Given a long title, sender or chat name, then it truncates with an ellipsis and the full text is in `title=`. Nothing causes horizontal page scroll. | edge | Playwright overflow check |
| AC-B-12 | Given dark mode (`.dark`), then every new element uses tokens (no raw Tailwind colours such as `bg-orange-600`). | edge | Code grep of new files for `-[0-9]{3}\b` colour classes |
| AC-B-13 | Given a row, then row order within a section is newest item time first (item_at, never capture time). | happy | Fixture with 3 times |
