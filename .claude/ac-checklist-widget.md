# Acceptance Criteria — In-Chat Checklist Widget

> Written by an independent AC agent (cold read). Adversarial: these are written to be
> *failed*, not to describe the design. Every AC is binary and observable.
> Status: COMPLETE — 70 ACs across sections A, B, C, D, E, G, H. **Section F (delete + restore) is
> deliberately absent** following a mid-writing scope change; see the SCOPE CHANGE block before section E.
> Numbering is continuous 1–70 with no reused numbers.

## Vocabulary used below
- **Checklist message** = a `HuddleMessage` carrying the new 6th renderable field (working name
  `checklist`) alongside the existing `checkIn` / `artifacts` / `attachments` / `toolUses` / `confirmAsk`.
- **Row** = one task line: `[ ] Title ............ (pill)`.
- **Pill** = the single right-hand status control; tapping opens a dropdown with
  ▶ Doing / ⏸ Backlog / ⏹ Parking lot. **Three items — there is no ✕ Delete.**
- **Mirror lag** = the ~1–3s async journey→Huddle `pg_net` propagation window.

## Ground-truth corrections (spot-checked this session, cold)
Three claims in the brief were re-verified against source. Two hold; one is wrong and it changes section E.
- **HOLDS** — `store.ts:273` is verbatim `confirmAsk: m.confirmAsk ?? next[i].confirmAsk`, inside
  `upsertAgentMessage`'s in-place branch, alongside the same `??` for `artifacts` and `toolUses`.
- **HOLDS** — `BoardView.tsx:688-689` is exactly the parking-lot toggle described:
  off → `{ tags: tags.filter(x => x !== "parking-lot") }`, on → `{ tags:[...tags,'parking-lot'], status:'BACKLOG' }`.
  Note the toggle-OFF patch sends **only `tags`** — it does not restore a status. `isParked` (line 65)
  is `(t.tags ?? []).includes("parking-lot")`, confirming parked is a tag, not a lane.
- **WRONG, corrected** — the brief says the durable back-fill poll "does NOT dedupe". The *store action*
  `addAgentMessage` doesn't, but the **call site does**: `HuddleApp.tsx:101-102` reads
  `// addAgentMessage does not dedupe; skip anything already rendered` then
  `if (useHuddleStore.getState().messages.some(m => m.id === mid)) return;`. So there IS a masking
  id-guard at that site. This matters two ways and section E attacks both: (a) the guard **masks** the
  duplicate-append failure only while ids match exactly (`mid = \`a-${t.id}-${i}\``) — change the id
  scheme or reply ordering and it silently stops masking; (b) far worse, the back-fill's **inline reply
  DTO** (`HuddleApp.tsx:74-78`) declares only `agentId / text / artifacts? / confirmAsk?` — no
  `checklist`. A widget that is not added there does not "get clobbered", it **never re-materialises at
  all** after reload/away, and the id-guard actively hides that by suppressing the re-add.

---

## A. Intent gating — checklist vs prose

The default is prose. The widget is opt-in and must be *asked for*, not inferred from the shape of the answer.

1. Given a 1:1 or group huddle, when the user sends "what are the tasks I asked for related to my kids",
   then the reply message has `checklist === undefined` (not `[]`, not a zero-row widget) and the tasks
   appear as prose in `text`.
2. Given the same huddle, when the user sends "give me a checklist of the tasks I need to track for my
   kids", then exactly one reply message in that turn carries a `checklist` field with ≥1 row and the
   rendered bubble shows a checkbox and a status pill on every row.
3. Given a request using the word **"list"** but not "checklist" — "list the tasks for my kids" — then the
   reply is prose (`checklist === undefined`). "List" alone must not trip the widget.
4. Given a request using the word "checklist" as **task content**, not as a format — "add 'make a
   checklist for school supplies' to my tasks" — then no `checklist` field is emitted and a task is
   created by the normal path.
