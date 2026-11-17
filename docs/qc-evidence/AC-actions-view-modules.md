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

## C. Row controls

Desktop labels are **Draft reply** (email rows), **Open in Teams** (Teams rows), **Add as task**, **Edit**, **Done**,
**Dismiss** and **Wrong?**. Every write is optimistic, one write in flight per row, and rolls back with a toast on
failure. That is the `ProposalChecklistItem` contract.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-C-1 | Given any Add as task / Edit / Done / Dismiss / triage action on an Actions row, then it calls the existing `actOnProposalFn` with a `prop-…` id, and never `updateBoardTask` or a new endpoint. | extend-not-duplicate | Network: request goes to the actOnProposalFn server-fn id; code grep shows no new action fn |
| AC-C-2 | Given an open row, when **Add as task** is clicked, then exactly one journey task is created (`chat.task_proposals.task_id` set, state `approved`), the row shows "Added to board", and it leaves the open list on the next load. Given a double-click, or the same row approved on two devices, then still exactly one task. | happy / edge (Tier 1 adjacent) | Supabase: `select count(*) from public.tasks where title ILIKE 'Test-%<marker>%'` = 1 after 2 rapid clicks; proposal row state |
| AC-C-3 | Given Add as task on a to-do whose normalised title already exists on the board, then no second task is created and the toast "It was already on your board." shows (the existing `alreadyOnBoard` path). | edge | Toast text; task count unchanged |
| AC-C-4 | Given **Edit**, then the title becomes the same inline input (max 200 characters). Enter or blur saves, Esc cancels, and an empty or unchanged value saves nothing. A saved edit sets `title` and `edited=true` and keeps `original_title`. | happy / edge | DB row before/after; Esc -> no request |
| AC-C-5 | Given **Done**, then the proposal state becomes `completed` and the row leaves the open list. No journey task is created. | happy | DB state; tasks count unchanged |
| AC-C-6 | Given **Dismiss**, then the state becomes `dismissed`, the row leaves the list, and the existing F15 rule holds: the same normalised to-do is not proposed again from any source. | happy / regression | Re-run the classifier pass on a second source item with the same to-do -> no new open row |
| AC-C-7 | Given a write fails (server returns ok:false, or throws), then the row returns to exactly its prior state and a toast shows the server's error text. | error | Force failure -> DOM equals pre-click; toast |
| AC-C-8 | Given a row whose server state was already changed elsewhere (another device), when the owner acts on it, then server truth wins and the row shows the server state (AC-5.6 behaviour). | edge | Two sessions |
| AC-C-9 | Given an **email row from the EDS mailbox** (`draftable`), when **Draft reply** is clicked, then `saveEmailReplyDraftFn` is called with that email's `chat.email_replies` id. A threaded reply draft appears in Outlook Drafts, nothing is sent, and the row shows a link to the draft (`webLink`). The row stays in "Needs your reply", marked "Draft saved", until a sent reply is detected. Then it moves to "Answered by your reply". | happy | Graph: draft exists in Drafts; Sent Items unchanged; email_replies.status = drafted |
| AC-C-10 | Given an **email row from the work mailbox** (feed id, `isFeedId(graph_message_id)` true), when Draft reply is clicked, then NO Graph draft call is made. The row expands to show "Iris's suggested reply" (`email_replies.proposed_reply`, verbatim) with **Copy reply**, **Open in Outlook** and **Redo with Iris**, plus the line that Huddle cannot save drafts in the work mailbox and nothing is ever sent. | happy | Network: no createReply call; DOM text equals the DB proposed_reply |
| AC-C-11 | Given Copy reply, then the clipboard holds exactly the displayed reply text (no quoted original, no extra whitespace) and a toast confirms. Given clipboard permission is denied, then an error toast shows and the text stays selectable. | happy / error | `navigator.clipboard.readText()` in Playwright with permission; denied context |
| AC-C-12 | Given a work-mailbox row with no `proposed_reply`, then Draft reply shows "Iris hasn't suggested a reply yet" and only **Redo with Iris**. It never shows an empty reply box with Copy. | edge | Fixture |
| AC-C-13 | Given **Redo with Iris**, then a turn goes to Iris's 1:1 (`dm-iris-chase`) carrying that email's id. Her reply calls the existing `propose_email_reply` tool, so the stored `proposed_reply` updates and the Actions row shows the new text on refresh. No second drafting path is added. | extend | chat.pending_turns row in dm-iris-chase; email_replies.proposed_reply changed |
| AC-C-14 | Given an email row with no `chat.email_replies` row at all, then Draft reply behaves as decided in OQ-12, and never creates a second reply-ledger row type. | edge | DB: no new table/kind |
| AC-C-15 | Given a **Teams row** whose stored `webUrl` passes the existing `safeLink` rule (`^https://[^\s"<>]+$`), then **Open in Teams** is an `<a target="_blank" rel="noopener noreferrer">` to exactly that URL. Given null, `http:`, `javascript:` or a value containing a space or `<`, then no Open in Teams control renders (no dead button). Clicking it does not change the row's state. | happy / security | DOM href; fixtures for each bad URL -> 0 links |
| AC-C-16 | Given **Wrong?**, then a panel opens with one-tap reason chips: "Not mine to do", "Already handled", "Not an action", "Wrong section", "Stop flagging this list" (the last only on list/CC email rows), an optional text box (max length stated, for example 500), and Send. Send with only a chip and no text is allowed. | happy | DOM |
| AC-C-17 (Tier 1) | Given Wrong? is sent, then a correction record is written once, owner-scoped, holding the item key (source + thread key + latest message id), the chosen reason, the optional text, and the time. The row leaves the list immediately. The ledger row and its stored content are NOT deleted or altered. | happy | DB: one correction row; ledger row unchanged (content_hash, content equal before/after) |
| AC-C-18 (Tier 1) | Given a correction exists, when the next classification pass runs on the same unchanged item, then the item does not reappear in Actions. Given a NEW message arrives in that thread later (new latest message id), then the item is judged again and may reappear. | edge | Run the pass twice; then add a message fixture |
| AC-C-19 (Tier 1) | Given Wrong? was sent, when the owner taps **Undo** (toast) or restores it from a "Corrected" list, then the correction is marked withdrawn (or deleted), and the row returns to the SAME section with the same title. There is no duplicate row. | edge (reversible) | DB + DOM |
| AC-C-20 (Tier 1) | Given "Stop flagging this list", then later items from the same list are hidden from Actions and counted in "N hidden" (never silently dropped), and the owner can turn it back on from "What shows". The scope of "list" is decided in OQ-11. | edge | Fixture of two items from the same list |
| AC-C-21 (Tier 1) | Given Wrong? text, then it is treated as data. When it is ever passed to a model, it goes in the input, not the instructions, and it is never logged (the AC-3.8 content-never-logged rule). | security | grep logs during a run for the text: 0 hits |
| AC-C-22 | Given the owner is signed out (`caller.entra_email` missing), then every write control is disabled, as in ProposalChecklistItem. | auth | DOM disabled attr |
| AC-C-23 | Given a meeting row that is untriaged, then it shows "To sort" with **Mine / For someone / Skip** (the existing triage). Mine leads to the normal row buttons. For someone takes a name of at most 80 characters (empty saves nothing) and the row leaves Actions. Skip dismisses it and the row leaves. | happy / regression | actOnProposalFn action=triage payloads; DB state |

