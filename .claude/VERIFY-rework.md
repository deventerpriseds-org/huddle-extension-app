# Independent re-verification — rework commit e960c86

Verifier: independent agent, no shared context with implementer.
Status: **COMPLETE**. Under test: branch `claude/iris-huddle-interaction-baj51c`, commit `e960c86`.
Result: **D1/D3/D4/D5 CLOSED, D2 PARTIALLY CLOSED, 7 new/newly-visible defects (R1-R7).**

## Method
Offline: read code, run `npx tsc --noEmit`, `npm run test:blocked`, `node scripts/presence-timing.test.mjs`,
re-derive presence arithmetic by hand, mutation-test the D1 resolver.
Live Azure DB / deployed SWA NOT reachable from this session -> anything requiring it is marked NOT LIVE-VERIFIED.

## 0. Evidence base (commands actually run)

| Command | Result |
|---|---|
| `git log --oneline -6` | `e960c86` on top of `cdab24a`/`ca4d459`/`1f7a035` — the commit under test is HEAD; tree clean at start |
| `npx tsc --noEmit` | **exit 0, zero output** |
| `npm run test:blocked` (= `bun scripts/blocked-line.test.mjs`) | **21/21 passed**, exit 0 |
| `node scripts/presence-timing.test.mjs` | **10/10 ALL PASS**, exit 0 — but see §D2, the sim's client model is wrong in one important way |
| **Mutation test (D1)** — reverted `standup.server.ts:62` to `b.agent ? agentName(b.agent) : ""`, re-ran | **19/21, exit 1**, failing exactly on `- "Alpha" — needs you — sam-trent-old needs you on this`. Restored; `git status` clean. **Implementer's claim independently re-confirmed.** |

---

## D1 — standup slug-as-a-person — **CLOSED**

`src/features/huddle/lib/tasks/standup.server.ts:62`:
```ts
const who = (b.agent && AGENT_BY_ID[b.agent as AgentId]?.name) || "";
```
`agentName()` (line 29-31, ending `|| id || "the team"`) is still used for `produced`/`movedToReview`/
`priorities` — correctly left alone, since a bare id there is a label, not a sentence subject.
`autowork.server.ts:783-785` uses the same `AGENT_BY_ID[...]?.name` shape.

**Mutation test re-confirmed myself** (not taken on trust): with the defective line restored the suite
drops to 19/21 and exits 1, and the failure text is verbatim the AC-1.4 banned shape. Restored the file
and confirmed `git status` clean.

**Residual gap (minor, not a defect):** the two "autowork" cases in the test use a *replica* of the call
site — `const resolve = (id) => AGENT_BY_ID[id]?.name;` in the test file — not the real
`autowork.server.ts` expression. So a future edit to `autowork.server.ts:783` would NOT be caught by this
suite. Only the standup half is mutation-covered. (I verified by reading `autowork.server.ts:783-786`
that the two expressions agree *today*.)

---

## D5 — presence read could discard a reply — **CLOSED**

`huddle.functions.ts:6323-6334`:
```ts
let stillHere = false;
if (foreground && record.user_email && turnHuddleId) {
  try {
    const { isUserPresent } = await import("./tasks/turns.server");
    stillHere = await isUserPresent(record.user_email, turnHuddleId);
  } catch {
    stillHere = false;
  }
}
```
Own try/catch present, and it defaults to `stillHere = false`. Traced the consequence: `wantsPush =
notifyLevel !== "batch" && notifyLevel !== "silent" && !(foreground && stillHere)` — so the catch path
yields `!(true && false)` = **true = PUSH**. The catch cannot skip the push; it forces it. The outer
`catch → failTurn(); return null` at the end of `executeClaimedTurn` is no longer reachable from this
block. **Fail-open direction confirmed by reading the boolean, not assumed.**

---
## D3 — clock skew — **CLOSED**

Client → server payload is now `watchingHuddleId` only (`HuddleApp.tsx:102-103`):
```ts
const watchingHuddleId = isWatching() ? (activeIdRef.current ?? undefined) : undefined;
const { turns } = await getAllTurnUpdates({ data: { caller, sinceMs: cursor, watchingHuddleId } });
```
`AllTurnUpdatesInput` (`huddle.functions.ts:6570-6579`) carries `caller`, `sinceMs`, `watchingHuddleId` —
no timestamp field. Repo-wide sweep for a surviving client clock on this path:
`grep -rn "lastInteractionMs|last_interaction_ms|GREATEST" src/ scripts/` returns **only** three hits, all
of them client-LOCAL closure state in `HuddleApp.tsx:86,88,98` that is never serialised. `GREATEST` and
`last_interaction_ms` are gone from the source entirely.

