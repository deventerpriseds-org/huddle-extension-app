// WHAT:       Read when a sign-in (Entra ID) token expires, without verifying it -- so the app can refresh it
//             BEFORE sending it to the server instead of after the server rejects it.
// WHY:        MSAL's silent flow decides "cache is still good" from the ACCESS token's expiry only and then
//             hands back the cached ID token as-is (@azure/msal-common SilentFlowClient.mjs: expiry checked on
//             cachedAccessToken, then `idToken: cacheManager.getIdToken(...)`). Entra access tokens live 60-90
//             min, ID tokens about 60, so for up to ~30 min getToken() returned an EXPIRED ID token and every
//             server call that verifies it failed. Owner 2026-11-08: history "stuck loading", fixed by signing
//             out and back in; earlier the same day it "started working again 20 minutes later".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/id-token-expiry.test.ts; .claude/actions.md ACT:signin-refresh.

/** Seconds-since-epoch `exp` claim of a JWT, or null when it can't be read. Never verifies anything. */
export function jwtExpiryMs(token: string | null | undefined): number | null {
  if (!token || typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const json =
      typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Refresh this far ahead of expiry, so a token never expires between being read and being checked. */
export const ID_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** True when the token is expired, about to expire, or unreadable (unreadable = refresh, the safe side). */
export function idTokenNeedsRefresh(
  token: string | null | undefined,
  nowMs: number,
  marginMs = ID_TOKEN_REFRESH_MARGIN_MS,
): boolean {
  const exp = jwtExpiryMs(token);
  return exp === null || exp - marginMs <= nowMs;
}