## D. Filters and "What shows" settings

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-D-1 | Given the filter pill group, then it shows All / Email / Teams / Meetings, each with a count, using the ViewSwitcher inline pill anatomy. Selecting one shows only that source's rows. All is the default on first visit. | happy | DOM |
| AC-D-2 | Given counts, then Email + Teams + Meetings = All, and the sum of section counts (excluding "Answered by your reply") = All. Both hold after every action (Done, Dismiss, Wrong?, filter change). | reconciliation (Tier 1) | Arithmetic on DOM after each step of a scripted run |
| AC-D-3 | Given a filter is active and the owner acts on a row, then the counts update without a reload, and the filter stays selected. | edge | DOM |
| AC-D-4 | Given "What shows", then a panel opens with: "Hide these kinds of mail": Meeting invites and calendar replies / Timekeeping and timesheet reminders / Verification and sign-in codes (all three ON by default); "Teams": "Hide group and meeting chats I never wrote in", ON by default, with the sub-line "Unless someone @mentioned you"; "Sources": Email / Teams / Meeting notes (all ON by default). | happy | DOM default checked states with a fresh owner (no stored setting) |
| AC-D-5 | Given the three mail toggles, then they hide items whose stored classifier category is `meeting_invite` / `timekeeping` / `verification_code` respectively (the exact enum values of the existing SCHEMA), and nothing else. Hidden items count in "N hidden". | Tier 1 (classification admitted) | Fixture: one item of each of the 11 categories; only those 3 hidden |
| AC-D-6 | Given a mail toggle is switched OFF, then the hidden items of that category appear immediately (no reclassification needed, because the category is already stored), in their correct section. | edge | DOM after toggle; no model call (network/log count) |
| AC-D-7 | Given "What shows" settings, then they are stored per owner server-side (they survive a reload and a second device) and are NOT localStorage-only. A failed save rolls the checkbox back and shows a toast. | happy / error | Second browser context reads the same setting |
| AC-D-8 | Given a Source toggle is OFF, then that source's rows, and its filter pill, are hidden. The other sources' counts are unchanged. | happy | DOM |
| AC-D-9 | Given the uninvolved-chat switch, then its behaviour is defined by section E-U and the spelling table, including that turning it OFF does not delete anything and that a stored OFF survives a reload. | Tier 1 | See E-U |
| AC-D-10 | Given the settings panel, then it uses the bell "What counts" anatomy (header row plus checkbox labels), and "Done" closes it. | regression-of-pattern | Visual compare |

