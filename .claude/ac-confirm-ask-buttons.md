# Acceptance Criteria — Confirm-Ask Buttons + Greeting Fix

Status: COMPLETE — 47 criteria drafted and cross-checked against live code (huddle-extension-app,
current working tree). Do not implement from this file; it is the adversarial AC pass only.

## Verification log (source-of-truth checks, not the plan's framing)

Read directly, before writing any criterion below:
- `src/features/huddle/lib/tasks/autowork.server.ts` (1-190, 660-680) — `confirmIntentDirective()`
  (125-158) confirmed: opens `"This task is on the board for you: ..."` — **no greeting today**, matches
  the reported bug. `turnPayload()` (83-116) confirmed, sets `targetAgentId: agent` (line 96) and is
  called at lines 381 and 670 (both `confirmIntentDirective` sites) — matches plan.
- `src/features/huddle/lib/tasks/task-agent-tools.ts` — `CONFIRM_TASK_INTENT_TOOL` at 37-56 confirmed,
  no `propose_task_intent`/`PROPOSE_TASK_INTENT_TOOL` exists anywhere in `src/` yet (grepped) — genuinely
  new work.
- `src/features/huddle/lib/huddle.functions.ts`:
  - `isPlainConfirmation` at 556-564 confirmed (≤40 chars, no `?`, negation-word blocklist).
  - `mergedTools` (3139-3158): `CONFIRM_TASK_INTENT_TOOL`/`PROPOSE_APPROACH_TOOL` are **unconditional**,
    no gate — confirms propose_task_intent should be equally unconditional if it mirrors these.
  - `confirm_task_intent` OpenAI dispatch at 3363-3420 confirmed (dual-write: `confirmTaskIntent()` +
    `invokeJourneyTool(update_task, {definition_of_done})` at 3392-3401).
  - `lovableTools.confirm_task_intent` at 4371-4425, `lovableTools.propose_approach` immediately after
    (4428-4476) — confirms the plan's insertion point.
  - **The "6 duplicate Reply-shape" claim is TRUE and precisely located**, all inline (no shared type
    alias): lines 521-526 (`replies` field on a turn-state type), 792-800 (`type Reply` in the sequential
    engine), 6278 (`TurnUpdateDTO.replies`), 6306-6310 (`getTurnUpdates` mapped shape), 6361
    (`BackfillTurn.replies`), 6390 (`getAllTurnUpdates` mapped shape). Every one independently declares
    `artifacts?: { id: string; name: string }[]` — a `confirmAsk` field must be added to all six or it
    silently vanishes on whichever code path was missed.
  - `attachArtifacts` (zod schema 177-180) is gated `if (data.attachArtifacts?.length && nextId ===
    data.targetAgentId)` at line 5237 — **built for a delegation-integration turn surfacing a WORKER
    agent's artifact on the INTEGRATOR's reply**, i.e. artifacts NOT produced by the replying agent's own
    tool call this turn. `propose_task_intent` is the OPPOSITE case: the SAME agent calls it in the SAME
    turn as its ask message — structurally identical to `create_artifact`, whose chip data (`replyArtifacts`,
    lines 5218-5233) is derived from `r.toolUses` where `r` is that one agent's own per-turn
    `AgentTurnResult` (confirmed by reading `mergeAgentResult`, line 5168 — `r` is per-agent, not global).
    **This means the plan's step 5 justification for using `attachArtifacts` instead of a toolUses
    derivation does not hold up** — a toolUses-derived `confirmAsk` (mirroring `create_artifact`) is the
    smaller, more consistent change (no new zod field, no `turnPayload` signature change, no
    `autowork.server.ts` threading) and avoids overloading `attachArtifacts`'s existing, differently-scoped
    purpose. Written up as AC-9/AC-10 below rather than assumed either way — the implementer must justify
    whichever mechanism is chosen, and it must be tested for correctness regardless.