5. Given a prose answer in turn N listing tasks T1..Tn, when the user replies "now as a checklist" with no
   restated scope, then the emitted checklist contains **exactly T1..Tn by task id** — not a fresh query,
   not a superset, not a re-ranked set. Binary check: the id set of turn N+1's checklist equals the id set
   the turn-N prose was built from.
6. Given a checklist answer in turn N, when the user replies "just tell me in words", then turn N+1 is
   prose AND the turn-N checklist message remains fully interactive — its checkboxes and pills still
   mutate. A superseding prose turn must not disable, grey out, or strip the earlier widget.
7. Given a group huddle where the router selects two or more responders and the user asked for a
   checklist, then **at most one** `checklist` field exists across all replies in that turn. Verify by
   counting replies with a non-undefined `checklist` in the turn payload: the count is exactly 1.
8. Given that same multi-responder turn, when a second agent attempts the same checklist render, then it
   is a no-op claimed through the existing per-turn action ledger (`claimAction`, the mechanism already
   guarding `schedule_reminder` / `send_email`) — not a new parallel dedupe mechanism, and not two widgets
   listing the same task ids.
9. Given a checklist request whose scope matches **zero** tasks, then the reply renders an explicit empty
   state naming the scope ("no tasks tagged kids") and `checklist` is either undefined or an explicitly
   empty widget — never a widget with phantom/placeholder rows, and never a silent prose fallback that
   leaves the user unsure whether the filter ran.
10. Given a checklist request, when the model emits a row whose `taskId` does not resolve to a task the
    caller owns, then that row is **dropped server-side before the reply is persisted** and the remaining
    rows render. Attack: a hallucinated uuid must never reach the client as a tappable row, because every
    control on it mutates a real task.
11. Given a checklist request made **by voice during a ceremony** (the `chat.ceremony_transcript` path,
    which renders no message bubbles), then the answer degrades to spoken prose and no orphaned widget
    row is written. Binary: no `checklist` field appears in any `ceremony_transcript` row.
12. Given a checklist request, then the intent decision is observable in the turn record (a logged
    `checklistIntent: true/false` with a reason, in the same spirit as `decision.reason` for routing) so a
    misfire can be diagnosed without re-running the model. Without this, every A-section failure is
    unfalsifiable.

---

## B. Row rendering + layout stability

"Stable" is the owner's word, so these are geometry ACs with numbers, not adjectives. The reference
container is the chat column at its **narrowest supported width**; every check below is run at both that
width and a wide desktop width.

13. Given a checklist of 10 rows, when rendered, then every row's height is identical (measured
    `getBoundingClientRect().height` equal across all 10 within 1px) and the checkbox left edge and pill
    right edge are on the same x for all rows.
14. Given a checklist of exactly 1 row, then that row's height and control positions equal those of a row
    in the 10-row case (same 1px tolerance). A single-row widget must not render taller, shorter, or
    differently aligned.
15. Given a row whose task title is 200+ characters, then the title clamps to a fixed maximum line count,
    the row height stays equal to a short-title row, and the pill remains fully visible on the same line —
    it does not wrap below the title or leave the container.
16. Given a title containing one unbroken 80-character token (a URL or path), then it breaks or ellipsises
    inside the row; `document.scrollingElement.scrollWidth` does not exceed `clientWidth` and the message
    bubble shows no horizontal scrollbar.
17. Given any checklist at the narrowest supported chat width, then the title has a non-zero rendered
    width — the checkbox plus pill must never consume the row such that the title clamps to 0px. Binary:
    title element `clientWidth > 0` at every tested width.
18. Given a checklist of 40 rows, then the widget's behaviour is one decided, observable outcome: either
    all 40 render inline, or it caps at N and shows a control labelled with the exact remaining count
    ("+22 more"). Anything that produces a nested inner scroll region that captures the chat scroll fails.
19. Given a row whose status the user has just changed to DOING, then the row **stays in its original
    position** in the list. The checklist is a snapshot, not a live-filtered query — no reorder, no
    disappearance, no re-sort. (This is the single most likely violation of "stable layout": a naive
    implementation re-derives the list from status.)
