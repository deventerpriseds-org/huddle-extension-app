# Acceptance Criteria — General Widget Extension Path (Phase 1: chat thread + Phase 2: bridge/Android)

Written by an INDEPENDENT AC agent (cold read of the code, no access to the implementer's plan).
Derived from: `seed.ts` (HuddleMessage), `HuddleView.tsx`, `HuddleApp.tsx`, `store.ts`,
`huddle.functions.ts`, and the bridge repo `android-bridge-template`.

Status: **COMPLETE — AC-1..AC-64, both phases, written up front as one batch for a single
verification pass at the end (per the owner's "no micro-loops" direction).** Section 0 was written by
the first AC agent; Section 0b onward by a second, independent AC agent after that agent was killed
mid-run. Section 0's observations were spot-checked against source, not re-derived — see Section 0b.

Sections: 0/0b ground truth · A registry (phase 1) · B `confirmAsk` migration parity ·
C backwards compatibility · D edge cases · E error states · F regression guard · G phase 2 bridge ·
H extension-point guard · Highest-risk areas · Open questions for the owner.

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

---

## D. Edge cases

AC-27. **(unknown / unregistered type)** Given a message carrying a widget whose `type` is not in the
client registry, when it renders, then the message's TEXT still renders in full, the unknown widget
is silently skipped (no placeholder, no error boundary trip), and exactly one structured warning is
logged naming the unrecognized type. Binary check: render a message with
`widgets:[{type:"not-a-real-type", payload:{}}]`; assert the text node is present, 0 widget nodes,
0 uncaught exceptions, and exactly 1 console warning containing the string `not-a-real-type`.

AC-28. **(malformed payload)** Given a widget whose `type` IS registered but whose payload fails that
type's validator, when it renders, then the widget is skipped and the message text still renders —
i.e. the O6 degradation contract ("bad payload → no widget, never an error, never breaks the turn")
is preserved at the CLIENT boundary too, not only the server one. Binary check: register a validator,
feed a payload that fails it, assert 0 widget nodes and the text intact.

AC-29. **(missing payload)** Given a widget entry with `type` present and `payload` `undefined`/
`null`, when it renders, then it behaves identically to AC-28 (skipped, text intact). Binary check:
both `{type:"x"}` and `{type:"x",payload:null}` produce 0 widget nodes and 0 exceptions.

AC-30. **(two widgets, one message)** Given a message carrying two widgets of DIFFERENT types, when
it renders, then both render, in the registry-defined deterministic order (not object-key order, not
array-arrival order unless that is the declared rule), and each is independently interactive. Binary
check: assert 2 widget nodes in the declared order; act on the second and assert the first is
untouched.

AC-31. **(two widgets, SAME type, one message)** Given a message carrying two widgets of the same
type, when it renders, then both render and their client state is independent (resolving one does not
resolve the other). Binary check: resolve widget index 0, assert index 1 still shows its controls.
This is the AC-15 keying requirement observed at the render layer.

AC-32. **(widget on a user-authored message)** Given a widget attached to a message with
`author.kind === "user"`, when it renders, then it renders **only** if its registry entry declares
user authorship as permitted (per AC-2); otherwise it is skipped like an unregistered type. Binary
check: attach an agent-only widget to a user message → 0 widget nodes + 1 warning; attach the
attachments-shaped widget → 1 node, positioned before the user bubble, right-aligned (O2).

AC-33. **(widget on a system message)** Given a widget attached to `author.kind === "system"` whose
registry entry declares the *instead-of-text* placement (the `checkIn` case, `HuddleView.tsx:481-482`
early return), when it renders, then the card renders and the plain text row does NOT. Binary check:
assert the card node present and 0 nodes matching the standard system-text-row selector.

AC-34. **(empty container)** Given `widgets: []`, when it renders, then it is indistinguishable from
`widgets: undefined` — no wrapper element, no extra margin. Binary check: DOM diff between the two
fixtures is empty.

AC-35. **(payload with unexpected extra fields)** Given a widget payload carrying fields the
validator does not know about, when it renders, then it renders normally (forward-compatible: unknown
fields are ignored, not rejected). Binary check: add `{...validPayload, futureField:123}` → 1 widget
node, identical DOM to the valid payload. This is what lets a newer server ship a richer payload to
an older client without breaking it.

AC-36. **(very large / hostile payload)** Given a widget payload containing an unusually long string
or a deeply nested object, when it renders, then the thread layout does not break (no horizontal page
scroll) and no unescaped markup is injected. Binary check: a payload with a 10k-char string and a
`<img src=x onerror=…>` string renders as inert text, with the widget's own container scrolling if
needed, and `document.body.scrollWidth <= window.innerWidth`.

---

## E. Error states

AC-37. **(server emits a type the client lacks — forward compat)** Given the server emits a widget
type that a deployed older client does not have registered, when that client renders the reply, then
the reply text renders in full and the app remains interactive. Binary check: identical to AC-27 but
driven end-to-end through a real turn, asserting no error boundary is tripped anywhere up the tree.

AC-38. **(the O6 parse throws)** Given a tool-use `detail` that is not valid JSON, when the server
builds the reply, then the reply is emitted with NO widget, with its text intact, and the turn
completes with the same status it would have had otherwise. Binary check: force a non-JSON `detail`,
assert the turn's status is unchanged and `replies[i]` has no widget entry and non-empty `text`.

AC-39. **(the O6 shape guard fails — the silent second path, see C2)** Given a `detail` that parses
to valid JSON but whose required field is missing or non-string (e.g. `{"taskTitle":"x"}` with no
`taskId`), when the server builds the reply, then it degrades to no-widget exactly like AC-38 — AND
it emits a distinguishable server-side log line, because this path currently produces no signal at
all. Binary check: feed that exact payload; assert no widget on the reply AND one log entry naming
the widget type and the failed field. (The log is a NEW requirement, deliberately: a silent
type-guard failure is indistinguishable from "the agent never called the tool," which makes this
class of bug undiagnosable.)

AC-40. **(no error may escape to the turn)** Given ANY widget-derivation failure on the server —
throw, guard failure, unregistered type, validator crash — when the turn runs, then the turn never
fails and no other agent's reply in the same turn is affected. Binary check: in a multi-agent turn,
force a widget failure on agent 1's reply; assert agents 2..N still produce their replies and the
turn status is `done`.

AC-41. **(renderer crash containment)** Given a registered widget whose renderer throws at render
time, when the thread renders, then only that widget is lost — the message text, the other widgets on
that message, and every other message still render. Binary check: register a throwing renderer, load
a thread of 5 messages, assert 5 message nodes still present and 0 blank screens.

AC-42. **(server action failure surfaces, not swallows)** Given a widget control whose server call
returns `{ok:false, error}`, when the user clicks it, then an error toast shows the server's message,
the widget does NOT resolve, and the controls become re-enabled. Binary check: stub `{ok:false,
error:"boom"}`; assert toast text contains "boom", widget still shows its controls, and buttons are
enabled again.

AC-43. **(partial-failure semantics preserved)** Given `{ok:true, error:"mirror write failed"}`, when
the user clicks, then the widget resolves AND a non-error toast carries the error as its description
— matching current `ConfirmAskRow` behavior exactly. Binary check: assert resolved state AND the
toast variant is not the error variant.

---

## F. Regression guard

AC-44. Given the four non-migrated renderable fields (`checkIn`, `artifacts`, `attachments`,
`toolUses`), when the registry ships, then each still renders in its exact pre-change position with
its exact pre-change markup. Binary check: a rendered-DOM snapshot per field, captured on the
pre-change build and diffed against the post-change build — zero diff.

AC-45. **(placement regression, the O2 trap)** Given `attachments` on a user message and `checkIn` on
a system message, when the registry ships, then `attachments` still renders ABOVE the user bubble
right-aligned and `checkIn` still renders INSTEAD of the system text row. Binary check: explicit
positional assertions (sibling order + alignment class + absence of the system text row), not just
"the node exists" — a registry that defaults everything to "under the agent bubble" passes a
node-exists check and fails this one.

AC-46. Given `artifacts` chips, when clicked after the change, then `openArtifactById` is still
invoked with the same id and the Artifacts view still opens. Binary check: click assertion on the
spy + the resulting view state.

AC-47. Given `toolUses` breadcrumbs, when a turn completes, then the breadcrumb attach-on-final-poll
behavior (`turnToolUses` populated only when `result.toolUses` exists, and the redundant-write guard
letting the final poll through) is unchanged. Binary check: run a turn with tools; assert breadcrumbs
appear on the final poll exactly as before, and that the guard at `HuddleView.tsx:~800` still permits
the breadcrumb-landing write.

AC-48. Given the store, when the registry ships, then `upsertAgentMessage`'s existing preservation
semantics for `artifacts` and `toolUses` (`m.x ?? next[i].x`) are unchanged. Binary check: existing
merge tests pass untouched.

AC-49. Given the turn pipeline, when the registry ships, then a turn carrying NO widgets produces a
response payload byte-identical (modulo timestamps/ids) to the pre-change build. Binary check: capture
a no-widget turn response before and after; diff after normalizing volatile fields — zero diff.

AC-50. Given the type system, when the registry ships, then `npm run build` / `tsc` completes with
zero new errors and zero new `any`/`@ts-expect-error` in the touched files. Binary check: build output
+ `grep -c "@ts-expect-error\|: any" ` on the diff is 0.

---

## G. Phase 2 — external via the bridge

**Additional ground truth read for this section (2026-08-25).** `SupabaseTaskClient.kt` talks
**directly to Supabase REST** (`$supabaseUrl/rest/v1/...`) using the USER's own
`supabase_access_token` / `supabase_anon_key` / `supabase_user_id` out of `EncryptedPrefs` — i.e. the
bridge is an authenticated first-party Supabase client against **journey's** DB. Huddle's chat widgets
are fed by Huddle's turn payload out of **Azure PG**. These two feeds share no transport, no auth, and
no schema. Additionally, each Android widget is its own `<receiver>` in `AndroidManifest.xml` (four
registered), so an Android widget type costs a receiver + a provider-info XML + a layout on top of
the four `WidgetActionService` sites in C3.

AC-51. **(the O7 fork must be ANSWERED, not inherited)** Given the widget contract, when phase 2 is
designed, then the document/code states EXPLICITLY which of three models the bridge uses, with the
reason recorded: (a) Android reads Huddle's Azure PG via a new Huddle-side read endpoint; (b) Huddle
writes widget state into journey's Supabase so Android keeps its existing `SupabaseTaskClient` feed;
(c) the widget contract is transport-agnostic and each surface binds its own feed. Binary check: a
named decision exists in the repo (CLAUDE.md or a plan doc) naming one of a/b/c and the rejected
alternatives. **An implementation that ships without this stated is a FAIL of this AC even if it
works** — this is exactly the "decided by accident" failure the AC exists to prevent.

AC-52. Given the chosen model from AC-51, when an Android widget renders a widget type that also
exists in the chat thread, then both surfaces read the SAME widget `type` id and the SAME payload
field names. Binary check: a shared contract artifact (JSON schema, or a generated Kotlin data class
from the same source as the TS type) exists, and the Kotlin type's field names match the TS type's
field-for-field — verified by a test that fails when they drift.

AC-53. **(the standing "reuse journey's push" rule)** Given a widget needs to reach the phone, when
phase 2 ships, then it rides the EXISTING `send_push` → journey → FCM/Android-bridge path and adds
**no new sender**. Binary check: `grep` of the phase-2 diff shows zero new push/notification
transports; the widget delivery call site is `invokeJourneyTool({toolName:"send_push", ...})` or the
existing widget-refresh broadcast.

AC-54. **(kills the C3 duplication — the real target)** Given a NEW widget action is added to the
bridge, when the diff is reviewed, then it is declared **once** in a single action-descriptor
structure (constant + mutation + toast + refresh-target together), not spread across the three
`when (action)` blocks plus the companion-object constant list. Binary check: `git diff --stat` for a
new-action commit shows exactly one changed region in `WidgetActionService.kt`; and
`grep -c "when (action)" WidgetActionService.kt` after refactor is **≤1**.

AC-55. Given the refactor in AC-54, when the existing seven actions (`TASK_DONE`, `TASK_PAUSE`,
`TASK_START`, `TASK_TODAY`, `TASK_PRIORITY`, `TOPIC_UP`, `TOPIC_DOWN`) are exercised, then each still
performs the same mutation, shows the same toast (including the four that show one and the three that
show none), and refreshes the same widget class (`ScheduleWidget` vs `PrioritiesWidget`) as before.
Binary check: a parameterized Kotlin unit test, one case per action, asserting the mutation call,
the toast string (or null), and the refresh target — run against the pre-refactor behavior as the
expected values.

AC-56. Given a widget action fires while the device is offline or the Supabase token has expired,
when the user taps it, then the widget does not silently no-op: it surfaces a visible outcome (toast
or widget state) and does not leave the widget showing a stale/incorrect state. Binary check: with
network disabled, tap the action and assert a user-visible failure indication.

AC-57. Given an unknown/unregistered widget action arrives at `WidgetActionService`, when it is
handled, then the service stops cleanly (`stopSelf`) with no crash and no toast. Binary check: send
an intent with a bogus action string; assert no `ANR`/crash in logcat and the service stops.

AC-58. Given the "Extend, don't duplicate" rule, when phase 2 ships, then it EXTENDS the phase-1
registry (same type ids, same payload contract) rather than defining a second, Android-only widget
taxonomy. Binary check: no Kotlin-side widget-type enum exists that is not generated from, or
one-to-one with, the phase-1 registry — reviewed against the AC-52 contract artifact.

AC-59. Given a widget type that is registered in phase 1 but has no Android renderer, when the bridge
encounters it, then the Android side skips it gracefully (the widget list renders its other entries)
— the same degradation contract as AC-27, on the other surface. Binary check: feed the bridge a
payload containing an unknown type alongside a known one; assert the known one renders.

---

## H. Extension-point guard (agent-authored payloads later)

Agent-authored / dynamic widget payloads are explicitly OUT of scope. These ACs only ensure the
contract does not PRECLUDE them.

AC-60. Given the widget envelope, when it is defined, then `type` is a plain **string** (not a
closed TypeScript string-literal union baked into the wire type) and `payload` is `unknown` at the
transport boundary, narrowed only by the registry's validator. Binary check: a widget with
`type:"agent-authored-thing"` can be constructed and transported end to end without a TypeScript
error and without a schema rejection at any transport hop — it is dropped only at the client render
step by AC-27's unknown-type path. A closed union at the wire type fails this AC.

AC-61. Given the registry, when a widget type is registered, then registration happens through a
**function call at runtime** (`register(def)`) rather than by editing a hardcoded object literal that
the bundler must see at build time. Binary check: a type registered from a test file — not from the
registry index — is rendered by the same dispatch, proving registration is not build-time-only.

AC-62. Given the server emit path, when a widget is emitted, then the emit code does not enumerate a
closed list of permitted types — it validates against the registry, which is data. Binary check:
`grep` of the server emit path shows no hardcoded array/switch of type ids.

AC-63. Given the validator contract, when a future agent-authored payload is introduced, then the
existing contract can express "validate this against a schema supplied with the widget" without
changing the envelope shape. Binary check: write (do not ship) a throwaway registry entry whose
validator is schema-driven rather than hand-coded, register it at runtime per AC-61, and render it —
zero changes required to the envelope type, the transport, the store merge, or the render dispatch.

AC-64. Given the config-centric rule and the future dynamic case, when widget types are gated, then
the gate is a config-readable allowlist/denylist of type ids rather than a code branch — so an
agent-authored type could later be enabled or disabled without a deploy. Binary check: flipping the
config value changes whether that type renders, with no code edit.

---

## Highest-risk areas

**R1 — the store merge clobbering widget client state (O4, AC-12/AC-13/AC-14/AC-15). Highest risk.**
The current code is already latently broken here and is masked only by an unrelated early-return
guard (`prev.text === reply.text && …`). The obvious, natural registry implementation —
`widgets: m.widgets ?? next[i].widgets` — reproduces the exact bug at container granularity, which is
STRICTLY WORSE than today: one incoming widget would wipe the client state of every widget on the
message, not just one field of one widget. AC-13 is deliberately constructed to bypass the masking
guard, because an implementation that passes AC-12 alone has proven nothing. Expect this to be the
AC that actually fails first.

**R2 — the two divergent mapping sites (O5, AC-16/AC-17/AC-18/AC-19).** They differ in three ways at
once: `upsertAgent` vs `addAgentMessage` ("does not dedupe"), the presence/absence of the redundant-
write guard, and the presence/absence of `AGENT_BY_ID` validation. A registry that unifies rendering
but leaves both mapping sites hand-copying fields keeps the highest-cost part of the problem (the
"edit both files" tax that motivated the whole feature) and leaves the un-deduped back-fill path
under-tested — historically the path that produces duplicated or orphaned messages. AC-17 is the one
most likely to be skipped, because reproducing the back-fill path requires deliberately NOT having
the huddle on screen.

**R3 — the O2 placement collapse (AC-6/AC-32/AC-33/AC-45).** The three existing render sites are in
three different author branches with three different semantics, one of which (`checkIn`) **returns
early and replaces the text row entirely**. Any registry whose mental model is "widgets render under
the agent bubble" will pass every node-exists test while silently moving `attachments` and breaking
`checkIn`. This is a quiet, visual regression that unit tests do not catch — hence the positional
assertions in AC-45 rather than presence assertions. Second-order risk: the migration is proven on
`confirmAsk` only (the one type that happens to fit the default placement), so the defect ships
undetected until someone opens a stand-up thread.

---

## Open questions for the owner

**Q1 (blocks AC-51 — the phase-2 fork).** Which data feed backs external widgets? The two surfaces
today share nothing: Android is an authenticated Supabase REST client against **journey's** DB using
the user's own token in `EncryptedPrefs`; chat widgets come off Huddle's turn payload from **Azure
PG**. Options are (a) new Huddle read endpoint for Android, (b) Huddle writes widget state into
journey's Supabase so the existing `SupabaseTaskClient` keeps working, (c) transport-agnostic contract
with per-surface binding. (b) reuses the most existing machinery and matches the standing
"piggyback journey" rule, but makes Huddle a second writer into journey — which the task-sync section
of CLAUDE.md explicitly warns against ("one-way fan-out, do not add a second writer"). A human must
decide; the source does not settle it.

**Q2 (affects AC-20).** Should widget client state (`resolved`) become **durable** as part of this
work, or stay client-only? Today it is client-only and its behavior across a reload is not documented
anywhere I could find — so AC-20 is written as "must not change," which is the safe framing but
leaves an existing ambiguity in place. If it is currently lost on reload, that is arguably a bug the
user may want fixed in the same pass. Phase 2 forces this question anyway: an Android widget cannot
read a state that lives only in a browser tab's zustand store.

**Q3 (affects AC-1's number).** Is **2 files / 2 sites** the right target, or should the registry go
further and make a widget a single self-contained file with zero registry-index edit (filesystem or
glob-based auto-registration)? Auto-registration would make it **1 file / 1 site**, but conflicts with
AC-61's runtime-registration requirement being explicit and with tree-shaking. I picked 2 as the
provable, conventional target; the owner may want 1.

**Q4 (affects AC-39).** AC-39 requires a NEW server-side log line on the silent type-guard failure
path (C2) that does not exist today. That is a small behavior addition, not pure parity. Confirm it is
wanted — the argument for it is that a silent guard failure is currently indistinguishable from "the
agent never called the tool," which makes the whole class undiagnosable; the argument against is that
it is scope creep on a migration meant to be behavior-preserving.

**Q5 (affects AC-30).** When two widgets appear on one message, what determines render order —
array order as emitted by the server, or a declared per-type priority in the registry? No precedent
exists in the code: today the order is fixed by hardcoded JSX sequence (`artifacts` → `toolUses` →
`confirmAsk`, `HuddleView.tsx:534/550/571`), which is a per-type priority, not array order. That
implies registry-declared priority is the faithful migration — but it needs confirming, and it means
the registry entry needs a fifth required field beyond AC-2's four.
