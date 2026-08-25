# Independent re-verification — rework commit e960c86

Verifier: independent agent, no shared context with implementer.
Started: (in progress)

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