## Owner answers that settle section 0 and the open questions (2026-11-16, all final)

X-1, X-2: approved (1A). **X-3: approved** -- Priorities and Schedule also leave the desktop header pills; the pills
read Huddle, Board, Files, Modules. **X-4: approved** -- the chat checklist says "Add as task" / "Done" too. **X-5:
approved** -- the phone top bar shows the view's name on EVERY view. **X-6: approved** -- Done / Dismiss in Actions also
settles the bell's row for the same item (only when acted on from Actions). **X-7: approved** -- classification runs on
the existing heartbeat for ledger rows, behind a per-owner setting that defaults ON for the owner only, with a daily
cost cap setting. X-8, X-9: approved by the design. AC-M-13 therefore reads: the header pills are exactly Huddle,
Board, Files, Modules.

Storage (OQ-2, OQ-11): NO new table. The verdict lives in `chat.correspondence_ledger.result_ids.action` of the
thread's latest message row; Wrong? is a nullable `owner_correction JSONB` on `chat.task_proposals` and
`chat.correspondence_ledger`; "What shows" is a nullable `actions_settings JSONB` on the existing
`chat.attention_settings` (the bell's per-owner settings row). Every Actions item is backed by a `chat.task_proposals`
row (meeting items already are), so the existing `actOnProposalFn` handles every row button.

OQ-11 ("Stop flagging this list"): scope = the sender address of the latest OTHER message of a CC / list email; stored
in `actions_settings.hiddenSenders`, listed in What shows with a switch to turn each back on. OQ-12 (no reply-ledger
row): Draft reply opens Iris's 1:1 with a prefilled ask to draft it (the existing reply path; she answers with
`propose_email_reply`). Nothing is sent automatically.

## E. What counts as "needs you" (Tier 1)