- `src/features/huddle/lib/tasks/tasks.server.ts`: `proposed_dod` column (line 152) confirmed to have
  **no writer anywhere in the codebase except the reset-to-NULL** in `resetEngagementOnReassignment`
  (line 1097) — `proposeTaskDod()` would be the first real writer, exactly as claimed.
  **Scoping gap found (not in the plan):** `getTaskEngagementStates`/`getTaskEngagementState` (701-715)
  query `tasks.task_engagement_state` filtered ONLY by `task_id` — **no `user_email` filter at all**. Any
  new server function that reads `proposed_dod`/`confirm_status` by taskId alone, without independently
  verifying the resolved caller email owns that task, would let a forged/guessed taskId read (and,
  depending on the write path, act on) another user's engagement state. `confirmTaskIntent`/`markConfirmAsked`
  etc. write by `task_id` alone too (`ON CONFLICT (task_id)` — task_id is the sole key, not composite with
  email). Ownership enforcement is NOT free here the way it might look from `board.functions.ts`.
- `src/features/huddle/lib/tasks/board.functions.ts`: `updateBoardTask` (35-69) confirmed as the direct
  `invokeJourneyTool` pattern to mirror. **Important:** it does NOT itself check that `taskId` belongs to
  `caller` — it forwards `caller` to journey's `update_task` and relies ENTIRELY on journey's backend
  (a different repo) to enforce ownership via the resolved identity. Its own doc-comment (line 44-46)
  confirms **`tags` is a full-replace, not a merge** — "journey update_task REPLACES tags with this array."
- `src/features/huddle/lib/artifacts/artifacts.functions.ts`: every server fn resolves
  `callerEmail(data.caller)` (13-16, via `resolveTaskEmail`) before acting — the established discipline
  is "resolve real email first, then scope reads/writes to it," which the Azure-PG task-engagement table
  does NOT do automatically (see scoping gap above) — the new functions must do this scoping themselves.
- `src/features/huddle/components/BoardView.tsx`: the parking-lot tag mechanism **already fully exists**
  or the board (not just documented in CLAUDE.md) — `isParked` (line 65), a toggle at 605/670-671 that
  does `onMove(id, {tags:[...tags,'parking-lot'], status:'BACKLOG'})` to park and
  `onMove(id, {tags: tags.filter(x=>x!=='parking-lot')})` to un-park. Confirms full-tag-set append is the
  right, already-proven pattern to mirror for the new Archive server function, AND confirms the existing
  toggle avoids duplicate tags only because it's a toggle (branches on current state) — a plain "Archive"
  button firing the add-branch twice would NOT get this protection for free; it must check
  `tags.includes("parking-lot")` itself.
- `src/features/huddle/store.ts`: `upsertAgentMessage` (246-267) confirmed — spreads `...next[i]` then
  explicitly overwrites only `text`, `artifacts`, `toolUses`. Any field on the incoming `m` not in that
  explicit list (a new `confirmAsk` included) is **silently dropped** on every in-place streaming update
  after the first insert — exactly the bug class the brief warned about, verified real here.
- `src/features/huddle/components/HuddleView.tsx`: the `m.artifacts` button block is at 415-430 (chip
  pattern to mirror for the new button row); compose state `text`/`setText` at 503, `inputRef` at 524,
  JSX binding at 1096-1098.

---

## Acceptance Criteria

### A. Greeting fix

