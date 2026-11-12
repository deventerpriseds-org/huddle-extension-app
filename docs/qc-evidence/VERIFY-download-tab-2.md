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
| C4 | NOT REACHED |
| C5 | NOT REACHED |
| C6 | NOT REACHED |

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
