# VERIFY download-tab loop 1
# WHAT: independent verification of the "Download" settings tab claims C1-C6
# WHY: verifier loop 1 for work download-tab
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE: inline below

The artifact lives in the verifier's isolated huddle-extension-app worktree, on branch
claude_verify-download-tab, per the coordinator's corrected brief. Repo reads use the GitHub API at ref main
(`gh api .../contents/<path>?ref=main` and MCP get_file_contents), not local checkouts.

Started 2026-11-10.

## C1 bridge-builder getLatestApk: CONFIRMED (code + unit tests)

- main = 31edc9f ("getLatestApk: newest APK per app with a fresh link ... (#2)"). The commit touches
  api/package.json, api/src/functions/getLatestApk.ts (+43), api/src/index.ts (+1), api/src/lib/latestApk.ts (+67),
  and api/test/latestApk.test.ts (+43).
- api/src/index.ts last line is `import './functions/getLatestApk'`, so the function is registered.
- getLatestApk.ts behaviour:
  - Returns `503 {error:'not_configured'}` when `process.env.JOURNEY_PROXY_TOKEN` is unset.
  - Returns 401 when `tokenMatches(req.headers.get('x-journey-proxy-token'), expected)` is false.
  - Returns 400 when `parseAppIds` returns null.
  - Otherwise lists `bridge-apks` with prefix `<appId>/`, runs `pickLatestApk`, and adds
    `downloadUrl: generateSasUrl(blobPath)`.
- latestApk.ts:
  - `tokenMatches` uses sha256 of both strings plus `timingSafeEqual`, so the compare is constant-time
    and lengths always match. It returns false when either side is empty.
  - `parseAppIds` requires 1 to 5 uuids (the APP_ID regex), de-duplicates them, and lowercases them.
  - `parseApkVersion` uses the pattern `/-v(\d+(?:\.\d+)*)\.apk$/i`.
  - `pickLatestApk` picks by the greatest lastModified, considers only `.apk` files directly under
    `<appId>/` (subfolders are skipped), and returns version, builtAt and sizeBytes.
- SAS: blobStorage.ts `generateSasUrl` creates a read-only (`r`) SAS valid for 30 days, as
  `https://<account>.blob.core.windows.net/bridge-apks/<path>?<sas>`. On failure it returns `''`; see D1.
- Tests: `npm ci` was not run. The pure lib and test were fetched raw from main into the scratchpad and run
  with the package's own script command (`node --experimental-strip-types --test --test-reporter=tap
  "test/*.test.ts"`) on node v22.22.0: **tests 4, pass 4, fail 0**. The test file imports only node:test,
  node:assert and ../src/lib/latestApk.ts (which imports only `crypto`), so no npm dependencies were needed.
- Not tested: the HTTP handler itself (503/401/400 paths) has no unit test. Those statuses are confirmed
  by reading the code only, plus the claimed live 401/200 in C3.
- Edge notes (not defects):
  - "Newest" is decided by upload time, not by version number. Re-uploading an old build would make it
    "latest", which is how the claim describes it.
  - A file name without `-v<digits>` gives `version: null`.

## C6 Browser UAT of the Huddle Download tab: CONFIRMED (live run log)

- Run 42817517451 (verify-uat.yml, workflow_dispatch, head_branch claude_download-tab-uat, sha f6aa52d): status
  completed, conclusion success. Job 129834272116.
- Env in the log: APP_URL https://icy-flower-0f415200f.7.azurestaticapps.net, CHECKS_FILE
  .../download-tab-checks.mjs, viewport 1000x680.
- Log lines, verbatim:
  - `✅ Settings button present`
  - `✅ Settings has a 'Download' tab`
  - `✅ Two signed Download links (Huddle + TaskOS) — links=2`
  - `✅ Huddle row shown with a version — Download Latest Android builds. Each link is fresh for 30 days. Huddle v1.0.17 Built 11/8/2026 · 4.2 MB Download TaskOS v1.0.18 Built 11/5/2026 · 4.1 MB Download ...`
  - `✅ TaskOS row shown with a version`
  - `✅ No error message`
  - `✅ No console/page errors during the run`
  - `✅ No failed/4xx/5xx requests during the run`
  - `8/8 checks passed.`
- Shots were published to branch uat-shots-run-42817517451.
- Check-file quality is reviewed further below, if reached.