20. Given a row the user has just checked (DONE), then the row remains present with a checked box and its
    height is unchanged (strike-through/opacity styling must not alter layout metrics).
21. Given the pill on the **last** row of a checklist that sits at the bottom of the scroll viewport, when
    the dropdown is opened, then all three items (▶ Doing / ⏸ Backlog / ⏹ Parking lot) are
    within the viewport and none is clipped by the message bubble's bounds. This requires the portal
    behaviour that `dropdown-menu.tsx` already gives `BoardView.tsx:647+` — reuse it, do not hand-roll a
    positioned div inside the bubble.
22. Given the dropdown is open, when the user scrolls the chat, then the menu either follows its trigger or
    closes — it never detaches and floats over an unrelated message.
23. Given a checklist, when rendered in light and in dark theme, then the checkbox, the pill icon, and any
    parked/blocked emphasis all meet the same contrast treatment already used by `BoardView`'s tag chips —
    verified by screenshot in both themes, not by reading CSS.
24. Given a touch viewport, then the checkbox and the pill each present a hit target of at least 44x44 CSS
    px (padding may extend beyond the visual glyph), and the two targets do not overlap — a mis-tap must
    not be able to toggle DONE when the user aimed at the pill.
25. Given a checklist rendered alongside the other renderables on the same message (an `artifacts` chip row
    and a `toolUses` breadcrumb), then all three render, in a stable order, with no overlap and no
    collapsed spacing.

## Two more ground-truth corrections found while writing C/D (both change the ACs)

- **The status set is 9 values, not 6.** `BoardView.tsx:27-33` `COLUMNS` maps
  `BACKLOG|TODO|PLANNING` → Backlog, `READY|UP_NEXT` → Up next, then `DOING`, `IN_REVIEW`, `BLOCKED`,
  `DONE`. The brief listed only the six `setStatus` values. A checklist row can therefore arrive holding
  `TODO`, `PLANNING`, or `READY`, none of which is one of the four dropdown actions — the pill must still
  render something for them (AC 30).
- **`waitForMirrorSync` cannot verify a tags patch — and ⏹ is a tags patch.** Its signature is
  `(taskId, patch: { status?; assigned_agent?; category? })`; it reads **only** those three fields.
  `applyMove` calls `waitForMirrorSync(taskId, patch)` with the same object, so for the parking-lot
  toggle-OFF patch (`{ tags: [...] }`, no status) all three guards are `undefined` → trivially true → it
  returns the **first** `getBoardTasks` read after a single 700ms delay and `setTasks(fresh)` overwrites
  the optimistic tag change with a read that is very likely still pre-sync. **Parking-lot is the one
  control the existing mirror-verify does not actually cover**, and the checklist's ⏹ inherits that hole
  verbatim if it reuses `applyMove` unchanged. AC 45 pins it.
- Confirmed-good behaviour worth preserving: on mirror-sync **timeout** `applyMove` deliberately keeps the
  optimistic state rather than clobbering with a known-stale read (comment at `BoardView.tsx:288-290`).
  AC 44 requires the checklist inherit exactly that, not a rollback.

---

## C. Each control's mutation

All of these assert against journey `public.tasks` (canonical) as the observable, read back after the
mirror settles — not against the widget's own rendering, which is the thing under test.

26. Given a row for task T in status BACKLOG, when the user ticks the checkbox, then T's status in journey
    is `DONE` and the mutation went through `updateBoardTask` — the same server fn `BoardView.applyMove`
    calls. Binary: no new task-write endpoint appears in the diff.
27. Given any agent turn, any auto-work pass, or any tool call, when it attempts to set a checklist row to
    `DONE`, then the write is refused server-side. Per the repo rule *DONE is set ONLY by the user, by
    hand*, the checkbox is the user's hand — so the checklist tool schema must not accept `DONE` as a
    settable value at all, and a crafted payload carrying it returns an error rather than writing.
    Binary: a direct server-fn call with `{status:'DONE'}` originating from the agent path is rejected.