1. Given the current `confirmIntentDirective()` source in `autowork.server.ts`, when the fix ships, then
   the literal directive string passed to the agent contains an explicit instruction to open the
   confirm-ask message with a brief natural greeting (e.g. "start with a short greeting," "say hello
   first") BEFORE the "say what you believe they're trying to accomplish" instruction — checkable by
   reading the string constant itself, not by inference from a comment or commit message.
2. Given a live confirm-ask turn is driven through `test-agent-serverfn` (or equivalent direct
   `sendHuddleMessage`/enqueue call) with the updated directive, when the agent's reply is captured, then
   the reply text opens with a natural greeting clause (e.g. "Hey," "Hi there," a name-address) preceding
   the assumed-action statement, in at least 2 of 3 sample runs (model output is non-deterministic; a
   single miss is not proof of failure, but 0/3 is). **Unverifiable by a Playwright/browser check; needs
   the test-agent-serverfn harness output as evidence** (paste the actual reply text).
3. Given the existing prose ("You're trying to...") is REPLACED rather than layered, when reviewed
   against this repo's "Agent prompts are ADDITIVE-ONLY" rule (CLAUDE.md), then confirm this specific
   edit is exempt (it's the shared runtime directive string in `autowork.server.ts`, not an agent
   platform-snapshot/persona prompt) — flag for explicit sign-off if the edit removes/shortens any
   existing instruction rather than only prepending the greeting instruction.

### B. `propose_task_intent` tool — schema, registration, timing, write scope

4. Given `src/features/huddle/lib/tasks/task-agent-tools.ts`, when `PROPOSE_TASK_INTENT_TOOL` is added,
   then its `parameters.required` is exactly `["task_id", "definition_of_done"]` (matching
   `CONFIRM_TASK_INTENT_TOOL`'s field names so the same DoD text can flow to either call unmodified).
5. Given `huddle.functions.ts`'s OpenAI-path `mergedTools` array (~3139-3158), when `propose_task_intent`
   is registered, then it is unconditional — present in the array with no surrounding `if` gate — exactly
   like `CONFIRM_TASK_INTENT_TOOL` and `PROPOSE_APPROACH_TOOL` on the same lines, checkable by reading the
   array literal.
6. Given the Lovable-path `lovableTools` object, when `propose_task_intent` is registered, then
   `lovableTools.propose_task_intent` is assigned unconditionally (no `if` guard) in the same statement
   block as `lovableTools.confirm_task_intent`/`lovableTools.propose_approach`, with an inputSchema of
   `z.object({ task_id: z.string(), definition_of_done: z.string() })`.
7. Given both dispatch paths, when grepped for `"confirm_task_intent"` vs `"propose_task_intent"`, then
   both tool names appear in the SAME set of guard conditions (backend selection, journey-enabled checks,
   etc.) — no code path offers one without the other. (Verified today: CONFIRM_TASK_INTENT_TOOL carries
   no such guard, so the default expectation is "none needed," but this criterion exists to catch one
   being accidentally added only for one tool.)
8. Given an agent turn where the confirm-ask directive fires, when the agent responds, then a call to
   `propose_task_intent` appears in that SAME turn's `toolUses` (or equivalent per-turn record) BEFORE any
   user reply exists in history for that task — i.e. it must NOT require a prior user turn. Verify by
   driving one live confirm-ask turn (test-agent-serverfn or a direct autowork-triggered enqueue) with
   empty prior history for that task and confirming `propose_task_intent` fired with `ok:true`.
9. Given `proposeTaskDod(taskId, dod)` (new `tasks.server.ts` function), when it runs, then the SQL
   touches ONLY the `proposed_dod` column — read the query text and confirm `confirm_status`,
   `confirmed_dod`, and `approach_status` are absent from its `SET`/`INSERT` column list (contrast with
   `confirmTaskIntent`, lines 1071-1083, which explicitly sets `confirm_status='confirmed'` +
   `confirmed_dod` — `proposeTaskDod` must NOT do either).
10. Given a task that already has `confirm_status='confirmed'` (user already confirmed via the OLD
    prose path or a prior button click), when `propose_task_intent` fires again on a later message for
    the same task (e.g. agent re-asks after a task reassignment reset), then `proposeTaskDod` still only
    touches `proposed_dod` and does not revert `confirm_status` back to an earlier state — read the SQL to
    confirm no `confirm_status` write exists in this function at all (not merely "doesn't downgrade it").
11. Given the identified scoping gap (engagement-state reads/writes have no `user_email` filter), when
    `proposeTaskDod` is implemented, then it still writes keyed by `task_id` alone (matching the existing
    table's actual key), so this criterion is about NOT quietly introducing an email-scoped variant that
    would diverge from `confirmTaskIntent`'s existing key shape — the ownership check belongs in the new
    confirm/backlog/archive server functions (see F), not retrofitted here.

### C. `confirmAsk` field, threading mechanism, and the 6-site consistency

12. Given `src/features/huddle/data/seed.ts`'s `HuddleMessage` interface, when `confirmAsk` is added, then
    it is optional (`confirmAsk?: {...}`) and its shape includes at minimum `taskId: string`,
    `taskTitle: string`, `proposedDod: string`, and a `resolved?: boolean` flag — read the interface to
    confirm the field exists with these members.
13. Given the "6 duplicate Reply-shape" sites (huddle.functions.ts lines ~521-526, ~792-800, ~6278,
    ~6306-6310, ~6361, ~6390 — confirmed above by direct read), when `confirmAsk` is threaded through the
    server→client reply pipeline, then a matching `confirmAsk?: {...}` (or equivalently-typed) field is
    added to ALL SIX declarations, not a subset. Checkable mechanically: `grep -n "artifacts?: { id:
    string; name: string }" src/features/huddle/lib/huddle.functions.ts` must return the same line count
    before and after, and every one of those lines/blocks must have a sibling `confirmAsk` addition
    (grep for it and diff the two counts — they must match, 6-for-6).
14. Given a group-huddle turn (not the 1:1 confirm-ask case) where no agent sends a confirm-ask this turn,
    when the reply is constructed, then `confirmAsk` is `undefined` on every reply object (not `null`,
    not an empty object) — checkable by reading the construction site's conditional and confirming it
    only assigns `confirmAsk` when a genuine proposal exists this turn.
15. Given the mechanism-choice question raised in the verification log (toolUses-derivation vs.
    `attachArtifacts`-style injection), when the implementation is read, then EXACTLY ONE of the following
    two conditions holds, not a hybrid: (a) **toolUses-derivation** — `confirmAsk` is derived from that
    replying agent's OWN `r.toolUses` this turn (a successful `propose_task_intent` call), mirroring
    `replyArtifacts`'s derivation at lines ~5218-5233, with NO changes required to `turnPayload()`'s
    signature, the `attachArtifacts` zod field, or the `autowork.server.ts` call sites; or (b)
    **attachArtifacts-style injection** — a NEW distinct field (not a reuse of `attachArtifacts` itself,
    which has a different, already-documented purpose) is threaded through `turnPayload()`,
    `autowork.server.ts`'s two call sites, and the zod schema, gated the same way (`nextId ===
    data.targetAgentId`). Reject an implementation that overloads the EXISTING `attachArtifacts` field for
    this second, semantically different purpose (a confirm-ask is not "another agent's already-produced
    artifact being referenced").
16. Given option (a) is chosen (the recommended, smaller change per the verification log), when a
    `propose_task_intent` call FAILS (`ok:false`, e.g. `sign-in required` or a DB error), then `confirmAsk`
    is NOT attached to that reply — the button row must never appear over a task whose DoD proposal never
    actually persisted. Verify by simulating a failed `proposeTaskDod` call (e.g. unresolvable caller
    email) and confirming the reply carries no `confirmAsk`.
17. Given a confirm-ask reply that DOES carry `confirmAsk`, when the same turn's agent ALSO happens to
    call `create_artifact` (edge case — not expected by the directive, but not structurally prevented),
    then both `artifacts` and `confirmAsk` can coexist on the same reply object without one clobbering the
    other — read the reply-construction site to confirm they're independent object keys, not sharing a
    variable.

### D. Store merge correctness

18. Given `store.ts`'s `addAgentMessage` (237-242), when a message carrying `confirmAsk` is added for the
    FIRST time (message id not yet in `messages`), then the full object (including `confirmAsk`) is
    pushed as-is — trivially true since `addAgentMessage` spreads nothing and pushes `m` directly; include
    this as a regression guard in case that function is ever refactored to a partial-field pattern like
    `upsertAgentMessage`.
19. Given `store.ts`'s `upsertAgentMessage` (246-267) — confirmed by direct read to explicitly list only
    `text`, `artifacts`, `toolUses` when merging into an EXISTING message (`next[i] = {...next[i], text,
    artifacts: ..., toolUses: ...}`) — when `confirmAsk` is added to `HuddleMessage`, then this merge
    function is edited to explicitly include `confirmAsk: m.confirmAsk ?? next[i].confirmAsk` (or
    equivalent). **Reject any fix that adds the field to the type but not to this merge function** — the
    default JS spread-then-partial-overwrite behavior silently drops it, exactly the bug class already
    proven for other fields in this function.
20. Given a streaming/partial turn where message id `X` is first inserted WITHOUT `confirmAsk` (e.g. an
    earlier partial chunk before the tool call resolves) and a LATER upsert call for the same id DOES
    carry `confirmAsk`, when `upsertAgentMessage` runs the second time, then the message ends up WITH
    `confirmAsk` populated (not stuck at the first partial's undefined) — this is the actual functional
    test of criterion 19, checkable by a unit test or a scripted two-call sequence against the store.
21. Given a message already marked `confirmAsk.resolved = true` client-side (user clicked a button), when
    a LATER poll/upsert re-delivers the same durable turn (e.g. `getTurnUpdates` backfill) WITHOUT a
    `resolved` flag on the wire payload (since resolution is a client-only action per the plan, not
    persisted server-side per message), then the merge must NOT clobber the client's `resolved:true` back
    to falsy — read whichever merge path handles this and confirm `resolved` state survives, or determine
    server-side persistence is required instead (see AC 34) and flag if it's missing.

### E. UI rendering and per-message task binding

22. Given `HuddleView.tsx`'s existing `m.artifacts` chip block (415-430), when the confirm-ask button row
    is added, then it is a sibling conditional block gated on `m.confirmAsk` (not `m.confirmAsk?.resolved
    === false` folded into the same JSX branch as artifacts) — Confirm/Revise/Backlog/Archive render only
    when `m.confirmAsk` exists AND `!m.confirmAsk.resolved`.
23. Given a message with `m.confirmAsk` present and `resolved: true`, when rendered, then the four action
    buttons do NOT render — instead a resolved-state indicator (badge/text) is shown. **Unverifiable
    without a browser** — needs a screenshot or DOM snapshot from a live/Playwright run as evidence.
24. Given two confirm-ask messages exist in the SAME 1:1 huddle for two DIFFERENT tasks (taskId A on an
    older message, taskId B on a newer one), when the user scrolls up and clicks Confirm on the OLDER
    message (A), then the server call fires with taskId A, not taskId B or "whichever task is currently
    most recent" — checkable by reading the button's onClick handler and confirming it closes over
    `m.confirmAsk.taskId` (the specific message's own field), never a hook/state value derived from "the
    latest task" or "the currently active task in this huddle."
25. Given the same two-message scenario, when unrelated conversation (non-confirm-ask messages) has
    occurred between them in the same huddle, then clicking Confirm on the older message (A) still resolves
    correctly — this specifically guards against any implementation that keys off "the last confirm-ask
    message in the array" rather than the clicked message's own bound data. **Live check needs
    test-agent-serverfn to seed two confirm-asks + a filler message, then a scripted click/server-fn call
    with A's taskId while B's confirm-ask also exists unresolved, confirming only A's task and A's message
    resolve.**
26. Given the four buttons, when Confirm/Backlog/Archive are clicked, then EACH independently calls its
    own dedicated server function bound to `m.confirmAsk.taskId` (not a single generic
    "act(taskId, action)" dispatcher whose action string could be mismatched/typo'd at a call site) OR, if
    a single dispatcher is used, that the action parameter is a typed union validated server-side —
    either is acceptable, but the button's own action intent must reach the server without relying on
    client-side trust alone (defense-in-depth against a modified DOM/devtools replay is out of scope, but
    a plain coding bug like "Backlog button's onClick calls the Archive fn" must not exist — read each
    onClick handler and confirm it calls the function matching its own label).

### F. Determinism, idempotency, staleness, and multi-tenant scoping (new server functions)

27. Given the new Confirm/Backlog/Archive server functions, when their source is read end-to-end, then
    NONE of them import or call anything from the agent-turn pipeline (`runHuddleTurn`, `sendHuddleMessage`,
    `enqueueTurn`, OpenAI/Lovable `generateText`/Responses calls, or any LLM client) — grep each new file
    for `openai`, `generateText`, `Responses`, `enqueueTurn` and confirm zero hits outside comments.
28. Given the same three functions, when driven live via a direct server-fn call (not through the chat UI),
    then the observed latency and behavior confirm no model round-trip occurred (sub-second-to-low-second
    completion dominated by the journey proxy HTTP hop, not an LLM inference delay) — checkable by timing
    the call and comparing against a known agent-turn latency baseline (per this repo's CLAUDE.md,
    successful multi-agent turns run ~19-24s; a deterministic button action completing in under ~2s with
    zero tokens billed is the expected signature).
29. Given a task whose `task_engagement_state.confirm_status` is ALREADY `'confirmed'`, when the Confirm
    server function is called again for that taskId, then it returns a friendly idempotent no-op result
    (e.g. `{ok:true, alreadyConfirmed:true}` or similar) — it must NOT error, and must NOT re-run
    `confirmTaskIntent`/re-fire the journey `update_task` write a second time (or if it does re-fire, the
    write must be idempotent/harmless — verify by reading whether the function short-circuits BEFORE the
    journey call when already confirmed).
30. Given a task with NO `proposed_dod` stored (e.g. a reach-out sent before this feature existed, or the
    `propose_task_intent` call failed silently that turn), when the Confirm button is clicked, then the
    server function returns a clear, distinguishable error (e.g. `{ok:false, error:"stale"}` or a specific
    message) rather than confirming with an empty/undefined DoD, and the client surfaces this as a visible
    failure state (not a silent no-op that looks like success) — **the client-visible part is
    unverifiable without a browser; the server-function part is verifiable by calling it directly against
    a taskId with no engagement row.**
31. Given a task already at `status='BACKLOG'`, when the Backlog button's server function is called, then
    it returns an idempotent no-op (no duplicate `update_task` write, or a harmless repeat write) rather
    than erroring — verify by reading the function's status-check-first logic, and by calling it twice
    live against the same task and confirming the second call doesn't error or duplicate anything
    observable (e.g. no duplicate task-sync webhook side effects beyond the expected upsert).
32. Given a task that already has `"parking-lot"` in its `tags` array, when the Archive button's server
    function is called again, then the resulting tags array still contains `"parking-lot"` exactly ONCE
    (not twice) — verify by reading the function's tag-merge logic for an explicit `includes()` check (or
    equivalent Set-based dedup) before appending, mirroring the gap identified in the verification log
    against `BoardView.tsx`'s toggle (which avoids duplication only by virtue of being a toggle, not by
    deduping the array itself).
33. Given a double-click / rapid double-submit of the SAME button on the SAME message (e.g. network
    latency causes the user to click twice before the first response returns), when both requests reach
    the server, then the second either (a) is rejected/no-op due to the idempotency checks in 29/31/32, or
    (b) both succeed harmlessly because the underlying operation is naturally idempotent — either is
    acceptable, but the FAILURE MODE to explicitly test against is: two `update_task` calls racing such
    that the SECOND one (based on stale pre-fetched tags/status) overwrites the first's effect (e.g. two
    Archive clicks both reading tags without "parking-lot," both appending it once, second write racing
    the first — still ends up with one copy, but reasoning through this is required, not assumed). Also
    verify the CLIENT disables/hides the button immediately on click (before the response returns) as the
    primary double-submit guard — **unverifiable without a browser; needs a screenshot/interaction trace.**
34. Given the app is multi-tenant by email (per this repo's established discipline — every other
    `createServerFn` resolves `callerEmail`/`resolveTaskEmail` before scoping reads/writes, confirmed in
    `artifacts.functions.ts` lines 13-16 and used throughout), when ANY of the three new server functions
    is read, then each one: (a) resolves the caller's real email via `resolveTaskEmail(caller)` (or
    equivalent) BEFORE touching `task_engagement_state` or calling `invokeJourneyTool`, and (b) given the
    confirmed scoping gap that `getTaskEngagementState`/writes are keyed by `task_id` ALONE with no email
    filter, explicitly verifies the resolved caller email matches the stored `user_email` on that task's
    engagement row (or independently confirms task ownership via the mirror/journey) BEFORE acting —
    reject an implementation that only checks `caller?.entra_email` is non-empty (the `updateBoardTask`
    pattern) without this additional ownership check, since that pattern alone does not close the gap
    identified in the verification log for this specific table.
35. Given a forged/guessed taskId belonging to a DIFFERENT user (not the caller), when any of the three
    new server functions is called with that taskId and the CALLER's own valid caller/session, then the
    function returns an error/no-op and does NOT confirm, backlog, or archive the other user's task —
    live-verify with two distinct task ids from `azure-pg-query.yml` (read one real task's `user_email`
    that is NOT the test caller's email, then call the new confirm/backlog/archive server fn against that
    taskId using the test caller identity) and confirm it's rejected, not actioned. **This is the single
    highest-value live test in this whole AC set — do not skip it for a code-read-only check.**

### G. Revise path

36. Given the Revise button, when clicked, then it calls `setText(starter)` and
    `inputRef.current?.focus()` (or requests focus via the existing ref) and makes ZERO server-function
    calls — grep the Revise handler for any `createServerFn`/`invokeJourneyTool`/fetch call and confirm
    none exists; it is purely client-side state + focus.
37. Given a task title containing a double-quote character (e.g. `Review the "Q3 plan" doc`), when Revise
    is clicked, then the starter text correctly includes the title without breaking (e.g. no unescaped
    quote causing a rendering/template issue, no truncation at the quote character) — checkable by reading
    the starter-text template literal (plain JS template literals handle embedded `"` safely by
    construction; verify the implementation doesn't instead build this via unsafe string concatenation or
    JSON stringification that would double-escape it) and by a scripted check: construct the starter text
    for a title containing `"` and confirm the resulting string contains the literal title unmodified.
38. Given the compose textarea already has USER-TYPED text in it when Revise is clicked (user was mid-draft
    on something else), when the starter text is inserted, then define and verify the actual behavior:
    either it REPLACES the existing draft (simple `setText(starter)`) or it's rejected/warned — the plan
    specifies plain `setText(starter)`, which means an in-progress unrelated draft is silently overwritten.
    Flag this as a UX edge case worth explicit confirmation rather than assuming it's fine — at minimum,
    confirm the actual code path (does it check `text` is empty first, or unconditionally overwrite?).
39. Given Revise is clicked on message A (taskId A) while message B's (taskId B) confirm-ask buttons are
    also visible unresolved in the same view, when the starter text is inserted, then it references task
    A's title (the clicked message's own task), never task B's or the huddle's "current task" — same
    per-message-binding requirement as criterion 24, applied to Revise specifically.

### H. Backward compatibility

40. Given a pre-existing message (persisted before this feature shipped) that has no `confirmAsk` field at
    all (`undefined`, not present in the stored JSON), when it renders in `HuddleView.tsx` after the
    deploy, then it renders exactly as before — no crash, no empty button row, no "undefined" text —
    checkable by reading the conditional guard (`m.confirmAsk &&`) and confirming it fails safe on
    `undefined`/missing keys without throwing (e.g. no `m.confirmAsk.taskId` access outside the guarded
    block).
41. Given `getTurnUpdates`/`getAllTurnUpdates`'s mapped reply shapes (post-fix, now including
    `confirmAsk?`), when a row from BEFORE this feature shipped (no `confirmAsk` in its stored JSON) is
    read back, then the mapping code does not throw on the missing key (TypeScript optional access,
    runtime JSON deserialization naturally yields `undefined` for a missing key — verify no code assumes
    presence, e.g. no non-null assertion `t.confirmAsk!`).

