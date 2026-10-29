// WHAT:       Server-only check of a supplied `?uat_token=` against the UAT_BYPASS_TOKEN app setting.
// WHY:        The compare used to run in the browser against a VITE_-prefixed copy, which Vite inlined
//             into the PUBLIC bundle -- and Nexus accepts that same org secret as a write identity.
//             Moving the compare here keeps the secret on the server only.
// SUPERSEDES: the client-side compare in src/lib/entra-auth.ts (checkUatBypass before 2026-10-29).
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/FIX-uat-check-server-side.md
import { createHash, timingSafeEqual } from "node:crypto";

export const UAT_TOKEN_ENV = "UAT_BYPASS_TOKEN";
/** Upper bound on what the server will even hash; a real token is far shorter. */
export const UAT_TOKEN_MAX_LEN = 512;

/**
 * Constant-time compare of `supplied` against `expected`. Both sides are hashed to a fixed-length
 * SHA-256 digest first, so neither the timing nor an early length check reveals how long the real
 * token is or how many leading characters matched. Returns ONLY a boolean.
 * An absent/empty expected value can never match (the bypass is inert when the setting is unset).
 */
export function matchUatToken(supplied: unknown, expected: string | undefined | null): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  if (supplied.length > UAT_TOKEN_MAX_LEN) return false;
  const a = createHash("sha256").update(supplied, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Reads the token from the server runtime's environment (SWA app setting) at call time. */
export function checkUatTokenServer(
  supplied: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return matchUatToken(supplied, env[UAT_TOKEN_ENV]);
}
