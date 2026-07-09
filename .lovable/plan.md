## Goal

Replace the Zustand `persist(localStorage)` layer in `src/features/huddle/store.ts` with a per-user store persisted to Azure Postgres, keyed by the signed-in Entra `oid` (via the `identity.profiles.id` we already provision). Also fixes:

- Account tab `block_nested_popups` (already patched — silent → popup fallback in iframe).
- Journey tools "no such ability" — audit tool wiring after migration lands, in a follow-up.

## What persists per user

From current `partialize`:
- `messages` (per huddle)
- `tasks` (kanban)
- `memory` (RAG surface items)
- `decisions` (routing log)
- `activeHuddleId`
- `showDemoData`
- `journeyTasks`

Demo seed remains in code (`SEED_*`). New users still see it via the existing `showDemoData` toggle; their own writes go to the DB.

## Schema (new migration in `identity.server.ts` bootstrap)

```text
identity.workspace_state (
  profile_id  uuid PRIMARY KEY REFERENCES identity.profiles(id) ON DELETE CASCADE,
  state       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version     int   NOT NULL DEFAULT 3,
  updated_at  timestamptz NOT NULL DEFAULT now()
)
```

Single-row JSONB blob per user. Same shape as the current `partialize` output — simplest, no per-table schema churn, and the store already treats it as one bag. We can normalize later if any single field grows unbounded.

## Server functions (new `workspace.functions.ts`)

- `loadWorkspace({ idToken })` → `{ state, version, updatedAt } | null`
- `saveWorkspace({ idToken, state, version })` → `{ updatedAt }` (upsert)

Both verify the ID token via `verifyEntraIdToken`, resolve profile via `getOrCreateProfile`, then read/write the row.

## Client integration (`store.ts`)

Replace the `persist` middleware with a custom sync layer:

1. Keep Zustand store in-memory with the same shape (no API change to consumers).
2. New `useWorkspaceSync()` hook mounted once in `HuddleApp`:
   - On sign-in: `loadWorkspace` → `store.setState(remote.state)`. If null, keep seed defaults and immediately save.
   - Subscribe to store changes; debounce 800ms; call `saveWorkspace` with `partialize`d payload.
   - On sign-out: reset store to seed defaults.
3. Signed-out users: fall back to the current localStorage behavior (keep `persist` behind a flag) so the app still works pre-auth. Simplest: keep `persist` but namespace the key by `oid` when signed in, OR just skip persistence entirely when signed out and rely on in-memory + seed. I'll go with **skip persist when signed out** to avoid two sources of truth.

## Files touched

- New: `src/features/huddle/lib/identity/workspace.functions.ts`
- Edit: `src/features/huddle/lib/identity/identity.server.ts` — add `workspace_state` table to bootstrap + `loadWorkspace`/`saveWorkspace` helpers.
- Edit: `src/features/huddle/store.ts` — remove `persist` middleware, expose `hydrateFromRemote(state)` and `getPersistablePayload()`.
- New: `src/features/huddle/hooks/useWorkspaceSync.ts` — mount-once sync loop using `useAuth` + `getToken`.
- Edit: `src/features/huddle/components/HuddleApp.tsx` — call the sync hook.

## Migration safety

On first successful `loadWorkspace` returning null, if the browser has an existing `huddle-workspace` localStorage blob, upload it once as the initial state (one-shot migration), then clear the local key. This preserves existing demo edits already accumulated in the browser.

## Out of scope this pass

- Journey tools not recognized — separate investigation after migration lands.
- Multi-device conflict resolution — last-write-wins is fine; single active tab per user is the common case.
- Splitting messages/tasks into their own tables (future normalization).

## Verification

- `bunx tsgo --noEmit` clean.
- Playwright: sign in via preview, send a message, reload — message survives; sign out from a second browser context — no data leak.