### I. Mirror-lag / eventual-consistency UI feedback

42. Given the journey→Huddle mirror is eventually-consistent (~1-3s via `pg_net`, per this repo's
    established fact), when the user clicks Backlog or Archive, then define and verify what the UI shows
    immediately: if it optimistically shows "resolved"/success before the mirror catches up, confirm this
    is explicitly intentional (the journey WRITE itself — via `invokeJourneyTool`/`update_task` — is
    synchronous and authoritative; only the READ-BACK via the Azure-PG mirror lags), so showing immediate
    success is CORRECT (the write succeeded), not a race — but if any part of the confirm/backlog/archive
    flow instead re-reads the MIRROR to confirm success before showing resolved, that re-read must
    account for the lag (poll/retry, not a single immediate read) or it will show a false failure/stale
    state. Read the implementation to determine which of these two shapes it has, and confirm it's the
    former (write-then-optimistic-resolve) rather than the latter without retry logic.
43. Given the Board view reads the mirror (not journey directly) for its own display, when a user
    Backlog's a task via a confirm-ask button and then immediately opens the Board view, then the Board
    may show the OLD status for up to ~1-3s (expected, documented mirror lag) — this is NOT a bug to fix
    in this feature; confirm no new code path in this feature attempts to force-sync the mirror
    synchronously (which would be new, unrequested scope) — flag if the implementation adds any such
    synchronous-mirror-refresh logic as scope creep beyond what was asked.

