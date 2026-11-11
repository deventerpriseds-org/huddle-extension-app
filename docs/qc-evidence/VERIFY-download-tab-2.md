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
| C2 | NOT REACHED |
| C3 | NOT REACHED |
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
