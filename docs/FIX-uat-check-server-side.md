<!--
WHAT:       Working record for moving Huddle's UAT sign-in token check from the browser to the server.
WHY:        deploy-swa.yml wrote VITE_UAT_BYPASS_TOKEN=<org secret UAT_BYPASS_TOKEN> into the build env,
            so Vite inlined the secret into the PUBLIC client bundle (src/lib/entra-auth.ts compared
            ?uat_token= against it client-side). Nexus (nexus-hub api/src/lib/auth.ts) accepts the SAME
            secret as a verified write identity, so the bundle leaked a Nexus write credential.
SUPERSEDES: the client-side compare in src/lib/entra-auth.ts (checkUatBypass, pre-2026-10-29).
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file (steps + verbatim outputs below); branch claude_uat-check-server-side.
-->

# FIX: UAT bypass check moves server-side (owner decision 2026-10-29, option A)

Owner condition: "as long as it doesn't introduce any inconveniences for me as a user".

## Step 0 -- facts read before changing anything (origin/main 9afd68e)

| Observation | Source |
|---|---|
| `VITE_UAT_BYPASS_TOKEN=${{ secrets.UAT_BYPASS_TOKEN }}` written into `.env.production` (build env) | `.github/workflows/deploy-swa.yml:201` |
| Client compares `?uat_token=` against `import.meta.env.VITE_UAT_BYPASS_TOKEN` | `src/lib/entra-auth.ts:248,259-283` |
| `UAT_BYPASS_TOKEN` is NOT in the "Sync secrets -> SWA app settings" list, so the server runtime never had it | `deploy-swa.yml` `az staticwebapp appsettings set` block |
| Only two files in the repo mention `VITE_UAT_BYPASS_TOKEN` | `grep -rln` over the tree (excluding node_modules/.git) |
| Harnesses pass `?uat_token=<UAT_BYPASS_TOKEN>` on first load; `run-uat.mjs` waits domcontentloaded + networkidle(8s) + 1.5s | `.claude/skills/test-agent-serverfn/scripts/run-uat.mjs:97-113`, `e2e/*.e2e.mjs` |
| Callers of the auth state: `MsalBootstrap` (awaits `initMsal` before rendering children), `_authenticated`/`auth` route `beforeLoad` (await `initMsal` then read `getCurrentUser`), `useAuth`, `useWorkspaceSync` (`isAuthBypassActive`) | grep of `src/` |

## Step 1 -- what changed

```
browser load
  |
  |-- URL has NO ?uat_token=  (every normal owner load)
  |     startUatCheck() -> null, synchronously. No import, no request, no await.
  |     initMsal() -> initMsalCore()  == the previous MSAL body, byte-for-byte
  |
  `-- URL HAS ?uat_token=X  (harness only)
        1. strip uat_token from the address bar (always, match or not)
        2. lazy-import the RPC stub, POST X once to verifyUatToken (server fn)
        3. server: sha256(X) vs sha256(process.env.UAT_BYPASS_TOKEN), timingSafeEqual -> true|false
        4. true  -> UAT account, MSAL skipped (as before)
           false / network error -> falls through to the real MSAL path (initMsalCore)