28. Given a row for task T, when the user selects ▶ Doing, then T's status is `DOING`. Given the WIP cap of
    1 DOING per agent that `autowork.server.ts` enforces, then the user-initiated move is either allowed
    (cap applies to automation only) or refused with a visible reason — it must never silently no-op. The
    row's final rendered state must match the DB either way.
29. Given a row for task T, when the user selects ⏸ Backlog, then T's status is `BACKLOG` **and any
    `parking-lot` tag is removed**. Attack: parked tasks also live in BACKLOG, so a ⏸ that leaves the tag
    on produces a task that looks un-parked in the widget while `autowork` and journey's nightly planner
    keep skipping it — an invisible dead task. Binary: `'parking-lot' = ANY(tags)` is false after ⏸.
30. Given a row whose task is in `TODO`, `PLANNING`, `READY`, `UP_NEXT`, `IN_REVIEW`, or `BLOCKED` — none
    of which the three-item dropdown can express — then the pill still renders a defined, distinguishable
    icon/label for that status and opening the dropdown does not crash or show a blank/undefined item.
31. Given a row for task T carrying tags `['kids','school']`, when the user selects ⏹ Parking lot, then T's
    tags are exactly `['kids','school','parking-lot']` (order-insensitive, no drops, no duplicates) and
    status is `BACKLOG` — matching `BoardView.tsx:689`.
32. Given a row for task T that is already parked, when the user selects ⏹ again (toggle off), then
    `parking-lot` is removed and `['kids','school']` survive intact. Binary: the tag array before and
    after differs by exactly the one element.
33. Given a parked task, then its pill renders the **parked** icon (⏹), not the backlog icon (⏸), even
    though its status is `BACKLOG`. Parked-ness is a tag, so a pill driven only by `status` will show the
    wrong glyph for every parked row — the pill must read `tags.includes('parking-lot')` first, the way
    `isParked` (`BoardView.tsx:65`) does.
34. **Stale-snapshot attack (the sharpest one in this section).** Given a checklist message rendered two
    hours ago whose row for task T embedded `tags:['kids']`, and given the user has since added `urgent`
    to T from the Board, when the user now selects ⏹ on that stale row, then the resulting tags are
    `['kids','urgent','parking-lot']` — **not** `['kids','parking-lot']`. The tag patch must be computed
    from a freshly-read task, never from the frozen array captured in the message payload. A naive
    `[...row.tags,'parking-lot']` silently deletes every tag added since render.
35. Given the same stale row, when the user selects ⏸/▶, then the status write is unconditional (that's
    safe) but the row re-renders from the fresh read, so a task the user already moved elsewhere does not
    silently regress to a stale-looking state afterwards.
36. **(Scope guard, replaces the withdrawn delete ACs.)** Given the shipped widget, then the dropdown
    contains exactly three items and **no destructive action of any kind** — no delete, no archive, no
    ✕. Binary: the rendered menu has 3 children; the diff contains no `DELETE` against journey
    `public.tasks` and no call to any delete/archive server fn.
37. Given the full set of controls (checkbox, ▶, ⏸, ⏹), then **every** one resolves to a single
    `updateBoardTask({caller, taskId, ...patch})` call. Binary: no new mutation server fn, no new
    route, and no schema/migration change appears in the diff. The feature adds a renderable field, a
    renderer, and an agent tool — nothing more.
38. Given every control above, then **no code path writes `tasks.journey_tasks` directly**. The mirror is a
    single-writer read-model fed only by the sync webhook. Binary: the diff contains no INSERT/UPDATE/
    DELETE against `tasks.journey_tasks` outside the existing webhook route.

---

## D. Optimistic update, rollback, and the mirror-sync lag

