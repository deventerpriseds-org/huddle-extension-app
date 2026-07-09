## Plan: port Bridge Builder's Entra External ID login into Huddle

Add a client-side login gate using MSAL against your existing Entra CIAM app (tenant `enterpriseds`, client `59465948-6e95-4124-984e-a43acade2fa9`). Any user who successfully signs in via Google-through-Entra can use the app. Server functions stay open (unchanged).

### 1. Package + env

- `bun add @azure/msal-browser`
- Add to `.env` (and document in a new `.env.example`):
  ```
  VITE_ENTRA_TENANT_NAME=enterpriseds
  VITE_ENTRA_TENANT_ID=b9791c7d-dd6c-4190-b1bb-dbbd1996bc2e
  VITE_ENTRA_CLIENT_ID=59465948-6e95-4124-984e-a43acade2fa9
  ```
- In the Entra app registration → Authentication → SPA redirect URIs, you'll need to add both this project's dev preview URL and its published URL. I'll list the exact URLs in the closing message so you can paste them into the portal.

### 2. Auth module — `src/lib/entra-auth.ts`

Direct port of `web/src/lib/b2cAuth.ts` with three SSR-safety changes:

- Do not construct `PublicClientApplication` at module top level. Export `getMsal()` that lazily instantiates on first browser call, guarded by `typeof window !== "undefined"`. Server-side calls return `null`.
- `redirectUri: window.location.origin` stays, but only read inside `getMsal()`.
- `cacheLocation: "localStorage"`, `storeAuthStateInCookie: true`, `navigateToLoginRequestUrl: false` — same as Bridge Builder.
- Exports: `initMsal()`, `getMsal()`, `getCurrentUser()`, `signIn()`, `signOut()`, `getToken()`. Scopes: `openid profile email`.

### 3. Bootstrap — `src/start.ts` stays server-only; MSAL init happens client-side

TanStack Start has no `main.tsx` we control. Do MSAL init in a client-only component wrapper. Add `src/components/MsalBootstrap.tsx`:

- On mount: `await msal.initialize()` then `await msal.handleRedirectPromise()`.
- Renders a small full-screen "Signing you in…" placeholder until both promises resolve, then renders `children`.
- Wraps its work in `useEffect` + a `ready` state so SSR renders the same placeholder markup.

Mount it inside `RootComponent` in `src/routes/__root.tsx` around `<Outlet />`, inside the existing `QueryClientProvider`. Nothing else in `__root.tsx` changes.

### 4. Route structure

TanStack Start file routes:

- `src/routes/auth.tsx` — public login page (port of `pages/Auth.tsx`, restyled to match Huddle's dark theme + existing shadcn primitives, not the neutral-50 Compass card). Uses `signIn()` on button click. If already signed in, `redirect({ to: "/" })` from `beforeLoad`.
- `src/routes/_authenticated.tsx` — pathless layout, `beforeLoad` reads `getCurrentUser()`; if null, `throw redirect({ to: "/auth" })`. Component returns `<Outlet />`.
- Move current `src/routes/index.tsx` → `src/routes/_authenticated/index.tsx` (same content, still renders `<HuddleApp />`). Keeps `/` as the URL.

The router already runs `defaultPreloadStaleTime: 0`, so no changes to `src/router.tsx`.

MSAL cache is browser-only, so this layout must be `ssr: false` (add `ssr: false` to `_authenticated.tsx` and to `auth.tsx`). Without this, `getCurrentUser()` throws during SSR/prerender.

### 5. Auth state hook — `src/hooks/useAuth.ts`

Port of Bridge Builder's `useAuth.ts`. Subscribes to `msalInstance.addEventCallback` and re-reads `getCurrentUser()`. Exposes `{ user, isAuthenticated, signIn, signOut }`. Used by the sign-out button and the header account chip.

### 6. Sign-out affordance in the UI

The current `Sidebar` and `Rail` have no account UI. Add a small account row to `src/features/huddle/components/Sidebar.tsx` bottom edge: avatar circle with initials + display name + a chevron that opens a dropdown-menu (already in shadcn) with "Sign out". Sign-out handler:

1. `await queryClient.cancelQueries()` — via a `useQueryClient()` call.
2. `queryClient.clear()`.
3. Clear the persisted huddle store: `localStorage.removeItem("huddle-workspace")` (the persist key from `src/features/huddle/store.ts`) so the next user doesn't see stale messages.
4. `await signOut()` — MSAL redirect.

MSAL redirects back to `/`; the `_authenticated` guard then bounces to `/auth`.

### 7. Session-driven header

The mobile top bar in `HuddleApp.tsx` gets a small "Signed in as {name}" tooltip on the settings button — cosmetic, no behavior change. Not adding a full account menu on mobile — the sidebar sheet already exposes it.

### 8. Files touched

New:
- `src/lib/entra-auth.ts`
- `src/hooks/useAuth.ts`
- `src/components/MsalBootstrap.tsx`
- `src/routes/auth.tsx`
- `src/routes/_authenticated.tsx`
- `src/routes/_authenticated/index.tsx`
- `.env.example` (or append)

Edited:
- `src/routes/__root.tsx` — wrap `<Outlet />` with `<MsalBootstrap>`.
- `src/features/huddle/components/Sidebar.tsx` — add account footer + sign-out.
- `package.json` — `@azure/msal-browser` dep.

Deleted:
- `src/routes/index.tsx` (moved under `_authenticated/`).

### 9. What's intentionally NOT changed

- Server functions (`huddle.functions.ts`, `rag.functions.ts`, `agent-inspect.functions.ts`) — no bearer verification. If you later want server-side JWT verification, that's a separate task adding `jsonwebtoken` + `jwks-rsa` and a `functionMiddleware` in `src/start.ts`.
- No user allowlist — any Entra-authenticated user gets in, per your answer.
- No `profiles` / `user_roles` tables — user identity lives entirely in the Entra token, matching Bridge Builder.
- No redirect-back memory — MSAL always lands on `/` (Bridge Builder's behavior).

### 10. Verification steps

1. `bun run build` succeeds.
2. Visit `/` unauthenticated → redirected to `/auth`.
3. Click "Continue with Google" → Entra flow → back to `/` → HuddleApp renders.
4. Refresh `/` → still authenticated (localStorage cache).
5. Click sign out → back to `/auth`; hitting Back doesn't restore the app shell (React Query cache + persist store cleared).
6. Check network tab: server functions still called without an Authorization header, as intended.