Definitions. *Thread*: an email conversation (needs-you `emailConversationKey`) or a Teams chat (`teams:<chatId>`).
*Classification key*: thread key + the ledger id of the thread's latest message. *Window start*: the latest Monday
00:00 in the owner's zone (default America/New_York), a setting. *Admitted*: a verdict that passed `admitActionVerdict`.

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-E-1 | Given the source tree, then there is ONE in-app classifier module (`lib/correspondence/action-classify.ts`) holding the email (on To / CC-or-list) and Teams instructions and the answer schema, and `scripts/action-scan-steps.ts` imports them instead of holding its own copies. Its header names it canonical; `needs-you.ts` names it as the successor for the heartbeat. | extend-not-duplicate | grep: the instruction strings exist in exactly one file |
| AC-E-2 | Given a model answer with `open_item: true` and a `quote` found word for word (after whitespace and typographic-quote folding) in an OTHER message of the thread (email: the latest OTHER message or its forwarded part; Teams: any OTHER message), then the verdict is admitted `open`. | happy (Tier 1) | unit test |
| AC-E-3 | Given `open_item: true` and a quote that is NOT found word for word, or is null, or shorter than 8 characters, then the item is NOT shown and is counted as "not checked yet". | Tier 1 guard | unit test + mutation |
| AC-E-4 | Given `open_item: false`, then the verdict is `none` and the thread is not shown. Given the owner already replied after the latest OTHER message and nothing is still owed, then it is counted in "Answered by your reply", never in a section. | happy | unit test |
| AC-E-5 | Given a malformed answer (not an object, `kind` or `category` outside the enum, `open_item` not boolean), then the verdict is `not_checked` (never `open`). Given the model call throws, then nothing is stored for that key and the thread is retried on a later heartbeat. | error (Tier 1) | unit test |
| AC-E-6 | Given an admitted email verdict with kind `reply` or `both` -> "Needs your reply"; kind `action` with the owner on To (direct / group / unknown) -> "To-do for you"; kind `action` with the owner only CC'd or via a list -> "FYI with an action". Teams: `reply`/`both` -> "Needs your reply", `action` -> "To-do for you". Untriaged or Mine meeting action items -> "From meetings". | happy | unit test of `actionSectionFor` |
| AC-E-7 | Given a thread whose classification key already has a stored verdict, then no model call is made for it. Given a new message arrives (new latest id), then it is classified again. | cost | unit test: call count |
| AC-E-8 | Given the per-owner classify setting is OFF, or the day's model calls reached the daily cap, then no model call is made; unclassified threads are counted "not checked yet", never shown as open and never dropped silently. | cost / honesty | unit test |
| AC-E-9 | Given now in the owner's zone, then the window start is the most recent Monday 00:00 at or before now (on a Monday it is that same day's 00:00). | edge | unit test incl. a Monday and a Sunday |
| AC-E-10 | Given an admitted open verdict, then exactly one `chat.task_proposals` row backs it (created or attached through the EXISTING `proposeFromSource` path with the quote as evidence), and re-running the step creates no second row. A to-do already open on the board backs nothing and the item counts as resolved. | Tier 1 / dedup | unit test against the in-memory store |
| AC-E-11 | Given a thread resolved by the existing RESOLUTION rule (a decided proposal or a dismissed bell row covering its latest OTHER message), then it is not classified and not shown. | regression | unit test |
| AC-E-12 | Given a store-only `sent` row, then it is never classified. | regression | unit test |
| AC-E-13 | Given an item's backing proposal is in a decided state (approved / completed / dismissed / delegated), then the item is not listed. | happy | unit test |
| AC-E-14 | Given an owner correction (Wrong?) on an item whose classification key is unchanged, then the item is not listed; after Undo it is listed again in the same section; after a newer message arrives it is judged again. | Tier 1 (reversible) | unit test + mutation |

## E-U. Uninvolved-chat filter (Tier 1) -- ONE rule, `chatInvolvement` in `report-from-ledger.ts`

Rule: a Teams **group, meeting or channel** chat is hidden when the owner's id is known, he wrote nothing in ANY stored
message of the chat, and no stored message @mentions him. 1:1 chats always show. Missing owner id or missing mention
data on any message -> show (fail OPEN). Applied before any AI call when the switch is ON. Default ON.

Spelling table (chat id shapes from Graph; mention shapes from Graph `chatMessageMention.mentioned`; the at-sign is
written `(at)` here only):

| # | Input | Expected | Source |
|---|---|---|---|
| S-1 | id `19:a_b(at)unq.gbl.spaces`, nobody wrote as owner | show (one_on_one) | Graph 1:1 chat id shape |
| S-2 | id `19:abc(at)thread.v2`, owner known, never wrote, mention arrays all present and empty | HIDE | group chat |
| S-3 | id `19:meeting_xyz(at)thread.v2`, same facts as S-2 | HIDE | meeting chat |
| S-4 | id `19:abc(at)thread.tacv2`, same facts | HIDE (channel treated like a group, owner 2026-11-16) | channel |
| S-5 | id `19:ABC(at)THREAD.V2` (upper case) | same as S-2 | ids compared case-insensitively |
| S-6 | S-2 but one message `fromOwner: true` | show (owner_sent) | |
| S-7 | S-2 but a message's sender id equals the owner id in different case | show (owner_sent) | |
| S-8 | S-2 but a message mentions the owner's user id | show (owner_mentioned) | |
| S-9 | S-2 but the only mention is a conversation / team / tag mention (no `user`) | HIDE (not the owner) | `mentionUserIds` skips them |
| S-10 | S-2 but one message has no `mentionedUserIds` field | show (cant_tell_no_mention_data) | fail open |
| S-11 | S-2 but no owner id configured and none on any line | show (cant_tell_owner_unknown) | fail open |
| S-12 | S-2 but one message `fromOwner: null` | show (cant_tell_owner_unknown) | fail open |
| S-13 | id with no known suffix (`19:abc(at)foo`) | show (not covered) | |
| S-14 | the owner wrote only in a message OLDER than the window | show (any stored message counts) | owner: "any stored message" |
| S-15 | switch OFF, chat is S-2 | show, and it is classified like any other chat | AC-D-9 |

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-EU-1 | Given every row S-1..S-15, then the rule (with the switch applied by the plan) returns the expected hide/show. | Tier 1 | unit test, one assertion per row; mutation on the channel clause and a fail-open clause |
| AC-EU-2 | Given the switch ON, then hidden chats never reach the model and are counted in "N hidden" (What shows). | cost / honesty | unit test: call count 0 for S-2 |
| AC-EU-3 | Given the rule is used by the report (`scripts/action-scan-steps.ts`) and by Actions, then both call the same function; there is no second copy. | extend | grep |

