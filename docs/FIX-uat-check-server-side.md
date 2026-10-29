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
