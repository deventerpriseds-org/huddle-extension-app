// WHAT:       Server function the browser calls ONCE, and only when `?uat_token=` is in the URL, to ask
//             "is this the UAT token?" -- the answer is a bare boolean, never the token or a hint.
// WHY:        Replaces the in-browser compare against a VITE_-prefixed copy of the token, which shipped the org
//             secret in the public bundle. See docs/FIX-uat-check-server-side.md.
// SUPERSEDES: the client-side compare in src/lib/entra-auth.ts (checkUatBypass before 2026-10-29).
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/FIX-uat-check-server-side.md
import { createServerFn } from "@tanstack/react-start";

export const verifyUatToken = createServerFn({ method: "POST" })
  // Deliberately lenient: a malformed body is just "not the token" (false), never a thrown
  // validation error whose message could echo the input back.
  .inputValidator((d: unknown) => {
    const token = (d as { token?: unknown } | null)?.token;
    return { token: typeof token === "string" ? token : "" };
  })
  .handler(async ({ data }): Promise<boolean> => {
    const { checkUatTokenServer } = await import("@/lib/uat-bypass.server");
    return checkUatTokenServer(data.token) === true;
  });