39. Given the user actuates any control, then the row's new state renders **immediately** (before the
    server fn resolves), reusing the optimistic-then-reconcile shape of `applyMove` rather than a fresh
    one. Binary: the row shows the new pill icon within one animation frame of the tap.
40. Given a mutation is in flight, then that row's checkbox and pill are disabled and show the busy
    affordance already used by `ConfirmAskRow` (`Loader2` spinner, per-action `busy` state) — and **only
    that row's** controls are disabled. Binary: a second row remains actuatable during the first row's
    in-flight call.
41. Given a mutation is in flight on row R, when the user taps R's control again (double-tap, or taps a
    different dropdown item), then exactly one server call is issued for that gesture. Binary: request
    count == 1.
42. Given `updateBoardTask` returns `{ok:false}` or throws, then the row reverts to its **exact** prior
    visual state — pill glyph, checkbox, and any parked emphasis — and a toast carries the server's error
    text. Binary: the row's rendered state after failure is byte-identical to a screenshot taken before
    the tap.
43. Given a successful write, then during the mirror-sync window (first read is at minimum 700ms; budget
    is 6 attempts × 700ms ≈ 4.2s) the row shows the optimistic state, not a spinner that outlives the
    write and not a flicker back to the old value. Binary: no intermediate frame shows the pre-tap glyph.
44. Given the write succeeded but the mirror has **not** caught up within the retry budget, then the
    widget **keeps the optimistic state** — it must not roll back. Rolling back on a mirror-lag timeout
    would show stale data while journey (canonical) already holds the new value. This inherits
    `applyMove`'s existing deliberate choice; an implementation that treats `waitForMirrorSync → null` as
    failure fails this AC.
45. **The tags hole.** Given the user selects ⏹ (a tags-carrying patch), then the widget's mirror-verify
    actually verifies the **tag** change — i.e. `waitForMirrorSync` is extended to compare `tags` (or the
    checklist uses a verifier that does), so it cannot return the first, pre-sync read and repaint the row
    without the tag. Binary: after ⏹, no frame between the tap and settle shows the row un-parked. This
    fails today if `applyMove` is reused verbatim; fixing it in `applyMove` fixes the Board too and is the
    extend-not-duplicate answer.
46. Given two different rows are actuated within the same second, then both mutations land, both rows
    settle to their own correct state, and neither reconcile read overwrites the other's optimistic value.
    Binary: both tasks show the intended status in journey after settle.
47. Given the same task T appears in **two** checklist messages in the same thread (the user asked twice),
    when T is mutated from one of them, then the other message's row for T shows the same status once
    reconciled — never two visible widgets disagreeing about T. This requires per-row live state keyed by
    **taskId**, not by message — see section E.
48. Given the network is offline, when the user actuates a control, then the row reverts and the toast
    says so; no state is left permanently busy and no control is left permanently disabled.

---

## SCOPE CHANGE — ✕ Delete withdrawn (recorded mid-document, before section E)

The owner withdrew the ✕ Delete control while this doc was being written. Consequences, recorded so the
numbering is not confusing:

- **Section F (delete + restore) does not exist.** Lettering is unchanged — the doc runs
  **A, B, C, D, E, G, H**, with **F simply absent**. Nothing was renumbered; ACs are numbered 1..N
  continuously and no numbers were reused.
- The dropdown is **three items**: ▶ Doing / ⏸ Backlog / ⏹ Parking lot. ACs 21 and 30 and the Vocabulary
  entry were edited in place to say three.
- ACs 36–37 were **rewritten** from delete-behaviour into scope guards asserting that no destructive
  action and no new mutation exist. The original 36/37 delete ACs are gone, not renumbered.
- All `task_events` / `log_task_changes` / `task_topic_mappings` CASCADE ground truth is out of scope and
  appears nowhere in this document.
- **The feature is now: one new renderable field on `HuddleMessage`, one renderer component, one agent
  tool to emit it, and correct reuse of `updateBoardTask`. Zero new mutations, zero DB changes, nothing
  irreversible.** Every remaining risk is therefore a *client-state* or *intent* risk — which is why
  section E is now the highest-risk area in the build, not a footnote.

