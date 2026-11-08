// WHAT:       tests for the sign-in refresh (src/lib/id-token-expiry.ts) + source pins on its wiring in
//             entra-auth.ts getToken and useWorkspaceSync.
// WHY:        MSAL returned an EXPIRED ID token for up to ~30 min (it only checks the access token's expiry), so
//             history loads failed until the owner signed out and back in (2026-11-08).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run with `npm run test:id-token-expiry`.
import { readFileSync } from "node:fs";
import { idTokenNeedsRefresh, jwtExpiryMs } from "../src/lib/id-token-expiry";
import { isSignInFailure } from "../src/features/huddle/lib/identity/workspace-window";

let fail = 0;
const check = (n: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}`);
  if (!ok) fail++;
};
const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (payload: object) => `${b64u({ alg: "RS256" })}.${b64u(payload)}.sig`;
const NOW = Date.parse("2026-11-08T16:00:00Z");
const exp = (msFromNow: number) => jwt({ exp: Math.floor((NOW + msFromNow) / 1000), name: "Ünïcode ~~>>" });

check("T1 reads exp from a real-shaped JWT (base64url, unicode claim)", jwtExpiryMs(exp(3_600_000)) === Math.floor((NOW + 3_600_000) / 1000) * 1000);
check("T2 expired token needs refresh", idTokenNeedsRefresh(exp(-60_000), NOW));
check("T3 token expiring inside the 5-min margin needs refresh", idTokenNeedsRefresh(exp(4 * 60_000), NOW));
check("T4 token with an hour left does NOT", !idTokenNeedsRefresh(exp(3_600_000), NOW));
check("T5 unreadable token -> refresh (the safe side)", idTokenNeedsRefresh("not.a.jwt", NOW) && idTokenNeedsRefresh(null, NOW) && idTokenNeedsRefresh(jwt({}), NOW));

const jose = (code: string, message: string) => Object.assign(new Error(message), { code });
check("T6 expired/rejected sign-in counts as a sign-in failure", isSignInFailure(jose("ERR_JWT_EXPIRED", '"exp" claim timestamp check failed')) && isSignInFailure(jose("ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "signature verification failed")));
check("T7 a server/network error does NOT (it waits and retries as before)", !isSignInFailure(new Error("connection terminated")) && !isSignInFailure(new TypeError("Failed to fetch")));

const auth = readFileSync("src/lib/entra-auth.ts", "utf8");
const getTok = auth.slice(auth.indexOf("export async function getToken("), auth.indexOf("} catch (e) {", auth.indexOf("export async function getToken(")));
check("W1 getToken refreshes a stale ID token before returning it", /if \(!opts\.forceRefresh && idTokenNeedsRefresh\(result\.idToken, Date\.now\(\)\)\) \{/.test(getTok) && /forceRefresh: true,/.test(getTok));
const sync = readFileSync("src/features/huddle/hooks/useWorkspaceSync.ts", "utf8");
check("W2 history load asks for a fresh token after a sign-in rejection", /forceRefreshNext = signInFailed;/.test(sync) && /getToken\(\{ forceRefresh: forceRefreshNext \}\)/.test(sync));
check("W3 history save retries once with a fresh token on a sign-in rejection", /if \(!isSignInFailure\(e\)\) throw e;\s*\n\s*await save\(true\);/.test(sync));
check("W4 a final sign-in failure offers 'Sign in again'", /label: "Sign in again", onClick: \(\) => void signIn\(\)/.test(sync));
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
