## Goal

Give each signed-in Entra user a huddle profile with:
- A chosen **username** (unique handle)
- **One or more email addresses** attached to it (any email they've signed in with, or any they add manually)

No verification emails, no primary/secondary distinction, no promotion rules. Just: a username, and a list of emails that resolve to the same person. LinkedIn was the reference only because the shape is familiar — this build is intentionally simpler.

## Data model (Azure PG, new `identity` schema)

```text
identity.profiles
  entra_object_id  text primary key         -- Entra oid from MSAL
  username         citext unique not null   -- 3-30 chars [a-z0-9_-]
  display_name     text
  created_at       timestamptz default now()
  updated_at       timestamptz default now()

identity.profile_emails
  id               uuid primary key
  entra_object_id  text references identity.profiles on delete cascade
  email            citext not null
  source           text not null            -- 'entra' | 'manual'
  added_at         timestamptz default now()
  unique (lower(email))                     -- one email → one profile
```

`citext` = case-insensitive matching. Global email uniqueness so two profiles can't claim the same address.

On first `getMyProfile()` call after sign-in:
- Insert a `profiles` row keyed by the MSAL `homeAccountId` / `localAccountId` (oid), with `username` auto-derived from the Entra email local-part (deduped with a numeric suffix if taken).
- Insert the Entra sign-in email into `profile_emails` with `source='entra'`.

If the same user later signs in with a different Entra identity that shares an email already in `profile_emails`, we surface it in the UI as "this email is already linked to @username" — no auto-merge.

## UX — new "Account" tab in Settings

Only shown when signed in. Three fields, no wizards:

```text
┌ Account ────────────────────────────┐
│ Username                            │
│   [ flex_grimes         ] [ Save ]  │
│                                     │
│ Display name                        │
│   [ Alex Rivera         ] [ Save ]  │
│                                     │
│ Emails                              │
│   • alex@enterpriseds.com  (Entra)  │
│   • alex.personal@gmail.com  Remove │
│   [ + Add email ]                   │
└─────────────────────────────────────┘
```

- Username edit is validated for format + uniqueness; no cooldown.
- Adding an email just inserts a `manual` row after a format check and uniqueness check. No verification link.
- Removing an email is allowed for any `manual` row. The `entra` row (the address the user is currently signed in with) is not removable — deleting it would orphan the profile from its login.

## Server functions

New file `src/features/huddle/lib/identity/profile.functions.ts`, each guarded by MSAL bearer middleware that resolves `entra_object_id` from the token. All return the same `{ profile, emails }` payload so one query key covers everything.

- `getMyProfile()` — auto-provisions on first call.
- `updateUsername({ username })`
- `updateDisplayName({ displayName })`
- `addEmail({ email })`
- `removeEmail({ emailId })` — rejects `source='entra'` rows.

## Client wiring

- `src/hooks/useProfile.ts` — TanStack Query hook.
- `src/features/huddle/components/AccountSettingsPanel.tsx` — the tab body.
- `src/features/huddle/components/SettingsSheet.tsx` — add "Account" tab, only when `useAuth().isAuthenticated`.

## How this unblocks other work

- `entra_object_id` becomes the key for moving huddle store state off localStorage (open item #3).
- `identity.profile_emails` is the exact input the `huddle_user_aliases` bridge to journey-voice needs (from `.lovable/plan.md`) — every row already maps an email to one Entra identity.

## Out of scope

- Email verification / ownership proof.
- Primary vs secondary emails.
- Public `/@username` pages.
- Merging two profiles that share an email (surface conflict, don't auto-resolve).

## Order

1. Migration: `identity` schema + two tables + `citext` extension.
2. `profile.functions.ts` with auto-provision on `getMyProfile`.
3. `useProfile` hook + `AccountSettingsPanel` + Settings tab wiring.
4. Smoke test: sign in → profile auto-created with Entra email → edit username → add second email → remove it.