### J. Silent-failure sweep (the standing risk this whole effort has been fighting)

44. Given `proposeTaskDod`'s call site inside the `propose_task_intent` dispatch handler (both OpenAI and
    Lovable paths), when the underlying DB write throws, then the tool result returned to the model is
    `{ok:false, error:...}` (never a swallowed exception that returns `{ok:true}` anyway) — mirror the
    existing `confirm_task_intent` handler's try/catch shape (3381-3419) exactly; grep the new handler for
    a bare `catch {}` or a catch block that doesn't propagate `ok:false`.
45. Given the new confirm/backlog/archive server functions each wrap an `invokeJourneyTool` call, when
    that call's `r.ok` is `false` (journey-side failure, e.g. RLS rejection, network error), then the
    server function returns `{ok:false, error: r.error}` to the client (not `{ok:true}` regardless of the
    journey result) — grep each function for how it handles `r.ok === false` and confirm it's surfaced,
    not swallowed.
46. Given `recordToolUse`/tool-use breadcrumbing exists for every other agent tool in this codebase
    (`confirm_task_intent`, `propose_approach`, etc. all call it), when `propose_task_intent` is added,
    then it also calls `recordToolUse` on both success and failure — so a "the agent said it asked for
    confirmation but propose_task_intent silently failed" scenario is visible in the same `toolUses` chip
    UI as every other tool, not a special silent exception to this pattern.