```

| File | Change |
|---|---|
| `src/lib/uat-bypass.server.ts` (new) | `matchUatToken` / `checkUatTokenServer`: constant-time compare, bare boolean, empty/unset setting never matches, >512 chars refused |
| `src/lib/uat-bypass.functions.ts` (new) | `verifyUatToken` server fn (`createServerFn` POST, same pattern as `profile.functions.ts`); returns `checkUatTokenServer(...) === true` only. Lenient validator: malformed input is `false`, never an error echoing input |
| `src/lib/uat-bypass-url.ts` (new) | `hasUatTokenParam`, `resolveUatBypassFromUrl` (strip first, verify once, `=== true` only, errors -> false). Named `-url` not `.client`: TanStack Start's import-protection denies `**/*.client.*` from server code, and `entra-auth.ts` is imported by SSR routes (the first build failed on exactly this) |
| `src/lib/entra-auth.ts` | build-time token constant removed; `startUatCheck` memoized promise; `initMsal` wraps the unchanged body (now `initMsalCore`) |
| `.github/workflows/deploy-swa.yml` | VITE_ token line removed from `.env.production`; `UAT_BYPASS_TOKEN="${{ secrets.UAT_BYPASS_TOKEN }}"` added to the existing `az staticwebapp appsettings set` list (same org secret, nothing minted). That step runs BEFORE "Deploy to Static Web Apps" in the same job, so the server has the setting before the new code is live |
| `scripts/uat-check-server-side.test.ts` (new), `package.json` | `npm run test:uat-server-check` |

Behaviour difference worth knowing: a WRONG `?uat_token=` is now stripped from the URL too (before, only a match was stripped).

## Step 2 -- evidence

**Offline suite:** `bun scripts/uat-check-server-side.test.ts` -> `32 passed, 0 failed`.
**Typecheck:** `npx tsc --noEmit -p .` -> exit 0.

**Bundle grep** (`npm ci --ignore-scripts`, then
`UAT_BYPASS_TOKEN=SENTINELUATb7e19c42 VITE_UAT_BYPASS_TOKEN=SENTINELUATb7e19c42 VITE_ENTRA_TENANT_NAME=SENTINELCTRL55a1 NITRO_PRESET=azure-swa npm run build`;
client output is `.output/public`, server is `.output/server`):

| Build | files in `.output/public` containing the token sentinel | files containing the control sentinel (a VITE_ var the client DOES read) |
|---|---|---|
| origin/main `entra-auth.ts` (positive control) | **1** (`assets/index-CToXNwnW.js`) | -- |
| this branch | **0** | 1 (`assets/index-*.js`) -- proves the env reached the build and grep would see it |

Also on this branch: token sentinel in ALL of `.output` (server too) = 0 (the server reads it from the
app setting at run time, never inlined); `VITE_UAT_BYPASS_TOKEN` string anywhere in `.output` = 0;
`UAT_BYPASS_TOKEN`/`matchUatToken` in `.output/public` = 0 (compare code is server-only, in
`.output/server/functions/_ssr/uat-bypass.server-*.mjs`). The client gets a separate 221-byte lazy
chunk `uat-bypass.functions-*.js` holding only the RPC id:
`createServerFn({method:"POST"}).handler(<sha256 fn id>)`, loaded via dynamic `import()` only inside
`startUatCheck`.

## Step 3 -- mutation proofs (`mutate.sh`, anchors in scratch `mut-uat-server/`), verbatim

```
m1  deploy-swa.yml re-add VITE_ token line       FIRED: 'A3 deploy-swa.yml never mentions' failed with the defect reinstated. The guard is real.
m2  deploy-swa.yml drop app-setting sync         FIRED: 'A5 UAT_BYPASS_TOKEN is synced' failed with the defect reinstated. The guard is real.
m3  entra-auth.ts re-add import.meta.env read    FIRED: 'A1 no src/ file mentions' failed with the defect reinstated. The guard is real.
m4  server: drop max-length refusal              FIRED: 'B10 oversized supplied' failed with the defect reinstated. The guard is real.
m5  server: prefix compare instead of digest     FIRED: 'B3 prefix of the token' failed with the defect reinstated. The guard is real.
m6  server fn returns the token on match         FIRED: 'B13 the server function returns only the boolean' failed with the defect reinstated. The guard is real.
m7  client: call server with no param            FIRED: 'C1 no uat_token' failed with the defect reinstated. The guard is real.
m8  client: do not strip token from URL          FIRED: 'C6 token stripped from the URL BEFORE' failed with the defect reinstated. The guard is real.
m9  client: truthy instead of === true           FIRED: 'C9 a non-boolean truthy answer' failed with the defect reinstated. The guard is real.
m10 entra-auth: drop the param gate              FIRED: 'C11 entra-auth gates the server-fn import' failed with the defect reinstated. The guard is real.
m11 entra-auth: rejected check skips real MSAL   FIRED: 'C14 initMsal: a rejected/failed UAT check' failed with the defect reinstated. The guard is real.
```
Tree clean after all 11. Honest limits: A*/B13/C11/C13/C14 are SOURCE-TEXT guards (they read files),
not runtime proofs; B1-B12 and C1-C10 execute the real functions. `timingSafeEqual` itself is not
proven to be constant-time by any test (m5 proves the digest compare is what decides, not timing).

## Step 4 -- owner path, harness, rotation

- **Owner's normal Entra sign-in: unchanged.** No `uat_token` -> `startUatCheck()` returns null
  synchronously -> `initMsalCore()` (the old body). No extra request, chunk, spinner or redirect.
- **Harness:** same interface (`?uat_token=` on first load, single use). Activation now costs one
  server round-trip behind the existing "Signing you in..." placeholder; `run-uat.mjs` waits for
  networkidle (8s) + 1.5s and the e2e scripts `goto(..., {waitUntil:"networkidle"})`, which include
  that request. No harness file changed. A cold SWA function could add seconds to that first
  request -- NOT measured here (offline only).
- **Not yet live:** nothing here has been deployed or exercised against the SWA.

### Rotation of the org secret (the old value has been public)

This fix stops FUTURE leaks; it cannot un-publish the value already served in past bundles. Only
rotating `UAT_BYPASS_TOKEN` (org secret in `deventerpriseds-org`) retires it.

Who reads the secret (grep, 2026-10-29; nexus-hub read-only, local checkout):

| Repo | Reader | Picks up a new value when |
|---|---|---|
| huddle | `deploy-swa.yml` -> SWA app setting `UAT_BYPASS_TOKEN` (this branch) | next deploy-swa run |
| huddle | ~24 harness workflows (`verify-uat.yml`, `board-uat.yml`, `qa-*.yml`, `ceremony-*.yml`, `realtime-*.yml`, ...) as `UAT_TOKEN`/`UAT_BYPASS_TOKEN` env | automatically, next run |
| nexus-hub | `.github/workflows/api-deploy.yml:125` -> Function App setting (read by `api/src/lib/auth.ts` `x-uat-token` and the fenced `POST /api/auth/uat-token`) | next api-deploy run |
| nexus-hub | `.github/workflows/api-test.yml:76` | automatically, next run |

Order matters: **ship this branch to prod FIRST, then rotate.** Rotating before this fix deploys would
make the next Huddle deploy inline the NEW value into the bundle. After rotating: re-run Huddle's
`deploy-swa.yml` and nexus-hub's `api-deploy.yml` (until both run, each server still holds the old,
public value). Rotation is an org-secret write -- an owner/admin action, not done here.