**SQL age expression is correct** (`turns.server.ts:624-628`):
```sql
SELECT EXTRACT(EPOCH FROM (now() - seen_at)) * 1000 AS age_ms
  FROM chat.user_presence WHERE user_email = $1 AND watching_huddle = $2
```
`seen_at` is written `now()` on both INSERT and ON CONFLICT UPDATE (`:594-599`), so both sides of the
subtraction are the *server's* clock; `EXTRACT(EPOCH FROM interval)` yields seconds, `*1000` → ms; PG
returns numeric, node-pg hands it back as a string, and the code types it `<{age_ms: string}>` and
`Number(raw)`s it. Correct.

---

## D4 — huddle scoping — **CLOSED**

Column exists (`turns.server.ts:111-117`), is written from the client's watched huddle, and is matched in
the WHERE clause (`:627`). Traced the AC-2.12 scenario: the table is `user_email TEXT PRIMARY KEY`, i.e.
**one row per user holding the LAST watched huddle**, so if the user is watching `dm-terry-locke` while an
`all-members` reply completes, `WHERE watching_huddle = 'all-members'` matches **no row** →
`res.rows[0]?.age_ms` is `undefined` → `return false` → **push fires**. Activity in one huddle can no
longer silence another.

The `turnHuddleId` side is sound: `Input.huddleId` is `z.string()` (**required**, `huddle.functions.ts:149`)
and the client always sends `huddleId: huddle.id` (`HuddleView.tsx:994`), so `turnHuddleId` is never empty
for a user turn. If it ever were, `if (foreground && record.user_email && turnHuddleId)` skips the read →
`stillHere=false` → push. Fail-open.

---
## D2 — headline scenario — **PARTIALLY CLOSED (closed for AC-2.1 as written; a new 5-minute hole opens on desktop)**

### The constants, read from source (not from the sim)
`turns.server.ts:576-577` → `PRESENCE_BEAT_MS = 7_500`, `PRESENCE_FRESH_MS = 15_000`.
`HuddleApp.tsx:26` → `PRESENCE_BEAT_MS = 7_500` (mirrored), `:182` `IDLE_POLL_MS = 30_000`,
`:187` pre-hydrate branch `1_500`, `:85` `ATTENTION_MS = 5 * 60_000`.

### Do NOT trust `scripts/presence-timing.test.mjs` — three independent problems

1. **It hardcodes the constants instead of importing them.** Line 2: `const BEAT=7500, FRESH=15000,
   LAT=300;`. Nothing links it to `turns.server.ts`. Set `PRESENCE_FRESH_MS` back to `30_000` tomorrow and
   this file still prints `ALL PASS`. It cannot detect the exact regression its neighbouring comment says
   it exists to prevent. (The *previous* verifier's ad-hoc harness at least imported the real constant.)
2. **It is not wired into `package.json`.** `scripts` has `test:router` and `test:blocked` only — so it is
   not a gate, just a file someone has to remember to run.
3. **Its model of the client is wrong in the two ways that matter** (below): it has no `IDLE_POLL_MS`
   at all, and it models "the user left" as "beats stop", which is not what the real client does.

### My own re-derivation (`isWatching()` + `tick()` + `isUserPresent()` faithfully re-implemented)

`isWatching()` (`HuddleApp.tsx:94-98`) is the gate on BOTH the payload and the cadence:
```ts
const isWatching = () =>
  typeof document !== "undefined" &&
  document.visibilityState === "visible" &&
  document.hasFocus() &&
  Date.now() - lastInteractionMs < ATTENTION_MS;      // ATTENTION_MS = 5 MINUTES
```

| Scenario (my sim, real cadence + latch + 5-min attention) | stamp age at delivery | push? | verdict |
|---|---|---|---|
| send, **tab hidden** at 1s — 19/24/30/45s turns | 19.7/24.7/30.7/45.7 s | **PUSH** | ✅ closed |
| send, **window loses focus** at 1s (alt-tab away), 24s turn | 24.7 s | **PUSH** | ✅ closed |
| send, **walk away from the desk** (window stays visible+focused), 19s turn | 4.7 s | **no push** | ❌ **still suppressed** |
| …same, 24 / 30 / 45 / 120 s turns | 2.2 / 0.7 / 0.7 / 0.7 s | **no push** | ❌ **still suppressed** |
| …same, turn longer than `ATTENTION_MS` (5min 16s) | 16.7 s | **PUSH** | ✅ (only past 5 min) |
| user stayed & touching, 5/19/24/45 s turns | ≤ 5.7 s | **no push** | ✅ AC-2.2 held |

**What is genuinely fixed:** AC-2.1 *as the AC doc defines "leaves"* — "tab hidden / app backgrounded /
device asleep" — now pushes at 19s, 24s, 30s and 45s. On a phone (switch apps / lock screen →
`visibilitychange` → hidden) the beat stops within one beat and the row is stale ≤15s later, well inside
any turn. That is a real improvement over both `ca4d459` (30s window) and the original `foreground`-only
gate.