---

## E. Client-state survival — now the highest-risk area in the build

With no new mutation to get wrong, the way this feature breaks is that the widget's live state is
destroyed by the message pipeline underneath it. There are two mapping sites with different semantics and
a store action that overwrites fields; the checklist carries strictly more client state than any existing
renderable (per-row status + per-row busy), so it is more exposed than `confirmAsk` ever was.

49. **The `store.ts:273` clobber, direct.** Given a rendered checklist message, when
    `upsertAgentMessage` runs again for that same message id with a payload whose `checklist` is
    `undefined` (a later partial/streaming reply that does not re-supply it), then the widget is still
    rendered afterwards. Binary: the checklist is visible before and after; it does not vanish into plain
    text. Concretely this requires `checklist: m.checklist ?? next[i].checklist` be added at line 273
    alongside the existing `artifacts` / `toolUses` / `confirmAsk` — **but see AC 50, which is why that
    line alone is not sufficient.**
50. **The `??` preserve is necessary and NOT sufficient — the real attack.** Given a rendered checklist
    where the user has already moved row T to DOING, when `upsertAgentMessage` runs for that message id
    with a payload that **does** re-supply `checklist` (a fresh value, so `m.checklist ?? …` takes the
    *server's* copy), then row T still shows DOING. Binary: the user's change survives. A fresh server
    value legitimately wins under `??` semantics and will silently revert every row the user has touched
    — the `??` guard protects against *absence*, not against *staleness*, and per-row status is exactly
    the case where the server copy is the stale one.
51. **The structural fix this implies.** Given the above, then per-row live status is held in a store
    slice keyed by **`taskId`**, not inside the `HuddleMessage` object. Binary: grepping the message
    object shows the checklist payload carries only immutable descriptors (taskId, title, and the status
    *at render time*), while current status is read from the taskId-keyed slice. This is also what makes
    AC 47 (two messages listing the same task agree) true by construction rather than by luck, and it
    mirrors the reason `resolveConfirmAsk` is keyed by messageId: the key must match the thing that owns
    the state. Here the owner is the task, not the message.
52. Given a mutation is in flight on row T, when `upsertAgentMessage` runs for that message, then the
    busy/disabled state for T is preserved. Binary: the control does not re-enable mid-flight — a
    re-enabled control is a double-fire waiting to happen (and defeats AC 41).
53. **The back-fill DTO gap — the widget silently never returns.** Given a checklist message that was
    delivered while the user was away or on another device, when the durable back-fill poll renders it,
    then the checklist renders as a widget. This requires adding `checklist` to the inline reply DTO at
    `HuddleApp.tsx:74-78`, which today declares only `agentId / text / artifacts? / confirmAsk?`. Binary:
    after a full page reload, the checklist message shows checkboxes and pills, not bare prose. **This is
    a silent failure, not a crash** — the row-mapping code drops an undeclared field without error.
54. Given the new field must be added to **both** reply→message mapping sites, then a test exercises each
    independently: (a) `HuddleView.applyTurnStream` (~750-815, `upsertAgent`) for the live path, and (b)
    the `HuddleApp` back-fill poll (~66-115, `addAgentMessage`) for the reload/away path. Binary: two
    separate passing checks. A single test through the live path cannot catch AC 53.
55. **Masking-guard bypass.** Given the back-fill site's id-guard
    (`if (messages.some(m => m.id === mid)) return;`, `HuddleApp.tsx:102`) is bypassed — because reply
    ordering changed, so `mid = \`a-${t.id}-${i}\`` resolves differently, or because the live path used a
    different id scheme — then the result is still exactly one checklist widget for that reply. Binary:
    querying the DOM for checklist widgets belonging to that turn returns 1, never 2. Two live widgets
    over the same task ids means two sets of controls mutating the same task with divergent optimistic
    state. The guard is currently the only thing preventing this and it is incidental, not designed.
56. Given a page reload, then the checklist rehydrates from the durable turn payload with each row's
    status re-read from current task state — **not** from the status frozen in the payload at render
    time. Binary: a task moved on the Board between render and reload shows the Board's status after
    reload.
57. Given the turn payload now carries a 6th renderable, then the seroval encode/decode round-trip of
    `getTurnUpdates` / `getAllTurnUpdates` preserves it intact. Binary: a harness decode of a
    checklist-bearing turn yields the same row array that was sent (the `test-agent-serverfn` decoder is
    the existing tool for this; note its `CONST` map has a known boolean-index defect, so assert on the
    row array, not on a bare boolean).

---

## G. Permissions and scoping

The widget puts task-mutating controls into a message, and messages are model-authored. Ownership must be
enforced where the write happens, not where the row is drawn.

58. Given a checklist request, then every row rendered belongs to the caller, resolved through the same
    caller→email path the task tools already use (`resolveTaskEmail(caller)`). Binary: rows returned for
    caller A never include a task owned by B.
59. **Server-side enforcement, not UI filtering.** Given a hand-crafted call to the mutation server fn
    carrying a `taskId` the caller does not own, then the write is refused and journey is unchanged.
    Binary: the task's status/tags are identical before and after the crafted call. UI-side filtering
    alone fails this AC — the row IDs are visible to anyone who can read the turn payload.
60. Given the model emits a row for a task id that exists but belongs to another user, then it is dropped
    before persistence (per AC 10) **and** the mutation path would independently refuse it. Binary: both
    layers reject; neither is relied on alone.
61. Given the caller cannot be resolved to an identity, then the checklist renders read-only or not at all
    — it never renders controls whose owner is unknown. Binary: no actuatable control exists without a
    resolved caller.
62. Given a checklist rendered in a group huddle, then its rows are scoped to the huddle's user exactly as
    in a 1:1 — group membership is agents, not additional people, and must not widen task visibility.

---

## H. Regression guard

63. Given the 5 pre-existing renderables (`checkIn`, `artifacts`, `attachments`, `toolUses`, `confirmAsk`),
    then each still renders and behaves identically after the change. Binary: a message carrying each one
    renders the same as on `origin/main` (screenshot comparison), and `confirmAsk`'s Confirm/Backlog
    actions still resolve via `resolveConfirmAsk`.
64. Given the `store.ts` in-place update branch gains a `checklist` line, then the existing `artifacts` /
    `toolUses` / `confirmAsk` preserve behaviour is unchanged. Binary: a streaming update that omits
    `artifacts` still keeps them attached.
65. Given `BoardView` is untouched by this feature except for any shared extraction, then the Board's
    drag-drop, status menus, tag chips, tag filter, and artifact chips all still work. Binary: a Board
    UAT pass matching the pre-change run.
66. **If `waitForMirrorSync` is extended to cover `tags` (AC 45),** then that change is made in the shared
    function and the Board's parking-lot toggle is re-verified — extend-existing, not a checklist-local
    copy. Binary: exactly one `waitForMirrorSync` exists in the codebase after the change.
67. Given the change, then no second writer into journey or into the mirror is introduced (AC 38), no new
    org secret is minted, and no new table, column, enum value, or migration is added. Binary: the diff
    touches no `.sql`/migration path.
68. Given the change, then the offline router test (`npm run test:router`) and any existing store tests
    still pass unchanged. Binary: same pass count as before.
69. Given the checklist is emitted by a new agent tool, then that tool does not appear as a spurious
    `toolUses` breadcrumb chip that clutters every checklist reply — matching the existing exclusion
    precedent for `tool_catalog` in `breadcrumbToolsFor`. Binary: a checklist reply shows no breadcrumb
    for the render tool itself.
70. Given the new tool is added to the agent tool surface, then it is wired into **both** dispatch paths
    (OpenAI and Lovable), consistent with every other tool in this codebase. Binary: grep finds the tool
    in both. A tool wired into one path silently never fires for agents routed through the other.

---

## Highest-risk areas

1. **Per-row client state being overwritten by the message pipeline (§E, ACs 49-52).** This is the top
   risk and the scope change made it worse, not better — with delete gone, client-state correctness is
   most of what remains to get wrong. The subtle part is that the obvious fix is a trap: copying the
   `confirmAsk: m.confirmAsk ?? next[i].confirmAsk` pattern to `checklist` looks like the whole job and
   is not, because `??` defends against a field being *absent* while the checklist's real exposure is a
   *present but stale* server copy reverting rows the user just changed. `confirmAsk` never had this
   problem — its only client state is a boolean `resolved` that moves one way. The checklist holds N
   mutable statuses plus N busy flags, and every one of them is a chance to revert a user action with no
   error anywhere. The structural answer (AC 51 — key live state by `taskId`, outside the message) also
   dissolves AC 47 and AC 55 for free, which is a strong signal it is the right shape.

2. **Silent widget loss on the durable back-fill path (§E, ACs 53-55).** Two mapping sites re-declare the
   reply DTO inline, and the back-fill one at `HuddleApp.tsx:74-78` lists only four fields. An undeclared
   field is dropped with no error, no warning, and no crash — so the failure appears only as "the
   checklist turns into plain text after I reload", which is easy to dismiss as cosmetic and hard to
   attribute. It is made harder to notice by the id-guard at line 102, which suppresses the re-add
   entirely. This is a known-shape bug in this codebase (the same duplicated-DTO pattern), and it will be
   missed by any test that only drives the live streaming path.

3. **Intent gating being unfalsifiable (§A, ACs 1-5 and 12).** The checklist/prose boundary is a
   first-class requirement but it is enforced by a model decision, so without the logged
   `checklistIntent` + reason (AC 12) every failure in section A is un-diagnosable after the fact — the
   exact trap this repo already hit with routing, where six rounds of prompt tweaks chased what turned
   out to be a quota fallback until `decision.reason` was surfaced. The specific edges most likely to
   break are the ones where the words look like the widget but the intent is not it ("list the tasks",
   "add 'make a checklist' to my tasks") and the follow-up turn "now as a checklist", which must reuse
   the previous turn's exact task-id set rather than re-querying — a re-query silently returns a
   different set and looks correct.

## Open questions for the owner

Only the things source cannot settle. Each blocks a specific AC.

1. **What does un-ticking a checked row do?** (blocks AC 26.) Ticking sets `DONE`. Un-ticking has no
   defined target: revert to the status the row held before ticking (requires remembering it), or fall
   back to `BACKLOG`? Source cannot answer — `BoardView` has no checkbox, so there is no precedent. Note
   the repo rule is that DONE is set only by the user by hand, which says nothing about un-setting.
2. **Does the user-initiated ▶ Doing bypass the WIP cap of 1 DOING per agent?** (blocks AC 28.)
   `autowork.server.ts` enforces the cap for automation. A user tapping ▶ on a second task is either
   allowed (cap is an automation throttle) or must be refused with a visible reason. Silently no-oping is
   the one outcome that is definitely wrong; which of the other two is a product call.
3. **Row cap for a long checklist.** (blocks AC 18.) Does a 40-task checklist render all 40 inline, or cap
   at N with a "+X more"? If capped, what is N? This is a layout-feel decision the owner's "stable
   layout" phrasing does not resolve.
4. **Is the checklist a snapshot or a live view?** (blocks AC 19 and AC 56.) These ACs assume a snapshot:
   rows never reorder or disappear when status changes, and the set is fixed at render. Confirm that is
   intended — the alternative (rows drop out once DONE) is a defensible product choice but it directly
   contradicts "stable layout" and would change ACs 19, 47, and 56.
5. **Narrowest supported chat-column width.** (blocks ACs 13-17, 24.) The geometry ACs need one number to
   test against. What is the minimum viewport/column width the widget must stay intact at?



