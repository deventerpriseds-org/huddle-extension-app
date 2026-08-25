# Acceptance Criteria — General Widget Extension Path (Phase 1: chat thread)

Written by an INDEPENDENT AC agent (cold read of the code, no access to the implementer's plan).
Derived from: `seed.ts` (HuddleMessage), `HuddleView.tsx`, `HuddleApp.tsx`, `store.ts`,
`huddle.functions.ts`, and the bridge repo `android-bridge-template`.

Status: IN PROGRESS — appended incrementally.

---

## Section 0 — Ground-truth observations (facts, read from source, not inferred)

These are the facts the ACs below are built on. Each is cited so the implementer can check them.

**O1. There are exactly five renderable non-text fields today**, all optional flat fields on
`HuddleMessage` (`src/features/huddle/data/seed.ts:18-40`): `checkIn`, `artifacts`, `attachments`,
`toolUses`, `confirmAsk`. There is no envelope, no discriminated union, no registry — each is a
bespoke field with a bespoke render site.

**O2. The render dispatch is five hardcoded JSX conditionals in `MessageRow`**
(`HuddleView.tsx:447-573`), and they are NOT co-located or uniform:
- `m.attachments` renders in the **user** branch (line ~460), above the user bubble, right-aligned.
- `m.checkIn` renders in the **system** branch (line ~480) via `CheckInCard`, and returns EARLY —
  a system message with a checkIn renders the card *instead of* the text row.
- `m.artifacts`, `m.toolUses`, `m.confirmAsk` render in the **agent** branch, in that fixed order,
  after the text (lines ~532, ~547, ~571).
So "the renderable-field pattern" is really THREE different placements with different authorship
scoping. Any registry that assumes "widgets render under the agent bubble" silently changes where
`attachments` and `checkIn` appear.

**O3. `confirmAsk` carries CLIENT-ONLY state.** `seed.ts:40` types it
`{ taskId; taskTitle; proposedDod; resolved?: boolean }`, but every SERVER-side and transport type
omits `resolved` (`huddle.functions.ts:527, 805, 6479, 6512, 6568, 6599`; `HuddleView.tsx:756`;
`HuddleApp.tsx:77`). `resolved` is set purely client-side by `store.resolveConfirmAsk(messageId)`
(`store.ts:281-288`), keyed by **messageId, not taskId** (deliberate — comment at `store.ts:277`).

**O4. The store merge can CLOBBER that client state.** `upsertAgentMessage` (`store.ts:255-276`)
merges with `confirmAsk: m.confirmAsk ?? next[i].confirmAsk` — a fresh incoming value REPLACES the
stored one. The incoming value from a later poll has no `resolved`, so a re-upsert of an already
resolved message would flip the buttons back to live. It is currently masked only by the early-return
guard at `HuddleView.tsx:800` (`prev.text === reply.text && …`). This is a latent bug the widget
migration will either inherit or expose — see AC-12/AC-13.

**O5. There are TWO reply→message mapping sites, with DIFFERENT semantics.**
- `HuddleView.applyTurnStream` (`HuddleView.tsx:750-815`) — uses `upsertAgent`, updates in place,
  attaches `toolUses` from `result.toolUses`, has the redundant-write guard.
- `HuddleApp` durable back-fill poll (`HuddleApp.tsx:66-115`) — uses `addAgentMessage` (which "does
  not dedupe"), skips anything already rendered, and validates `AGENT_BY_ID[reply.agentId]`.
Both independently re-declare the reply DTO inline (`artifacts?`, `confirmAsk?`) and both
independently copy fields onto the message. Adding a sixth field today means editing BOTH. Only one
of them validates the agent id.

**O6. The server parses `confirmAsk` out of a tool-use `detail` JSON string**
(`huddle.functions.ts:5393-5419`): it finds a toolUse for the confirm-intent tool, `JSON.parse`s
`detail`, and on throw the catch comment says *"malformed detail -> no confirmAsk chip this reply;
never breaks the turn"*. So the current contract is: **a bad payload degrades to "no widget", never
to an error and never to a broken turn.**

**O7. Bridge side (phase 2) is a different data feed.** `android-bridge-template`'s widgets
(`app/src/main/java/com/bridgetemplate/widget/`) read **Supabase directly** via
`util/SupabaseTaskClient.kt` (journey's DB); chat widgets are fed by Huddle's turn payload
(Azure PG). `WidgetActionService.kt` has four parallel `when` blocks keyed on the same action
constants — i.e. the bridge ALREADY has the duplication problem this work is meant to solve on the
web side.

---

## Section 0b — Spot-check of Section 0 by the second AC agent (2026-08-25)

Re-read from source. **O1, O2, O3, O4, O5, O6 confirmed verbatim**, including the exact merge line
`confirmAsk: m.confirmAsk ?? next[i].confirmAsk` (`store.ts`) and the exact catch comment
*"malformed detail -> no confirmAsk chip this reply; never breaks the turn"*.

Two corrections / refinements:

**C1 (path correction, O6).** The file is `src/features/huddle/lib/huddle.functions.ts` (Section 0
omits the `lib/` segment). Line numbers 5393–5419 are correct.

**C2 (refinement, O6 — a SECOND silent-degrade path Section 0 missed).** Degradation to "no widget"
happens on TWO independent conditions, not just the `catch`:
1. `JSON.parse` throws → `catch` → no widget.
2. The parse **succeeds** but the shape guard fails —
   `if (typeof parsed.taskId === "string" && typeof parsed.proposedDod === "string")` — so a
   well-formed JSON object with a missing/non-string `taskId` produces **no widget, no throw, no
   catch, and no log**. `taskTitle` has its own softer degrade (`typeof … === "string" ? … : ""`).
   ACs in section E must cover BOTH, because a registry that only preserves the try/catch preserves
   half the contract.

**C3 (count correction, O7).** `WidgetActionService.kt` has **three** `when (action)` blocks in
`onStartCommand` — mutate (line 34), toast (line 43), refresh-target (line 55) — plus the
`companion object` action-constant list (lines ~88–95) as a fourth parallel site you must edit to
add an action. So "four parallel edit sites keyed on the same action constants" is right; "four
`when` blocks" is not. ACs in section G target all four.

---

## A. Registry / extension path (phase 1)

**The countable metric.** Today, adding one renderable field costs **5 files / 13 edit sites**
(counted from source): `seed.ts` (1: the `HuddleMessage` field), `HuddleView.tsx` (3: the render
conditional, the `applyTurnStream` inline DTO, the field copy into `upsertAgent`), `HuddleApp.tsx`
(2: the inline DTO, the field copy into `add`), `store.ts` (1: the `upsertAgentMessage` merge line),
`lib/huddle.functions.ts` (6: five DTO re-declarations at 527/805/6479/6512/6568/6599 plus the
derive-and-push site at ~5393–5419). **AC-1 fixes the target at ≤2 files / ≤2 sites.**

AC-1. Given the widget registry has shipped, when a developer adds a brand-new widget type end to
end (server emits it, client renders it), then the diff touches **at most 2 files and at most 2 edit
sites**: one NEW self-contained widget-definition file, and one single-line registration in the
registry index. Binary check: `git diff --stat` for the new-widget commit lists ≤2 files, and
`git diff` shows **zero** changed lines in `store.ts`, `HuddleView.tsx`, `HuddleApp.tsx`, `seed.ts`,
and in every one of the six `lib/huddle.functions.ts` sites listed above.

AC-2. Given the registry, when a widget type is registered, then its definition supplies **all** of:
a stable string `type` id, a payload validator/parser, a React renderer, and its authorship+placement
scoping (which of user / agent / system bubbles it may attach to, and whether it renders before,
after, or *instead of* the text row — the three placements O2 documents). Binary check: the registry
entry's TypeScript type makes all four required; omitting any one is a compile error, demonstrated
by a deliberately-incomplete entry failing `tsc`.

AC-3. Given `HuddleMessage`, when the registry has shipped, then adding a widget type requires **no**
new optional field on `HuddleMessage` — widgets live under a single generic container field (e.g.
`widgets?: Widget[]` where `Widget = { type: string; payload: unknown; ... }`). Binary check: `grep`
of `seed.ts` shows the count of message-level renderable-field declarations does not grow when a new
widget type is added.

AC-4. Given the "Extend, don't duplicate" rule, when the registry ships, then it **subsumes** the
existing renderable-field pattern rather than running beside it: `confirmAsk` is migrated onto the
registry (section B) and no message carries the same widget in both the legacy field and the new
container simultaneously. Binary check: a runtime assertion (or a test over the mapping functions)
that for any message, `m.confirmAsk` and a `confirmAsk`-typed entry in `m.widgets` are never both
present-and-live at once.

AC-5. Given "systematic capability, never a patch", when the registry ships, then **no** rendering,
merging, or transport code contains a branch keyed on a specific widget type id. Binary check:
`grep -rn '"confirmAsk"\|confirmAsk' src/features/huddle/components/HuddleView.tsx
src/features/huddle/components/HuddleApp.tsx src/features/huddle/store.ts` returns **zero** hits
outside the widget-definition file and any deliberate backwards-compat shim (which must be a single,
named, commented site — see section C).

AC-6. Given "systematic capability … then PROVE it across the board", when the registry is verified,
then it is exercised with **at least three distinct widget types** covering **all three** placement
modes from O2 — one agent-bubble-after-text (the migrated `confirmAsk`), one user-bubble-before-text
(the `attachments` shape), and one system-message-instead-of-text (the `checkIn` shape) — and each
renders in the correct position for the correct author kind. Binary check: a screenshot or DOM
assertion per placement showing the widget's DOM node is a sibling of the expected bubble in the
expected order, for the expected `author.kind`.

AC-7. Given a registry with N types registered, when the app boots, then the registry is the single
enumerable source: `Object.keys(registry)` (or equivalent) returns exactly the registered type ids,
and **both** the client render dispatch and the server emit path read from that same export. Binary
check: a test that registers a throwaway type and asserts it appears in the enumeration used by the
renderer *and* by the server-side emit validation, with no second list to update.

AC-8. Given the config-centric rule, when a widget type's user-facing behavior has a tunable (which
widget types are enabled, ordering when several are present, max shown), then that tunable is
readable from a config source at runtime and is not a bare literal with no override path. Binary
check: changing the config value (settings row / config module) changes rendering without a code
edit; a literal with no override path fails this AC.

AC-9. Given the registry, when a widget is rendered, then the renderer receives a payload that has
already been narrowed by that type's validator — i.e. the renderer never calls `JSON.parse` and never
re-validates. Binary check: `grep` of every registered renderer shows zero `JSON.parse` and zero
`typeof payload.x === "string"` guards; the validator owns all of it.

---

## B. `confirmAsk` migration parity

Parity baseline read from `ConfirmAskRow` (`HuddleView.tsx:347-430+`): four controls —
**Confirm** (calls `confirmTaskFromButtonFn`, then `resolveConfirmAsk(m.id)`), **Revise** (pure
client, calls `setDraftPrefill` with the task title, does NOT resolve), **Backlog**, **Archive**
(both `run(...)` → resolve on `ok`). `busy` disables all four during an in-flight action. `resolved`
renders a `<Check/> Handled` badge INSTEAD of the row. Partial failure (`res.ok && res.error`) shows
a non-error toast with the error as description; `res.alreadyDone` suppresses the success toast.

AC-10. Given a `confirmAsk` migrated onto the registry, when the message renders, then **all four**
controls are present with the same labels, the same enable/disable coupling (any in-flight action
disables all four), and the same three toast outcomes (`ok` → success, `ok`+`error` → non-error toast
with description, `!ok` → error toast). Binary check: a per-control interaction test asserting the
rendered button set and the exact toast variant for each of the three server responses.

AC-11. Given a resolved widget, when it renders, then it shows the "Handled" badge and **zero**
clickable controls. Binary check: DOM query returns 0 `<button>` elements inside the widget node and
1 element containing the text "Handled".

AC-12. **(attacks O4 — the clobber)** Given a message whose widget has been resolved client-side,
when a subsequent turn poll re-supplies that same message with the SAME widget payload from the
server (which never carries `resolved`), then the widget still renders "Handled" — the buttons do
NOT come back. Binary check: resolve the widget, then invoke the store merge path directly with a
freshly-constructed server-shaped message for the same message id, then assert the rendered widget
has 0 buttons. This must FAIL against a naive `widgets: m.widgets ?? next[i].widgets` merge; that
failure is the proof the AC is doing its job.

AC-13. **(attacks O4 — without the masking guard)** Given AC-12's scenario, when the redundant-write
early-return guard at `HuddleView.tsx:~800` (`prev.text === reply.text && …`) is bypassed — e.g. the
reply text legitimately changed on a later poll, or the guard is temporarily removed in the test —
then the resolved state STILL survives. Binary check: run AC-12 with a reply whose `text` differs
from the stored one, so the guard cannot short-circuit; assert 0 buttons. An implementation that
only passes AC-12 is relying on the guard and has inherited the latent bug, not fixed it.

AC-14. Given the store merge, when an incoming server message carries widget client state fields at
all, then the merge preserves **per-widget, per-field** client state rather than all-or-nothing at
the container level: two widgets on one message where only the first is resolved must end with the
first resolved and the second live after a merge. Binary check: construct that exact message, merge,
assert `widgets[0]` resolved and `widgets[1]` not.

AC-15. Given the client-state key, when a widget's client state is stored, then it is keyed by
**messageId** (plus widget index or a widget-local key) and NOT by the widget's domain id (`taskId`)
— preserving the deliberate scoping documented at `store.ts:277`. Binary check: two messages in the
same huddle carrying widgets with the SAME `taskId`; resolving the first leaves the second live.

AC-16. **(attacks O5 — path 1)** Given the `HuddleView.applyTurnStream` mapping site, when a turn
reply carries a widget, then the widget reaches the rendered message with its payload intact. Binary
check: drive a real turn (or the harness) that triggers `propose_task_intent` while the huddle is
open, and observe the widget rendered in the live thread.

AC-17. **(attacks O5 — path 2, the un-deduped back-fill)** Given the `HuddleApp` durable back-fill
poll (`HuddleApp.tsx:66-115`, `addAgentMessage`, "does not dedupe"), when a reply carrying a widget
is recovered while the user was away or on another huddle, then the widget renders identically to
AC-16 **and** exactly once. Binary check: with the huddle NOT on screen, let the turn complete, then
open the huddle; assert exactly one message with that id and exactly one widget node. Then let the
back-fill poll fire a second time over the same cursor window and re-assert the counts are unchanged.

AC-18. **(attacks O5 — the divergence itself)** Given both mapping sites, when the registry has
shipped, then the reply→message widget mapping exists in exactly **one** function that both call —
the DTO type is declared once and imported, not re-declared inline in each site. Binary check:
`grep -c` for the reply-DTO widget field across `HuddleView.tsx` + `HuddleApp.tsx` returns 0 (both
import a shared type), and both call sites reference the same mapping helper by name.

AC-19. **(attacks O5 — the asymmetric agent-id validation)** Given a reply whose `agentId` is not in
`AGENT_BY_ID`, when it arrives via **either** mapping site, then it is rejected the same way in both
— currently only the back-fill validates it. Binary check: feed an unknown `agentId` through each
path; both drop the reply (or both render an explicit fallback), and the behavior is identical.

AC-20. Given the migration, when it is complete, then a widget-carrying message survives a full
reload: the widget re-renders from the durable turn, and any client-only state that was intentionally
ephemeral (`resolved`) behaves per its documented contract after the reload. Binary check: resolve a
widget, hard-reload, and record the observed state; whatever it is, it must MATCH the pre-migration
`confirmAsk` behavior exactly — this AC forbids a silent behavior change, in either direction.

---

## C. Backwards compatibility

AC-21. Given a message persisted **before** the registry shipped (no `widgets` container, no widget
fields at all), when it renders, then it renders exactly as it did before — text only, no widget
slot, no empty container, no console warning. Binary check: render a fixture message with only
`{id, huddleId, author, text, ts}` and diff the DOM against the pre-change render.

AC-22. Given a message persisted with the **old flat field shape** (`confirmAsk: {taskId, taskTitle,
proposedDod, resolved?}` and no `widgets`), when it renders after the registry ships, then the widget
still renders and all four controls still work. Binary check: load a stored workspace blob captured
before the change (or a hand-built fixture in the old shape) and interact with Confirm; assert the
server call fires with the right `taskId` and the row resolves.

AC-23. Given a durable turn row written by the **old server build** still sitting in
`chat.pending_turns` (its `replies[]` carry `confirmAsk`, not the widget envelope), when a new client
back-fills it, then the widget renders. Binary check: hand-construct that reply DTO shape, run it
through the back-fill mapping, assert one widget node.

AC-24. Given a **new** server build and an **old** client (a stale tab that has not reloaded across
the deploy), when a turn carrying the widget envelope arrives, then the old client does not crash and
does not render a broken/empty artifact — it degrades to text-only. Binary check: run the current
(pre-change) client bundle against a response containing the new envelope; assert zero uncaught
exceptions and the reply text renders.

AC-25. Given the compatibility shim, when it exists, then it is a **single named, commented site**
(one adapter function), not a per-consumer sprinkle, and it is the only place in the codebase that
mentions a legacy field name. Binary check: `grep -rn "confirmAsk" src/` outside the widget
definition and the adapter returns 0 hits.

AC-26. Given the shim, when a message carries BOTH the legacy flat field and a registry widget of the
same type (a mixed-build race), then exactly one widget renders — not two. Binary check: construct
that message, assert exactly 1 widget node of that type in the DOM.