47. Given the store's `upsertAgentMessage`/`addAgentMessage` and the new resolved-state action (mark a
    specific message's `confirmAsk.resolved = true`), when the new store action is added, then it targets
    the message by its OWN id (not by taskId, which could theoretically appear on more than one message
    e.g. a re-ask after a stale confirm) — read the new action's implementation and confirm it does
    `messages.map(m => m.id === targetMessageId ? {...} : m)`, not a taskId-keyed update that could flip
    the wrong message's resolved state if the same task ever produces two confirm-ask messages.

---

## Summary of what needs LIVE verification (not just code-read) vs. what's browser-only

**Code-read-sufficient (an independent verifier with shell access can check all of these):**
1, 3, 4-21, 22, 26, 27-35 (server-function logic; 35 also needs a live DB read), 36-38 (partial),
40-41, 44-47.

**Needs a live `test-agent-serverfn`-style call (no browser required):**
2, 8, 25 (partial), 28, 29, 31, 32, 33 (server half), 35 (the live-DB-read half), 42.

**Needs an actual browser/Playwright run — flagged unverifiable in this dev environment without one:**
23, 24 (visual confirmation of correct binding after a real click), 25 (visual), 33 (client double-submit
guard), 38 (actual textarea behavior with existing draft text), 39 (visual). For each, the evidence that
WOULD satisfy it: a Playwright script driving the real HuddleView (via `run-uat.mjs`/`verify-uat.yml`
pattern already established in this repo) with a screenshot or DOM-state dump before/after each click,
plus console-error capture.
