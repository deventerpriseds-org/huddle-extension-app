# VERIFY download-tab loop 2

WHAT: independent verification of the Download-tab feature claims C1-C6.
WHY: loop 1 was killed by a container restart with nothing pushed.
SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE: inline per claim.

Started 2026-11-11 04:22 UTC, budget 25 min (ends 04:47).
Verifier (loop 2, second start) runs in an isolated huddle worktree; this file is committed and pushed per claim.

| Claim | Verdict |
|---|---|
| C1 | CONFIRMED |
| C2 | CONFIRMED (code + tests; live 401 not observed) |
| C3 | CONFIRMED (with defect D1) |
| C4 | CONFIRMED in code; NOT LIVE (claim of not-live CONFIRMED); defect D4 |
| C5 | CONFIRMED (with defect D5) |
| C6 | CONFIRMED (8/8; two checks weak, none vacuous in this run) |

## C1 -- bridge-builder getLatestApk: CONFIRMED

Source: origin/main 31edc9f (PR #2), read via GitHub contents API and a detached /tmp copy.
- Newest by upload time: `api/src/lib/latestApk.ts` `pickLatestApk` skips names not under `<appId>/`, not ending `.apk`, or with a further `/` (direct children only); keeps max `lastModified`. Version from `parseApkVersion` regex `-v(\d+(?:\.\d+)*)\.apk$`.
- Fresh SAS: `getLatestApk.ts` calls `generateSasUrl(latest.blobPath)` per request; `blobStorage.ts:37-45` read-only (`'r'`), 30-day expiry, container `bridge-apks`.
- 503: `getLatestApk.ts` `if (!expected) return 503 not_configured` (before auth).
- 401: `tokenMatches` sha256 both sides then `timingSafeEqual` (equal-length digests, constant time); null/empty given -> false.
- 400: `parseAppIds` returns null for 0 or >5 ids (after de-dup) or any non-uuid.
- Registered: `api/src/index.ts:12  import './functions/getLatestApk'`.
- Tests (my run, /tmp/vbb/api, `npm ci` rc=0, `npm test`): `# tests 4 # pass 4 # fail 0`.
Observations (not claim failures):
- C1-a: `generateSasUrl` swallows errors and returns `''` (blobStorage.ts:51-54), so a SAS failure yields `found:true, downloadUrl:""`. Downstream must treat that as no link (checked under C2/C5).
- C1-b: version is never compared; "latest" is purely upload time. A re-upload of an older APK would be reported as latest. Matches the claim wording ("by upload time").
- C1-c: the 500 branch returns `err.message` to the caller (server-to-server only; not a token leak).

## C2 -- journey-voice edge fn app-downloads: CONFIRMED (code + unit tests); live behaviour UNVERIFIED

Source: journey-voice origin/main 5645ccc (contains 4b498cb), read from a /tmp copy.
- Refuses non-users: `supabase/functions/app-downloads/index.ts:18-21` strips `Bearer`, calls `supabase.auth.getUser(jwt)`, returns `401 {ok:false, reason:"sign_in_required"}` when no user. The anon key is a JWT with no `sub`, so `getUser(anonKey)` returns no user; `supabase/config.toml:177-178 verify_jwt = true` only gates on a valid JWT, which the anon key is, so the in-function check is the real guard.
- Token never to browser: token read at :23, used only as the outbound `x-journey-proxy-token` header at :30; responses are `{ok, reason}` or `{ok:true, apps: shapeDownloads(...)}` (:24, :35, :38, :41). Logs print only status / error message (:34, :40).
- Fixed order: `_shared/app-downloads.ts:15-18` DOWNLOAD_APPS = [taskos 54beaa01..., huddle 8596e6c2...]; `shapeDownloads` (:44-58) maps over DOWNLOAD_APPS, so always 2 rows in that order.
- Link filter: `isBlobLink` (:33-41) requires `https:`, hostname ending `.blob.core.windows.net`, and `sig=` in the query; anything else -> `found:false, downloadUrl:null`. This also neutralises C1-a (empty SAS string -> not found).
- Tests (my run): `node --experimental-strip-types --test supabase/functions/_shared/app-downloads.test.ts` -> `# tests 3 # pass 3 # fail 0`.
- Deployed: `Deploy Supabase Functions` run 42815905962 on 4b498cb, conclusion success (log not read for the per-function line).
- Live call: `curl https://wwxgajrtmslzklnyplah.supabase.co/functions/v1/app-downloads` from this sandbox -> `CONNECT tunnel failed, response 403` (egress proxy). So the anon-key 401 is proven from code only, not observed.
- Note: a 401 from bridge-builder surfaces as `502 reason "bridge_401"`; `ids` param is the two constants, not caller-controlled.

## C3 -- sync-bridge-builder-token.yml: CONFIRMED, with defect D1

- Write-only-on-change: `.github/workflows/sync-bridge-builder-token.yml:35-38` reads current value, compares, `appsettings set ... -o none` only when different.
- Run 42812484523 / job 129817142410 (branch claude_download-tab, a748a3a), log lines:
  `12:03:36 written (Function restarts)` / `attempt 1: HTTP 200` / `[{"appId":"54beaa01-...","found":true,"version":"1.0.18","builtAt":"2026-11-05T19:20:50.000Z"},{"appId":"8596e6c2-...","found":true,"version":"1.0.17","builtAt":"2026-11-08T16:39:54.000Z"}]` / `without token: HTTP 401`.
- Main run 42815906148 / job 129828814297 on 4b498cb, success: `12:27:43 unchanged` (proves the no-rewrite branch) / `attempt 1: HTTP 200` / same two versions / `without token: HTTP 401`.
- No link or token in logs: jq projection drops `downloadUrl` (:48); token is masked `***`.
- **D1 (defect): the smoke test cannot fail the job.** `:45-49` loops 6 times and breaks on 200, but never `exit 1` when all 6 miss, and never asserts the no-token call is 401. A broken endpoint still yields a green run. The "smoke-tested" claim holds only because the logs happen to show 200/401; the job conclusion is not evidence.
- D2 (gap): only "no token" is probed, not a WRONG token; the wrong-token 401 rests on C1 code + unit test.
- D3 (operational): trigger is `push` on this workflow file only (+ dispatch). Rotating the GitHub secret does not re-sync the Function until someone dispatches it.

## C4 -- journey-voice Settings "Download" tab: code CONFIRMED, NOT live (as claimed), defect D4

- `src/pages/Settings.tsx:55  { value: 'download', label: 'Download', icon: Download }`, `:193-194 <TabsContent value="download"> <AppDownloadsSettings />`, import at :40.
- `src/components/AppDownloadsSettings.tsx` calls `supabase.functions.invoke('app-downloads', {method:'GET'})` (:62), renders one row per returned app, Download button only when `downloadUrl` is non-null (:108-112).
- Typecheck/build run 42815756501 (branch claude_download-tab-typecheck, 1eb1d73): conclusion success; steps `typecheck (new files)` success and `npx vite build 2>&1 | tail -5` success. **Weak evidence:** the build step is piped into `tail` under `bash -e` without `pipefail`, so its exit code is tail's, and a failed build would still be green; the typecheck covers "new files" only. Log body not read.
- Live: journey UAT run 42958573043, `uat-shots` commit 545af656 `uat-shots/results.json`:
  - `C0 live bundle contains the Download tab ('Latest Android builds')` pass:false, detail `NOT in any of 1 JS files served by https://journey-voice.lovable.app -- #110 is likely not published by Lovable yet`
  - `C1 signed in as owner -> /settings renders` pass:true `landed on /settings`
  - `C2 Settings has a tab labelled 'Download'` pass:false `matches: 0`
  - console errors: pass; failed requests: pass:false (repeated `net::ERR_ABORTED .../rest/v1/error_log`, unrelated to this feature)
  So the claim "NOT live yet" is CONFIRMED by that run. The tab is not reachable by the owner on journey web today.
- **D4 (defect, also C5 if shared): every error reason collapses to the generic message.** `supabase.functions.invoke` returns `data: null` and a `FunctionsHttpError` for any non-2xx response, and the edge fn returns every failure as non-2xx (401/503/502). So `data?.reason` (:64) is always undefined on failure and the REASONS map (:47-51) is dead code: a signed-out user, an unconfigured server and an unreachable build server all see "Could not load the latest builds." (inference from supabase-js functions-js behaviour; not observed live).
- Version compare (:38-45): numeric per part, `1.0.9 < 1.0.10` correct; non-numeric parts (e.g. `1.0.18-beta`) become NaN -> treated as 0, so `1.0.18-beta` vs `1.0.18` compares equal. Badge only for TaskOS (`THIS_APP_KEY`), from `AndroidBridge.getCapabilities().version`.

## C5 -- huddle-extension-app Download tab: CONFIRMED, with defect D5

- d0ac835a is an ancestor of origin/main (`git merge-base --is-ancestor` -> true).
- `src/features/huddle/components/SettingsSheet.tsx:152 <TabsTrigger value="download">Download</TabsTrigger>`, `:164-165 <TabsContent value="download"> <AppDownloadsPanel />`, import :42.
- Token server-side: `lib/downloads/app-downloads.functions.ts:16` reads `process.env.JOURNEY_PROXY_TOKEN`, used only as outbound header (:22); results are `{ok:false, reason}` or `{ok:true, apps: shapeDownloads(...)}` -- the token is never returned. `AppDownloadsPanel.tsx:46` calls the server fn; it holds no token.
- Unlike journey (D4), Huddle's reasons DO reach the UI: the server fn returns `{ok:false, reason}` as a normal value, and `AppDownloadsPanel.tsx:48` maps `REASONS[res.reason]`.
- Tests (my run): `bun scripts/app-downloads.test.ts` -> 9 lines `PASS`, `all passed`. `npx tsc --noEmit -p .` -> rc 0.
- Deploy: the specific deploy-swa run for d0ac835 was not located within budget (the 4 newest main runs are later commits). Every one of those 4 (latest 43151578728 on 9aaf0c03, conclusion success) builds a main that contains d0ac835, and C6's live UAT shows the tab working, so the code is deployed. The claim "the run for d0ac835 succeeded" itself is UNVERIFIED.
- **D5 (defect, auth): the server fn's sign-in check is self-asserted.** `:15 if (!data.caller?.entra_email) return sign_in_required` trusts a client-supplied `caller.entra_email`; it does not call `verifyEntraIdToken` (`src/lib/entra-verify.server.ts:50`, which `identity/profile.functions.ts:7-8` does use). Anyone who can POST to the server fn with any email string receives fresh 30-day signed APK links. Journey's edge fn (C2) does verify the user. Exposure is APK download links, not the token.

## C6 -- Huddle browser UAT run 42817517451: CONFIRMED (8/8), check quality reviewed

`origin/uat-shots-run-42817517451:uat-shots/results.json` -- all 8 `pass:true`:
Settings button present; Settings has a 'Download' tab; Two signed Download links (Huddle + TaskOS) `links=2`; Huddle row shown with a version (panel text: `Download Latest Android builds. Each link is fresh for 30 days. Huddle v1.0.17 Built 11/8/2026 · 4.2 MB Download TaskOS v1.0.18 Built 11/5/2026 · 4.1 MB Download ...`); TaskOS row shown with a version; No error message; No console/page errors; No failed/4xx/5xx requests.
Versions match C3's bridge-builder output (Huddle 1.0.17, TaskOS 1.0.18).

Checks file (`origin/claude_download-tab-uat:.claude/skills/test-agent-serverfn/scripts/download-tab-checks.mjs`) vs component:
- Tab check uses `getByRole("tab", {name:"Download"})` and `count()===1` -- tests what it says.
- Link check: `a[href*=".blob.core.windows.net/bridge-apks/"][href*="sig="]`, strict `n === 2`, page-wide not panel-scoped; it does not tie a link to its app row and does not fetch the link (a revoked/expired SAS would still pass).
- **Could pass vacuously: "No error message"** (:25) tests a negative regex on `panel`, and `panel` falls back to `""` on any locator error (:21). An empty panel passes it. Not vacuous in THIS run, because the Huddle-version check on the same `panel` string passed with real text.
- "TaskOS row shown with a version" has no detail logged, but runs on the same non-empty panel.
- The error regex lists the panel's current messages; a new reason string would slip through.

## Extra defect search

- Version compare: see C4 (pre-release suffix compares equal). Huddle uses the same `compareVersions` (imported from `lib/downloads/app-downloads`; test `1.0.9 < 1.0.10` PASS).
- Token leakage: none found in responses (C2, C5) or workflow logs (C3: masked, jq drops links). bridge-builder 500 body echoes `err.message` (C1-c).
- Android WebView link handling: NOT REACHED. `BridgeWebViewClient.kt` was not found at the guessed path in android-bridge-template and budget ran out before locating it. Both UIs render a plain `<a href>` without `target`, and journey's copy tells the user "the download opens in your browser"; whether the WebView actually hands blob-host URLs to the system browser is unproven here.

## Verdict

CONFIRMED: C1, C2 (code+tests; live 401 not observed: egress 403), C3, C5 (deploy-run-for-d0ac835 sub-claim unverified, deployment itself evidenced by C6), C6. C4: code CONFIRMED; "not live on journey-voice.lovable.app" CONFIRMED by run 42958573043 -- the journey tab is NOT available to users.
REFUTED: none. NOT REACHED: Android WebView link behaviour.

Defects:
- D1 sync-bridge-builder-token smoke test never fails the job (no exit on 6x non-200, no assert on the 401).
- D4 journey AppDownloadsSettings: all error reasons collapse to "Could not load the latest builds." because `functions.invoke` gives `data:null` on non-2xx (inference from supabase-js behaviour).
- D5 Huddle getAppDownloadsFn trusts a client-supplied `caller.entra_email`; no token verification, so links are obtainable without signing in.
- Minor: D2 wrong-token not smoke-tested; D3 secret rotation needs manual dispatch; C1-a empty SAS -> handled downstream; typecheck probe build step masked by `| tail`; UAT "No error message" can pass on an empty panel.