**What is NOT fixed, and is the same *direction* of failure as the original bug (a swallowed reply):**
because `isWatching()` tolerates **5 minutes** since the last input event, a user who sends a message and
physically **leaves a focused, visible desktop window** keeps beating for 5 minutes. The presence row never
goes stale, `stillHere` is true, and the reply push is swallowed for every turn shorter than ~5 minutes.
The commit message's claim — *"Stop watching and the row goes stale in seconds, well inside any turn"* — is
true only when "stop watching" means the tab is hidden or the window is unfocused. It is **false** for
"walked away from the machine", which is the plain-English reading of the reported scenario and is exactly
the case where the phone push is the whole point (the user is away from the desktop, holding the phone).

So the effective suppression bound is **`ATTENTION_MS` (300 s), not `PRESENCE_FRESH_MS` (15 s)**.
`PRESENCE_FRESH_MS` only bounds how fast a *hidden/unfocused* client ages out. The rework moved the "wrong
constant" from 30 s to 300 s for the desktop case while fixing it for the hidden/unfocused case.
This is a deliberate, documented trade (`HuddleApp.tsx:83-84`: *"Deliberately generous (5 min) … Reading
and thinking without touching anything is normal, and must not trigger a phone buzz"*) — but it is a trade
made in the direction the ACs say must never be taken (AC-2.8's whole premise: *"A missed notification is
worse than a redundant one"*). It needs to be an explicitly accepted deviation, not a footnote.

**Verdict D2: the specific arithmetic defect the prior verifier found is CLOSED. The headline user
scenario is closed for hidden/backgrounded/asleep and STILL OPEN for desktop walk-away, up to 5 minutes.**

---
## Adversarial focus 1 — is `document.hasFocus()` too strict? Can it throw?

**Existence:** `Document.hasFocus()` is universally supported (IE5+, all evergreen desktop and mobile
browsers, jsdom). Per spec it takes no arguments and returns a boolean; **it does not throw**. The
`typeof document !== "undefined" &&` guard in front of it correctly short-circuits SSR.

**States where the user IS present but `hasFocus()` is false** — and the outcome of each:

| State | `visible` | `hasFocus()` | Outcome |
|---|---|---|---|
| DevTools focused (docked or undocked, Chrome/Edge) | true | **false** | spurious push — acceptable, dev-only |
| Browser find bar / address bar / a browser menu focused | true | **false** | spurious push — acceptable |
| Another app's window on top, Huddle tab still the active tab | true | **false** | spurious push — **intended by design** (`HuddleApp.tsx:79-80` says so explicitly) |
| A focused `<iframe>` inside the page | true | **true** | no effect — per spec the parent document is in the focus chain when its iframe is focused, so this is *not* a false negative |
| Native modal (`alert`/`print`) open, then dismissed | true | false → true | transient spurious push at worst |
| Mobile Safari / iOS standalone PWA quirks | varies | may be **false** while visible | spurious push — acceptable |

**Every one of these fails in the spurious-push direction. I found no state where `hasFocus()` returns
true while the user is absent in a way that could swallow a reply** — except via `ATTENTION_MS` (see D2),
which is not a `hasFocus()` problem.

**One genuinely NEW fragility the rework introduced:** `isWatching()` is now called inside `tick()`
itself — `timer = setTimeout(tick, hydrated ? (isWatching() ? PRESENCE_BEAT_MS : IDLE_POLL_MS) : 1_500)`
(`HuddleApp.tsx:187`) — and that call is **not** inside the `safePoll()` try/catch. Before the rework the
cadence expression was pure arithmetic (`Date.now() - lastInteractionMs < IDLE_POLL_MS`) and could not
throw. If `isWatching()` ever threw (a host without `document.hasFocus`, an exotic embedding, a jsdom-like
runtime), `setTimeout` would never be reached and the **entire cross-huddle back-fill poll would die
permanently for that session** — losing away-message back-fill, not just presence. Probability is low;
the blast radius is not. Cheap fix: compute `const watching = (() => { try { return isWatching(); } catch
{ return false; } })();` once per tick and use it for both the payload and the cadence.

---

## Adversarial focus 2 — does the beat actually keep beating? **NEW DEFECT (N1): the cadence latches**

`tick()` picks the next delay from `isWatching()` **evaluated at schedule time**, and nothing else ever
reschedules the timer:
- `markInteraction()` (`:87-89`) only assigns `lastInteractionMs`.
- `onVisible()` (`:189-195`) calls `markInteraction()` + `safePoll()` — **it does not touch `timer`**.

So any not-watching → watching transition that is **not** a `visibilitychange` leaves the client parked on
`IDLE_POLL_MS = 30_000` for up to 30 s while the user is genuinely watching. The most ordinary path there
is a desktop **alt-tab back in**: `visibilityState` never changed (the tab was always "visible"), only
`hasFocus()` flipped, so no event fires and the timer keeps its 30 s delay.

Measured in my sim (real latch semantics):
```
FAIL  alt-tab IN at t=0, send t=1s, 24s turn — user IS watching   age=never  present=false PUSH=true
PASS  alt-tab IN at t=0, send t=1s, 45s turn — user IS watching   age=  700ms present=true  PUSH=false
```
The 24 s turn gets **no beat at all** inside the whole turn and the user is buzzed while looking straight
at the reply. Direction: spurious push (fail-open, acceptable), but it **falsifies the commit's claim**
*"never buzzes a user who stayed, including a 45s turn"*, and the implementer's sim cannot see it because
it has no `IDLE_POLL_MS` in its model.

**Cold start (`lastInteractionMs = 0`):** yes, there is a cold-start window. At mount `lastInteractionMs`
is `0`, so `Date.now() - 0 < 300_000` is false → `isWatching()` is false → the first *hydrated* tick sends
no `watchingHuddleId` and schedules the next tick 30 s out. Two things soften it: the pre-hydration branch
ticks at 1 500 ms (and `if (hydrated) safePoll()` means no poll and no presence write happens before
hydration — fail-open), and `pageshow`/`visibilitychange` → `onVisible()` calls `markInteraction()` then
`safePoll()`, which does land one stamp. But `onVisible` still does not reschedule, so after that single
stamp the client can sit 30 s without beating → stale after 15 s. **A present user is treated as away for
up to ~30 s after load / after regaining focus.** Fail-open direction; a real AC-2.2 violation window.

**Other cadence questions asked:**
- *Does the poll fire at `PRESENCE_BEAT_MS` in every relevant state?* No — see above; and never while
  `!isWorkspaceHydrated()` (`if (hydrated) safePoll()` skips the call entirely at 1 500 ms cadence). That
  branch is fail-open (no stamp → push).
- *In-flight latency?* `safePoll()` does `void doPoll().catch(...)` and the timer is armed **immediately**,
  not after the response. So beat *launches* are every 7.5 s regardless of RTT; the stamp lands at
  launch+RTT. Worst-case row age while watching = `7.5 s + RTT`, so the design has **7.5 s of RTT budget**
  before a watching user starts ageing out of the 15 s window. Fine on a healthy link; a slow mobile
  network eats into it, again in the spurious-push direction.

---
## Adversarial focus 3 — is fail-open still intact? **YES, on every branch**

`isUserPresent` (`turns.server.ts:620-637`), traced line by line:

| Input | Path | Result |
|---|---|---|
| empty `userEmail` or empty `huddleId` | `if (!userEmail \|\| !huddleId) return false` (`:621`) | **false → PUSH** |
| `ensureBootstrapped()` throws (DDL denied, pool dead) | outer `catch { return false }` (`:635-637`) | **false → PUSH** |
| `getPool()` / `query()` throws (pool exhausted, timeout, table missing) | same outer catch | **false → PUSH** |
| no row (never seen / different huddle) | `res.rows[0]?.age_ms` → `undefined` → `:631` | **false → PUSH** |
| `age_ms` NULL | `raw === null` → `:631` | **false → PUSH** |
| `age_ms` unparseable → NaN | `!Number.isFinite(age)` → `:633` | **false → PUSH** |
| negative age (clock moved backwards) | `age < 0` → `:633` | **false → PUSH** |
| age ≥ 15 000 | `return age < PRESENCE_FRESH_MS` | **false → PUSH** |

At the caller (`huddle.functions.ts:6323-6334`) the new `try/catch` sets `stillHere = false`, and the
delivery boolean is
```ts
const wantsPush = notifyLevel !== "batch" && notifyLevel !== "silent" && !(foreground && stillHere);
```
so `stillHere = false` ⇒ `!(x && false)` ⇒ **true ⇒ push**. **The new catch cannot skip a push; it forces
one.** It also cannot fall through to the outer `catch → failTurn(); return null` (`:6396-6399`) any more.

`recordUserPresence` (`:590-604`) wraps `ensureBootstrapped()` *and* the query in its own `try/catch`, so
the `void recordUserPresence(...)` at `huddle.functions.ts:6613` can never reject → **no unhandled
rejection, and it cannot block or fail `getAllTurnUpdates`** (it is not awaited and is issued *before*
`getUserTurnsSince`).

---

## Adversarial focus 4 — new regressions

**Bootstrap SQL** (`turns.server.ts:111-117`):
```sql
CREATE TABLE IF NOT EXISTS chat.user_presence (
  user_email TEXT PRIMARY KEY, watching_huddle TEXT, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE chat.user_presence ADD COLUMN IF NOT EXISTS watching_huddle TEXT;
ALTER TABLE chat.user_presence ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
```
Valid and idempotent for PG 17 (`ADD COLUMN IF NOT EXISTS` is PG 9.6+; the repo's DB is PG 17 per
CLAUDE.md, and the same idiom is already used two blocks up for `chat.reminders`).

**NEW DEFECT (N2) — the migration does not undo `ca4d459`'s table shape.** `git show ca4d459` defines the
same table as `(user_email TEXT PRIMARY KEY, last_interaction_ms BIGINT NOT NULL, updated_at TIMESTAMPTZ …)`.
If that table already exists anywhere, `CREATE TABLE IF NOT EXISTS` is a no-op, the two `ALTER`s add the new
columns, and **`last_interaction_ms BIGINT NOT NULL` (no default) survives** — so the new
`INSERT INTO chat.user_presence (user_email, watching_huddle, seen_at)` fails permanently with
*null value in column "last_interaction_ms" violates not-null constraint*. `recordUserPresence` swallows it,
no row is ever written, and every reply pushes. Fail-open, so it degrades to "the de-noising never works",
not to a swallowed reply — but presence would be silently dead.
*Reachability:* I checked — `ca4d459` is **not** an ancestor of `origin/main` (`git merge-base
--is-ancestor` → NO; `origin/main` is still `043b932`), and the last 8 `deploy-swa.yml` runs are all
`head_branch: main`, so the old shape was almost certainly never created in prod. **NOT LIVE-VERIFIED** — I
cannot query `eds-postgresql`/`RAG_AI_Agents` from this session to confirm the table's actual columns.
One-line hardening: `ALTER TABLE chat.user_presence DROP COLUMN IF EXISTS last_interaction_ms;`.

**`buildBrief` export — no import side effects.** `standup.server.ts` has exactly one top-level import
(`AGENT_BY_ID` from `../../data/agents`), no module-scope `getPool()`, no top-level `await`, no
`process.env` read. Proven by execution: `bun scripts/blocked-line.test.mjs` imports it and passes 21/21.
(It must run under `bun` — `agents.ts` pulls a transitive `@fontsource/*.css`; that is a pre-existing
constraint, and `package.json`'s `test:blocked` correctly pins `bun`.)

**`activeIdRef`.** `const activeIdRef = useRef(activeId); activeIdRef.current = activeId;` is a ref write
during render — technically a React anti-pattern (unsafe under discarded concurrent renders), but the
write is idempotent and the value is only read inside an async poll, so it is functionally correct here.
Confirmed from the diff that the effect's dependency array was **not** changed
(`[isAuthenticated, user?.username, user?.homeAccountId, user?.localAccountId]` — `activeId` was never a
dep and still isn't), so the poll does not restart on channel switch and the cursor is not reset. The
comment at `:39-41` states this intent correctly.

**`getAllTurnUpdates` cannot block/reject on the presence write** — proven above (§3).

**Agent-initiated turns untouched.** `git show e960c86 -- src/features/huddle/components/HuddleView.tsx`
returns **empty** — the file was not modified. The sole `foreground` producer is still
`HuddleView.tsx:1028`. Agent turns (`autowork-blocked-*`, `standup-*`, `followup-*`) and the
`MeetingBar`/`useVoiceCallRealtime` paths never set it, so `foreground === true` is false, the
`if (foreground && …)` branch is **never entered**, `isUserPresent` is never called, and `wantsPush` is
byte-identical to pre-fix.

**`notify: batch/silent` still short-circuit.** `notifyLevel !== "batch" && notifyLevel !== "silent" &&
!(foreground && stillHere)` — JS `&&` evaluates left to right, so both level tests are decided before the
liveness term. **One push per turn** is preserved: the `if ((result as {partial?:boolean}).partial === true)
{ void kickNextChunk(record.id); return result; }` early return (`:6294-6297`) still precedes the whole
gate. **Push payload unchanged**: title/body/`channel:"messages"`/`app:"huddle"`/`data.deepLink`/`tag`
(`:6353-6377`) sits entirely outside the diff.

**`npx tsc --noEmit` → exit 0.**

---

## Adversarial focus 5 — the mirrored constant

`PRESENCE_BEAT_MS` is defined twice: `turns.server.ts:576` (`7_500`) and `HuddleApp.tsx:26` (`7_500`).
**They agree today** (grep-verified). The comment at `HuddleApp.tsx:22-25` explains why it is mirrored
(server-only module) and warns about drift.

**The risk, stated plainly:** nothing enforces the relationship. There is no shared constants module, no
type-level link, and — critically — **the one artefact that claims to guard it, `presence-timing.test.mjs`,
hardcodes `BEAT=7500, FRESH=15000` rather than importing either file**, and is not in `package.json`. So
the guard is decorative: raise the client beat above `PRESENCE_FRESH_MS`, or lower the server window below
one beat, and nothing anywhere fails. The invariant that actually matters is
`PRESENCE_BEAT_MS + worst-case RTT < PRESENCE_FRESH_MS` (today: 7.5 s + RTT < 15 s ⇒ 7.5 s of RTT budget).
Making the sim import `PRESENCE_BEAT_MS`/`PRESENCE_FRESH_MS` from `turns.server.ts` and assert that
inequality, and wiring it into `package.json`, would convert it from prose into a real guard.

---
## Per-defect verdicts

| Defect | Claim | Verdict | Basis |
|---|---|---|---|
| **D1** standup leaked a raw slug as a person | resolves via `AGENT_BY_ID[...]?.name`; test extended to drive the resolver and confirmed to fail 19/21 against the defective line | **CLOSED** | Read `standup.server.ts:62`; **re-ran the mutation myself** — reverted the line, `bun scripts/blocked-line.test.mjs` → 19/21, exit 1, failing on `- "Alpha" — needs you — sam-trent-old needs you on this`; restored, 21/21, exit 0, `git status` clean |
| **D2** headline scenario suppressed | heartbeat presence, 7.5 s beat / 15 s window; pushes at 19/24/30 s, never buzzes a user who stayed | **PARTIALLY CLOSED** | Closed for AC-2.1 as written (tab hidden / backgrounded / asleep) — my own sim pushes at 19/24/30/45 s. **Still open for desktop walk-away**: `ATTENTION_MS = 5 min` keeps the beat alive on a focused, visible window, so the reply push is swallowed for any turn under ~5 min. And "never buzzes a user who stayed" is falsified by the cadence latch (N1) |
| **D3** clock skew | client sends only `watchingHuddleId`; server stamps `now()`; age in SQL | **CLOSED** | `AllTurnUpdatesInput` has no timestamp; repo sweep for `lastInteractionMs`/`last_interaction_ms`/`GREATEST` finds only client-local closure state; SQL `EXTRACT(EPOCH FROM (now() - seen_at)) * 1000` verified correct |
| **D4** huddle scoping | `watching_huddle` column matched in WHERE | **CLOSED** | Column present and matched (`:627`); one-row-per-user PK means a reply in another huddle matches no row → `false` → push |
| **D5** throw could discard a reply | own try/catch in `executeClaimedTurn` | **CLOSED** | Present at `:6325-6333`, degrades to `stillHere=false`, which the `wantsPush` boolean turns into **push**, not silence |

### New defects introduced or newly visible in this rework

| # | Severity | Defect |
|---|---|---|
| **R1** | **High** | **`ATTENTION_MS = 5 min` re-opens the headline bug for desktop walk-away.** Send from a focused, visible desktop window, then leave the room: the heartbeat keeps beating for 5 minutes, the row never goes stale, and the reply push is swallowed for every turn under ~5 min. Same failure *direction* as the original outage (a message the user is never told about), and the case where the phone push matters most. Effective suppression bound is 300 s, not the advertised 15 s. Fix: gate the beat on a much shorter attention window (≈20–30 s, still above one beat), or drop `touched` and rely on `visible && focused` with a short idle timeout. |
| **R2** | Medium | **Cadence latch (N1).** `tick()` picks its delay from `isWatching()` at schedule time; neither `markInteraction` nor `onVisible` reschedules the timer. A desktop alt-tab back in fires no `visibilitychange`, so the client stays on `IDLE_POLL_MS = 30 s` for up to 30 s while genuinely watching — my sim shows a 24 s turn getting **zero** beats and buzzing a watching user. Same for cold start (`lastInteractionMs = 0` ⇒ first hydrated tick schedules 30 s out). Direction is fail-open (spurious push), but it falsifies "never buzzes a user who stayed". Fix: `clearTimeout(timer); tick();` (or arm a short timer) inside `markInteraction`/`onVisible` when the state flips to watching. |
| **R3** | Medium | **`scripts/presence-timing.test.mjs` is not a guard.** It hardcodes `BEAT=7500, FRESH=15000` instead of importing `turns.server.ts`, has no `IDLE_POLL_MS` in its client model, and models "the user left" as "beats stop" rather than as `isWatching()` going false — which is why it cannot see R1 or R2. It is also not in `package.json`, so nothing runs it. Reverting `PRESENCE_FRESH_MS` to `30_000` would leave it printing `ALL PASS`. |
| **R4** | Medium | **Stale `last_interaction_ms NOT NULL` column from `ca4d459` is not migrated away (N2).** Where the old table already exists, every presence INSERT fails the not-null constraint, `recordUserPresence` swallows it, and presence is silently dead (fail-open ⇒ everything pushes). `ca4d459` is not in `origin/main` and no `deploy-swa.yml` run used this branch, so prod is very likely unaffected — **NOT LIVE-VERIFIED**. Add `ALTER TABLE chat.user_presence DROP COLUMN IF EXISTS last_interaction_ms;`. |
| **R5** | Low | **`isWatching()` now runs inside `tick()`'s unguarded `setTimeout` argument.** If it ever threw, the timer is never re-armed and the whole cross-huddle back-fill poll dies for that session — a much larger blast radius than presence. Previously that expression was pure arithmetic. Wrap it once per tick in a try/catch. |
| **R6** | Low | **Mutation coverage is one-sided.** `blocked-line.test.mjs` drives the *real* resolver only on the standup surface; the two "autowork" cases use a replica (`const resolve = (id) => AGENT_BY_ID[id]?.name;`) written in the test file, so a regression at `autowork.server.ts:783` would not be caught. The two expressions agree today (verified by reading both). |
| **R7** | Low | `activeIdRef.current = activeId` is assigned during render. Idempotent and correct in practice, but the React-sanctioned form is an effect or `useSyncExternalStore`. |

### Not verifiable from this session (NOT LIVE-VERIFIED)
- Actual columns of `chat.user_presence` in `eds-postgresql`/`RAG_AI_Agents` (R4).
- Real-browser behaviour of `document.hasFocus()` / `visibilitychange` on the deployed SWA, mobile Safari
  and the Android bridge app (AC-2.10).
- A real device receiving (or not receiving) the push — AC-2.1 / AC-2.20 need the user's own confirmation.
- Terry's actual reply wording for a live blocked-surface turn (AC-1.8).
