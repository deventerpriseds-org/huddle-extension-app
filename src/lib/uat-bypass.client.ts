// WHAT:       Browser-side half of the UAT sign-in check: read `?uat_token=` once, strip it from the
//             URL, and ask the server whether it matches. Holds NO secret.
// WHY:        The previous in-browser compare needed the secret in the bundle (VITE_UAT_BYPASS_TOKEN).
//             Kept dependency-free so the "only call the server when the param is present" rule can be
//             tested offline (scripts/uat-check-server-side.test.ts).
// SUPERSEDES: the client-side compare in src/lib/entra-auth.ts (checkUatBypass before 2026-10-29).
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/FIX-uat-check-server-side.md

export const UAT_TOKEN_PARAM = "uat_token";

/** Cheap, synchronous: is there a non-empty `uat_token` in this query string? No network. */
export function hasUatTokenParam(search: string): boolean {
  try {
    return Boolean(new URLSearchParams(search).get(UAT_TOKEN_PARAM));
  } catch {
    return false;
  }
}

type UrlHost = {
  location: { search: string; pathname: string; hash: string };
  history: { replaceState: (data: unknown, unused: string, url?: string) => void };
};

/**
 * If (and only if) the URL carries `uat_token`, strip it from the address bar FIRST (so it never
 * lingers in history/referrers, whatever the server says), then ask `verify` once. Without the param,
 * `verify` is never called and this resolves false immediately. A network/server failure is `false`
 * (fall through to normal sign-in), never a thrown error.
 */
export async function resolveUatBypassFromUrl(
  host: UrlHost,
  verify: (token: string) => Promise<unknown>,
): Promise<boolean> {
  let supplied: string | null = null;
  try {
    const params = new URLSearchParams(host.location.search);
    supplied = params.get(UAT_TOKEN_PARAM);
    if (!supplied) return false;
    params.delete(UAT_TOKEN_PARAM);
    const qs = params.toString();
    host.history.replaceState(
      null,
      "",
      host.location.pathname + (qs ? `?${qs}` : "") + host.location.hash,
    );
  } catch {
    if (!supplied) return false;
  }
  try {
    return (await verify(supplied)) === true;
  } catch {
    return false;
  }
}