## F. Auth and scope

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-F-1 | Given no caller email, then the Actions read returns `signedOut` and no rows; every write control is disabled. | auth | unit + DOM |
| AC-F-2 | Given caller A, then the read returns only rows in A's owner scope (`callerOwners`), and Wrong? / Undo / settings writes are owner-scoped in their SQL WHERE. | auth (Tier 1) | code read of every query |
| AC-F-3 | Given Open in Teams, then the href passes `safeLink` (https only, no space, quote or angle bracket). | security | unit test |
| AC-F-4 | Given any log line written by the new code, then it carries counts and reason names only -- no title, quote, subject, sender, chat name or id. | privacy (public repo) | code read |

## G. Phone (390px)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-G-1 | Given 390x844, then each row ends in the existing "Proposed" menu chip (ProposalChecklistItem anatomy, min-h-11) whose menu holds Draft reply (email) / Open in Teams (Teams), Add as task, Edit, Done, Dismiss, Wrong?. No row of labelled buttons is rendered. | happy | screenshot + DOM |
| AC-G-2 | Given 390px, then the source filter scrolls sideways inside its own pill group; nothing scrolls the page horizontally. | edge | `scrollWidth <= clientWidth` |
| AC-G-3 | Given 390px and view actions / priorities / schedule / board / files, then the top bar shows "Actions" / "Priorities" / "Schedule" / "Board" / "Files"; on the huddle view it shows the huddle's name as before. | happy | DOM text |

## H. Performance and cost

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-H-1 | Given the Actions read, then it makes no model call (it reads stored verdicts only). | cost | code read |
| AC-H-2 | Given the heartbeat, then the classify step runs at most once per 10 minutes per process, inside the ingest hook, never throws, and logs counts only. | perf | code read + unit test of the throttle |
| AC-H-3 | Given the daily cap N (setting, default 150), then at most N model calls are made per owner per day (owner-zone day). | cost | unit test |

## I. Regressions

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-I-1 | Priorities opened from Modules renders the same `PrioritiesView` (same WidgetPage, same rows) as before. | regression | UAT screenshot |
| AC-I-2 | Schedule opened from Modules renders the same `ScheduleView`. Agent "Open Priorities" / "Open Schedule" nav links still switch the view. | regression | UAT + code read (NAV_VIEWS unchanged) |
| AC-I-3 | The Apps launcher still lists Polish, Sidecar, Prompto; Polish opens full width. | regression | UAT |
| AC-I-4 | The bell's count, list, Dismiss and "What counts" behave as before when nothing is done in Actions. | regression | attention.test.ts green |
| AC-I-5 | The chat checklist proposal rows keep every behaviour (optimistic write, rollback, triage) with only the labels "Approve" -> "Add as task" and "Mark done" -> "Done" changed. | regression | diff read |
| AC-I-6 | Iris's email-reply card (Save to Drafts / Copy reply / Edit first / No reply needed) is unchanged. | regression | diff: HuddleView EmailReplyRow untouched |
| AC-I-7 | The open-items report (`proposals-preview.yml` step=action) keeps working: same instructions, same schema, now imported. | regression | typecheck of the script |
| AC-I-8 | Done / Dismiss from Actions settles the bell row for the same email message or Teams chat (X-6); Done / Dismiss from the chat checklist does not. | reconciliation | code read + unit test of the target mapping |
| AC-I-9 | `markProcessed` keeps a stored `result_ids.action` verdict when the item is (re)processed. | regression (Tier 1) | SQL test |

**Count: sections A-D 60 ACs (part 1-2) + E 14 + E-U 3 (+15 spelling rows) + F 4 + G 3 + H 3 + I 9 = 96 ACs.**
