# Independent verification — notification fixes (Bug 1 + Bug 2)

**Verifier:** independent agent, no shared context with the implementing session.
**Date:** 2026-08-25
**Under test:** branch `claude/iris-huddle-interaction-baj51c`, commits `1f7a035` (Bug 1), `ca4d459` (Bug 2).
**Base confirmed:** `git log --oneline -6` → `ca4d459` → `1f7a035` → `043b932` (the AC doc's stated base).
Working tree clean at start.
**Sandbox limits:** cannot reach Azure PG (`eds-postgresql`/`RAG_AI_Agents`) or the deployed SWA. Anything
requiring the live DB, a real device push, or a real browser is marked **NOT LIVE-VERIFIED**.

---

## 0. Commands run (evidence base)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0, zero output** — both commits typecheck clean |
| `bun scripts/blocked-line.test.mjs` | **13/13 passed** |
| `node scripts/blocked-line.test.mjs` | **FAILS** — `ERR_MODULE_NOT_FOUND` resolving `./grooming.server`. Must run under `bun` (as the AC doc's F3 predicted). Not wired into `package.json` (`test:router` is the only test script). |
| `bun` on adversarial harness replicating `standup.server.ts:31` `agentName` | Slug leak reproduced (see D1) |
| `bun` importing real `PRESENCE_FRESH_MS` + replicating `isUserPresent` arithmetic | 30000 ms; suppression up to 29 999 ms (see D2) |
| `bun` importing real `renderBlockedLine` for worst-case length | 227 chars/line, 1823 for 8, ≈2653 with prose, under the 4000 cap |
| grep sweeps: `foreground`, `getAllTurnUpdates`, `AGENT_BY_ID`, hardcoded names, new SQL | see per-AC rows |

---

## 1. Defects found (most severe first)

### D1 — Bug 1, standup surface: an unknown/stale `assigned_agent` id renders the RAW SLUG as a human name (AC-1.4 FAIL)

`src/features/huddle/lib/tasks/standup.server.ts:31`:

```ts
function agentName(id: string | null): string {
  return (id && AGENT_BY_ID[id as AgentId]?.name) || id || "the team";
}
```

The `|| id` fallback returns the raw id when the roster lookup misses. `buildBrief`'s new blocked clause
(`standup.server.ts:53-60`) only guards **null**, not **unknown**:

```ts
const who = b.agent ? agentName(b.agent) : "";
... + (who ? ` — ${who} needs you on this` : "")
```

Executed (bun, replicating both functions verbatim against the real `AGENT_BY_ID`):

```
known id  : - "T" — r — Sam Trent needs you on this
null id   : - "T" — r
STALE id  : - "T" — r — sam-trent-old needs you on this      <-- slug as a person
raw slug  : - "T" — r — unknown-person needs you on this     <-- slug as a person
```

AC-1.4 states verbatim: *"it must never print the raw slug inside a sentence that reads as a human name
(`"sam-trent needs you on this"` is a FAIL)"*. This is that exact string shape.

The code comment added in the same hunk asserts the opposite of the observed behaviour:
`"`agentName` degrades to an ownerless line for a null/unknown id."` — true for null, **false for unknown**.

`assigned_agent` is a free-text column fed from the journey mirror (`tasks.journey_tasks`), so a renamed
or externally-set agent id is reachable. The autowork surface (`AGENT_BY_ID[...]?.name`) is correct; only
standup regressed. Fix: `const who = AGENT_BY_ID[b.agent as AgentId]?.name ?? ""` at that one site (do
**not** change `agentName` itself — its `|| id` fallback is depended on by `produced`/`movedToReview`/
`priorities`, where a bare id is a degraded label, not a sentence subject).

### D2 — Bug 2: `PRESENCE_FRESH_MS = 30_000` is LONGER than a turn, so the headline reported scenario is still suppressed (AC-2.1 FAIL for typical turns; AC-2.4 window FAIL)

The user's report — *send while visible, walk away, reply completes* — has stamp-age-at-delivery **equal to
the turn duration**, because after the tab is hidden nothing re-stamps (verified: `markInteraction` is bound
only to `pointerdown/keydown/wheel/touchstart` + `visibilitychange→visible`; the poll sends the *frozen*
client value and `GREATEST` makes a repeat a no-op).

`PRESENCE_FRESH_MS` imported from source = **30 000 ms**. Executed decision table (replicating
`isUserPresent` lines 601-613 + `wantsPush` line 6326 with `foreground=true`, `notify` unset):

```
stamp age at delivery -> present? -> push fires?
     19000ms  present=true   PUSH=false
     20000ms  present=true   PUSH=false
     24000ms  present=true   PUSH=false
     29999ms  present=true   PUSH=false
     30000ms  present=false  PUSH=true
     46000ms  present=false  PUSH=true
```

Measured turn durations, from the implementer's **own commit message** and `CLAUDE.md`: *"a turn here runs
19-24s"* / *"successful 3-agent turns ~19–24s, but ~2/4 still 500 at ~46s from tail latency."*

**19–24 s all fall inside the 30 s window ⇒ push suppressed ⇒ the reported bug is NOT fixed for a
normal-speed turn.** It is fixed only for the slow tail (>30 s).

The constant contradicts its own justifying comment in `turns.server.ts:558-560`:
> *"Turns here routinely run 19-24s, so this is deliberately shorter than a turn: hit send, look away, and
> by the time the reply lands you are correctly treated as away."*

30 000 is not shorter than 19 000–24 000; it is 25–58 % longer. AC-2.4 specified *"a window of ~15s"*, which
would have sat below the turn duration and produced the intended behaviour. The value appears to have been
raised to 30 s to accommodate the 30 s idle poll cadence, which is the wrong constraint to solve against —
the client already polls at 10 s while active, so an actively-present user stays inside a 15 s window
comfortably (worst-case stored-stamp age for an active user is ~10–12 s; see §3).

Secondary evidence that 30 s was chosen for cadence, not for the bug: `HuddleApp.tsx` comment — *"the
server's freshness window is 30s. On a 30s cadence the stamp could be ~30s old the moment it lands"* — then
introduces `ACTIVE_POLL_MS = 10_000` to solve exactly that. With the 10 s active cadence in place, the 30 s
window is no longer required by the cadence and can drop to ~15 s.

Suggested fix: `PRESENCE_FRESH_MS = 15_000`. Then 19–24 s turns → age > window → push fires (AC-2.1), while
an actively-present user (~10–12 s worst case) still suppresses (AC-2.2).

### D3 — Bug 2: the stored timestamp is the CLIENT's clock, compared against the SERVER's (AC-2.9 FAIL); `GREATEST` makes a bad value sticky

`recordUserPresence` stores `Math.max(0, Math.floor(lastInteractionMs))` — the client's raw `Date.now()` —
and `isUserPresent` compares it to the server's `Date.now()`. AC-2.9 forbids this verbatim: *"the stored
timestamp is the **server's** `now()`/`NOW()` at write time … A client-supplied `ts` that the server trusts
fails this AC."*

The implementer's reason is real (AC-2.10: recording arrival time would read a throttled background tab as
present), but the two ACs are **not** in conflict — the reconciling design was not taken: have the client
send a **delta** (`msSinceLastInteraction`, clock-independent) and let the server store `now() - delta`.
That satisfies AC-2.9 and AC-2.10 simultaneously.

Observed consequences of trusting the client clock:

| Skew | Behaviour | Direction |
|---|---|---|
| Client behind by > 30 s | age always > window → **always push** | fail-open (safe, but AC-2.2 permanently broken for that user) |
| Client ahead (steady) | `age < 0` → guard returns false → **always push** | fail-open (safe, AC-2.2 broken) |
| Client ahead by ΔT, transiently | when server time crosses the stored future stamp there is a **30 s window of spurious suppression** | **NOT fail-open** — the one place the design suppresses without the user being there |

`GREATEST(chat.user_presence.last_interaction_ms, EXCLUDED.last_interaction_ms)` has no upper clamp, so a
future value written once is **pinned** and cannot be corrected downward by later honest writes; it only
clears when real time passes it (via the transient window above). `GREATEST` buys nothing here — the client
value is already monotonic within a session — and is what makes a bad value sticky. A `Math.min(Date.now(),
…)` server-side clamp would remove this whole class in one line.

### D4 — Bug 2: presence is app-wide, one row per user — liveness in huddle A silences huddle B (AC-2.12 FAIL)

`CREATE TABLE chat.user_presence (user_email TEXT PRIMARY KEY, …)` — one row per user, explicitly
*"app-wide (not per-huddle)"* per the commit message. AC-2.12 requires *"Liveness must be keyed by
`(user, huddleId)`, not by user alone"* with the concrete case *"the user is visibly active in
`dm-terry-locke` while a reply completes in `all-members` … its push **fires**."*

Observed: it would not. `foreground` is per-turn (set for the huddle the user sent from), but `stillHere`
is global, so a user who sends in `all-members`, switches to `dm-terry-locke`, and keeps interacting has the
`all-members` reply suppressed. This is a deliberate, documented design choice — but it is a documented
choice to **not** meet AC-2.12, and AC-2.12 was never marked out of scope. Impact is lower than D1/D2 (the
user is at least in the app), so I rank it third.

### D5 — Bug 2 (latent, not currently reachable): the presence read sits inside the try whose catch DISCARDS the reply

`executeClaimedTurn`'s whole body is one `try { … } catch (err) { await failTurn(...); return null; }`
(`huddle.functions.ts:6272` … `6388-6391`). The new code at 6321-6325 is inside it, **after**
`runHuddleTurn` has already produced `result` and **before** `return result`:

```ts
let stillHere = false;
if (foreground && record.user_email) {
  const { isUserPresent } = await import("./tasks/turns.server");
  stillHere = await isUserPresent(record.user_email);
}
```

If either statement threw, the turn would be marked **failed** and `return null` — no push *and* a failed
turn, strictly worse than the original bug. Two facts make this unreachable today, and I verified both:

1. `isUserPresent` is **total** — `ensureBootstrapped()`, `getPool()`, the query, and the row read are all
   inside its own `try`, whose `catch { return false; }` covers every path. It cannot throw.
2. The dynamic `import("./tasks/turns.server")` uses the **same specifier already awaited at the top of the
   same function** (`const { failTurn } = await import("./tasks/turns.server");`, line 6273). By the time
   line 6323 runs, the module is resolved in the ESM cache, so this import cannot fail without the earlier
   one having already failed — which would abort before `runHuddleTurn`.

So: **no active defect**, but the containment depends entirely on `isUserPresent` staying total. Cheap
hardening: wrap the block in its own `try { … } catch { stillHere = false; }` so the invariant is local and
survives a future edit to `isUserPresent`.

### D6 — Bug 2 (minor): the `age < 0` guard punishes a *present* user, and there is no offline test

`if (age < 0) return false;` is correct as a fail-open choice, but combined with D3 it means any client
whose clock runs even slightly fast gets **every** reply push, permanently. No test exists for any Bug 2
behaviour — `scripts/blocked-line.test.mjs` covers Bug 1 only. AC-2's own verification plan called for
*"an extracted pure predicate — e.g. `shouldPush({notifyLevel, turnId, lastSeenMs, nowMs, windowMs})` —
table-tested"*. That predicate was **not** extracted; the decision is inline at `huddle.functions.ts:6326`
and the freshness arithmetic is inline in `isUserPresent` with `Date.now()` non-injectable. I had to
re-implement both to test them. Per the AC doc, *"If it is not extractable, the fix is untestable at this
granularity and that itself is a finding to report."* — reporting it.

### D7 — Bug 1 (minor): the standup brief grew and can now truncate `Today's top priorities` sooner

Each blocked line gained up to ~41 chars (`— <Name> needs you on this`), ×6 items ≈ +250 chars, against
`MAX_BRIEF = 2600` applied as a **tail** slice (`standup.server.ts:68`). `priorities` is the last section,
so it is what gets cut. Pre-existing mechanism, marginally more likely to fire. No AC covers it; flagging
only.

**Non-defect, checked and clear:** the autowork directive did **not** overflow. Worst case measured by
importing the real `renderBlockedLine`: 227 chars/line × 8 = 1823, + ~830 prose ≈ **2653**, against the
`text: z.string().min(1).max(4000)` cap at `huddle.functions.ts:148`. The removal of the old per-line
`slice(0, 120)` roughly doubled the list but stayed inside the cap.

---

## 2. Answers to the five falsification targets

**(1) Does fail-open hold end to end?** In `isUserPresent`, **yes, on every branch** — verified line by line:
no row (`res.rows[0]?.…` → `undefined` → `return false`), null (`raw === null` → false), NaN/non-finite
(`!Number.isFinite(last)` → false), zero/negative (`last <= 0` → false), DB/bootstrap throw (outer
`catch { return false }`), negative age / client clock ahead (`age < 0` → false). At the **caller**, no
throw can escape today (D5 — verified via module-cache reasoning and `isUserPresent`'s totality), but the
placement is inside a reply-discarding catch and should be locally guarded. The one place fail-open does
**not** hold is D3's future-timestamp transient.

**(2) Can an idle-but-open tab look present?** **No — this is the design's strongest part, and it holds in
both directions I was asked to check.** Client: `markInteraction` is bound only to
`["pointerdown","keydown","wheel","touchstart"]` plus `visibilitychange→visible`; `tick()` never calls it,
so no timer tick can stamp. Seeded `lastInteractionMs = 0`, and the server guard
`data.lastInteractionMs > 0` means an untouched session never writes a row at all. Server:
`recordUserPresence` stores the client value; `now()` goes only into `updated_at`, which `isUserPresent`
never reads — so the server never substitutes `Date.now()`. An idle tab's stamp is frozen, the poll relaxes
to 30 s, and it ages out on its own. **However**, `GREATEST` *can* be fed a future timestamp and pins it
(D3) — that does not pin presence permanently (the `age < 0` guard converts it to "away") but it does open
a delayed 30 s suppression window.

**(3) Is the 30 s window reachable by the 10 s/30 s cadence?** Worst-case stored-stamp age at delivery:

| Scenario | Stamp age at delivery | Present? | Push? | Matches "buzz unless touched in ~30s"? |
|---|---|---|---|---|
| (a) actively typing/scrolling | ≤ ~10–12 s (last interaction as of the most recent 10 s poll) | true | **no push** | ✅ intended (AC-2.2) |
| (b) **sent, then walked away** | = turn duration, **19–24 s** typical (46 s tail) | **true** for 19–24 s | **no push** | ❌ **this is the reported bug, unfixed** (D2) |
| (c) idle, tab open, unattended | grows past 30 s, poll relaxed to 30 s, stamp frozen | false after 30 s | **push** | ✅ intended (AC-2.11) |

The window is reachable, and scenario (b) is the problem: the window is wider than the event it is meant to
discriminate. (a) and (c) both behave as intended.

**(4) Regressions.** `getAllTurnUpdates` hot path is **safe**: `void recordUserPresence(...)` is
fire-and-forget (not awaited, so it cannot delay or block `getUserTurnsSince`), and `recordUserPresence`
wraps *everything* including `ensureBootstrapped()` in `try/catch`, so the floating promise can never reject
→ no unhandled rejection. Guarded by `typeof … === "number" && … > 0`. The response DTO mapping is
untouched. Agent-initiated turns are **untouched**: `foreground` has exactly one producer
(`HuddleView.tsx:1028` — grep-confirmed, and `git show` confirms it was not modified), so `autowork-blocked-*`,
`standup-*`, `followup-*`, `MeetingBar`, and `useVoiceCallRealtime` all leave it unset → `foreground === true`
is false → `isUserPresent` is **never even called** (short-circuited by `if (foreground && …)`) →
`!(false && …)` → `wantsPush` true, byte-identical to pre-fix. `notify` precedence is preserved:
`notifyLevel !== "batch" && notifyLevel !== "silent" && !(…)` short-circuits before the liveness term.
The per-huddle `getTurnUpdates` and its `AllTurnUpdatesInput` sibling's existing fields were not modified
(only an **optional** `lastInteractionMs` added), and `getAllTurnUpdates` has exactly one call site. The
push-arg block (title/body/channel/app/deepLink/tag) is outside every changed hunk. One push per turn: the
`partial === true` early-return still precedes the whole gate, so liveness is evaluated once at final
completion.

**(5) Bug 1 boundary conditions.** Long title + long reason + long name: **safe on both surfaces** — the
owner clause is appended after `title.slice(90)`/`reason.slice(90)` (autowork) and
`title.slice(100)`/`reason.slice(160)` (standup), and the old composed `slice(0,120)` was removed, so the
name cannot be sliced off (measured: 227-char line, name intact at the tail). Null agent id: safe on both
(`t.assigned_agent ? … : undefined` / `b.agent ? … : ""`). `AGENT_BY_ID[unknownId]` is a plain
`Object.fromEntries` record — property access with `?.` cannot throw, so AC-1.16 holds structurally
(note the `.map()` that resolves the name sits *outside* the `try` that wraps `surfaceBlocked`, but the
expression is non-throwing). **Unknown agent id is where it breaks — on the standup surface only (D1).**

---

## 3. Per-AC verdict — Bug 1

| AC | Verdict | Evidence |
|---|---|---|
| 1.1 owner display name from roster | **PASS** | `bun scripts/blocked-line.test.mjs` ✅ "owner display name present"; `AGENT_BY_ID["sam-trent"].name === "Sam Trent"` confirmed by import |
| 1.2 owner in `payload.text` | **PASS (code)** / NOT LIVE-VERIFIED | `surfaceBlocked` interpolates `list` (from `renderBlockedLine`) directly into `directive`, which is `payload.text`. DB read of `chat.pending_turns` not possible from sandbox |
| 1.3 no "undefined needs you" | **PASS** | test ✅ ×3 (`no 'undefined'`, `no dangling connector`, `title+reason still present`) |
| 1.4 unknown agent id | **FAIL** | autowork PASS (`?.name` → undefined); **standup leaks the slug** — D1, executed output above. The shipped test only passes `ownerName: undefined` directly, so it never exercises the resolver on either surface |
| 1.5 multiple owners, no cross-contamination | **PASS** | test ✅ ×3 |
| 1.6 mixed assigned/unassigned | **PASS** | test ✅ |
| 1.7 rejected phrasing absent | **PASS** | test ✅; grep of the directive shows no `owned by`/`assigned to`/`owner:`; the banned forms are described, not quoted |
| 1.8 conversational output (real reply) | **NOT VERIFIABLE OFFLINE** | requires a live coordinator turn + `chat.pending_turns.replies`. The *directive* is well-constructed for it (no example name, register described not quoted) — but this AC is explicitly judged on the model's reply |
| 1.9 assignee vs flagger stated | **PASS** | `autowork.server.ts:774-783` — 8-line comment naming the choice (`t.assigned_agent`, not `blockers.get().agentId`) and the reason; mirrored at `standup.server.ts:137-140` |
| 1.10 no hardcoded names | **PASS** | `git show 1f7a035 -- src/ \| grep "^+"` for any roster display name → **NONE FOUND**; both surfaces resolve via `AGENT_BY_ID` |
| 1.11 truncation must not eat the name | **PASS** | test ✅ ×2; independently measured 227-char worst-case line with `Sam Trent needs you on this` intact at the tail. This was the AC pass's top-risk item and it is genuinely handled |
| 1.12 no blockers → no turn | **PASS** | `if (blockedItems.length)` guard preserved (`autowork.server.ts:802`); `blocked: blockedItems.length` |
| 1.13 enqueue contract unchanged | **PASS** | read `surfaceBlocked` payload: `notify:"push"`, `internal:true`, `huddleId:"dm-terry-locke"`, `agents["terry-locke"].journey.enabled:false`, `history:[]`, id `autowork-blocked-${runId}` — all present |
| 1.14 cap 8, order, total count | **PASS** | `opts.items.slice(0, 8)`; `.map()` preserves `getBoardTasks` order; `blocked: blockedItems.length` is the **total**, not 8 |
| 1.15 filter untouched | **PASS** | `.filter((t) => !t.completed_at && blockers.has(t.id))` byte-identical in the diff |
| 1.16 broken roster read can't kill the pass | **PASS (structural)** | `AGENT_BY_ID[x]?.name` on a plain record cannot throw; `surfaceBlocked` call remains inside `try { } catch { /* non-fatal */ }` |
| 1.17 second consumer decided | **PASS (decided (a))** | `standup.server.ts` blocked list now carries `agent`; commit message and in-code comment both state it explicitly. **But the execution of (a) has D1** |
| 1.18 no new subsystem | **PASS** | diff is 3 files, +112/−11; grep for `CREATE TABLE`/`SELECT `/`INSERT INTO`/`getPool` in added lines → none |

**Bug 1: 16 PASS / 1 FAIL (1.4) / 1 NOT VERIFIABLE OFFLINE (1.8).**

---

## 4. Per-AC verdict — Bug 2

| AC | Verdict | Evidence |
|---|---|---|
| 2.1 away at delivery ⇒ push | **FAIL for typical turns** | D2. Stamp age at delivery = turn duration (19–24 s measured) < `PRESENCE_FRESH_MS` (30 000) ⇒ `stillHere=true` ⇒ suppressed. Fires only for turns > 30 s |
| 2.2 watching at delivery ⇒ no push | **PASS (mechanism)** | active user's worst-case stamp age ≈ 10–12 s (10 s poll cadence) < 30 s ⇒ suppressed. NOT LIVE-VERIFIED. Degraded to "always push" under any clock skew (D3) |
| 2.3 measured at DELIVERY not send | **PASS** | the decision now also depends on a DB read at completion time; `payload.foreground` alone no longer determines it |
| 2.4 freshness window a real boundary + named constant | **PARTIAL FAIL** | named constant `PRESENCE_FRESH_MS` exported from `turns.server.ts` ✅ and deterministic ✅; **value 30 s vs the AC's specified ~15 s**, and that difference is exactly what breaks 2.1 (D2) |
| 2.5 agent-initiated reach-outs unchanged | **PASS** | `foreground` has one producer (`HuddleView.tsx:1028`, unmodified); agent turns leave it unset ⇒ `isUserPresent` never called ⇒ identical to pre-fix |
| 2.6 voice / ceremony unchanged | **PASS** | `MeetingBar.tsx` / `useVoiceCallRealtime.ts` never set `foreground`; they call `getTurnUpdates`, which was **not** modified by `ca4d459` (hunk headers confirm only `AllTurnUpdatesInput` + `getAllTurnUpdates` changed) |
| 2.7 notify precedence | **PASS** | `notifyLevel !== "batch" && notifyLevel !== "silent" && !(foreground && stillHere)` — the level terms short-circuit first |
| 2.8 FAIL OPEN on every error path | **PASS** (with D3 caveat) | all five sub-cases traced to `return false`; no `catch { return suppressed }` anywhere. Caveat: future-timestamp transient is the one non-fail-open path; D5 placement is a latent (not active) risk |
| 2.9 server clock authoritative | **FAIL** | D3 — the stored value is the client's `Date.now()`, trusted verbatim (`Math.max(0, Math.floor(lastInteractionMs))`), compared to the server's `Date.now()`. Explicitly what the AC forbids |
| 2.10 hidden tab must not read as live | **PASS (code)** / NOT LIVE-VERIFIED | `markInteraction` bound only to real input events + `visibilitychange→visible`; `tick()` never stamps; server stores the client value, never arrival. The AC requires a real browser to close (throttling behaviour), which the sandbox cannot do |
| 2.11 stale open tab can't suppress forever | **PASS** | interaction-based (not visibility-based) liveness chosen and stated in the commit + code comments; stamp is frozen while idle so it ages out at 30 s |
| 2.12 per-huddle scoping | **FAIL** | D4 — `chat.user_presence` is keyed on `user_email` alone, explicitly app-wide |
| 2.13 identity / email-scoped | **PASS** | carrier is `getAllTurnUpdates`, which already resolves `caller` → `resolveTaskEmail` → `email`; the write is `recordUserPresence(email, …)` and only after `if (!email) return`. Carrier choice stated in the commit |
| 2.14 all five `getTurnUpdates` call sites | **PASS** | `getTurnUpdates` was not touched at all; `lastInteractionMs` is `.optional()` on `AllTurnUpdatesInput`; `npx tsc --noEmit` exit 0 |
| 2.15 mixed-version window (old client) | **PASS** | old payload has `foreground:true` and no presence row ⇒ `res.rows[0]` undefined ⇒ `false` ⇒ push fires |
| 2.16 DTO unchanged, catch preserved | **PASS** | the `turns` mapping and the `catch → {turns: [], error}` are outside every changed hunk |
| 2.17 exactly one push per turn (chunked) | **PASS** | `if ((result as {partial?:boolean}).partial === true) { void kickNextChunk(...); return result; }` still precedes the entire gate |
| 2.18 EXTEND not parallel | **PASS** | table added to the **existing** `BOOTSTRAP_SQL` in `turns.server.ts`; no new endpoint; the adaptive cadence modifies the existing `tick()` rather than adding a timer; no new sender; no new secret |
| 2.19 push payload unchanged | **PASS** | title/body/`channel:"messages"`/`app:"huddle"`/`data.deepLink`/`tag` block is entirely outside the diff |
| 2.20 proof on the live evidence | **NOT VERIFIABLE OFFLINE** | requires the live DB + a real device. Per repo rule, the user's own confirmation is the verdict. Note D2 predicts it would still fail for a ≤30 s turn |

**Bug 2: 14 PASS / 3 FAIL (2.1, 2.9, 2.12) / 1 PARTIAL FAIL (2.4) / 2 NOT VERIFIABLE OFFLINE (2.10 partly, 2.20).**

---

## 5. Verdict

- **Bug 1** is substantially correct and well-executed — the hardest AC (1.11 truncation) is genuinely
  solved, the assignee-vs-flagger choice is stated, no hardcoded names, no new subsystem, typecheck clean,
  13/13 offline. **One real defect (D1)** on the second surface it chose to fix, contradicted by its own
  code comment. Small, local fix.
- **Bug 2** has correct architecture, correct fail-open discipline, correct interaction-not-timer liveness,
  and a clean regression surface — but **a single wrong constant (30 s instead of ~15 s) means the exact
  scenario the user reported is still suppressed for a normal-speed turn.** The fix does not currently
  deliver its headline AC. Plus AC-2.9 (client clock) and AC-2.12 (per-huddle) are unmet-by-design and were
  not marked out of scope.

**Required before "done":**
1. D2 — lower `PRESENCE_FRESH_MS` to ~15 000 (or otherwise ensure the window is shorter than a turn), and
   correct the comment that claims 30 s already is.
2. D1 — resolve the standup blocked-line owner via `AGENT_BY_ID[...]?.name`, not `agentName()`.
3. D3 — send a delta, or clamp `Math.min(Date.now(), …)` server-side, and drop `GREATEST`.
4. D4 — either key presence on `(user, huddleId)` or record AC-2.12 as an accepted deviation.
5. D5 — local `try/catch` around the presence block in `executeClaimedTurn`.
6. D6 — extract the push predicate and add an offline table test; wire `blocked-line.test.mjs` into
   `package.json` (it fails under `node`, passes under `bun`).
7. AC-1.8, AC-2.1, AC-2.10, AC-2.20 remain **NOT LIVE-VERIFIED** and need the live DB / a real browser /
   the user's own device confirmation.
