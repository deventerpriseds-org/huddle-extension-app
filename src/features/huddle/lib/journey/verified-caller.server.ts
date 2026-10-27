// WHAT:       resolves the journey caller identity for a Huddle server fn from a VERIFIED Entra ID token,
//             never from the request body; plus the two server-fn bodies that now depend on it.
// WHY:        journey-voice VERIFY-phone-registration-a-1 C2-BYPASS1 (2026-10-27): `invokeJourneyToolDebug`
//             and `registerBridgeFcmToken` took `caller.entra_email` from the POST body with no auth. The
//             huddle-proxy maps that email to a journey user and calls execute-tool with the service-role
//             key, so anyone could run `register_push_token` (or any tool) as any user and point that
//             user's alarms at their own phone. Same pattern as profile/workspace server fns:
//             `verifyEntraIdToken(data.idToken)` (src/lib/entra-verify.server.ts).
// SUPERSEDES: the body-supplied `caller` in both server fns (now ignored).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   journey-voice docs/qc-evidence/RESTORE-step3-j13-j14-security.md ("Loop 2 fixes", fix 2);
//             scripts/journey-verified-caller.test.ts.
import type { JourneyCallerIdentity, JourneyToolInvocationRequest, JourneyToolInvocationResponse } from "./types";

export type VerifyIdToken = (idToken: string) => Promise<{ oid: string; email: string | null }>;

async function defaultVerify(idToken: string) {
  const { verifyEntraIdToken } = await import("@/lib/entra-verify.server");
  return verifyEntraIdToken(idToken);
}

/**
 * The caller identity proven by `idToken`, or null when there is no token, it fails verification, or it
 * carries no email (the proxy resolves the journey user by email). Never reads a body-supplied caller.
 */
export async function verifiedJourneyCaller(
  idToken: unknown,
  verify: VerifyIdToken = defaultVerify,
): Promise<JourneyCallerIdentity | null> {
  if (typeof idToken !== "string" || idToken.trim().length < 20) return null;
  try {
    const c = await verify(idToken);
    if (!c?.oid || !c.email) return null;
    return { entra_object_id: c.oid, entra_email: c.email };
  } catch {
    return null;
  }
}

type Invoke = (req: JourneyToolInvocationRequest) => Promise<JourneyToolInvocationResponse>;

/** Body of `invokeJourneyToolDebug`: runs a tool ONLY as the verified caller. */
export async function invokeJourneyToolDebugImpl(
  data: { idToken?: string; toolName: string; args: Record<string, unknown>; agentId?: string; huddleId?: string },
  deps: { invoke: Invoke; verify?: VerifyIdToken },
): Promise<JourneyToolInvocationResponse> {
  const caller = await verifiedJourneyCaller(data.idToken, deps.verify);
  if (!caller) return { ok: false, output: "", error: "unauthorized: sign in (verified Entra ID token required)" };
  return deps.invoke({
    toolName: data.toolName,
    args: data.args as JourneyToolInvocationRequest["args"],
    caller,
    context: { source: "huddle", huddleId: data.huddleId, agentId: data.agentId },
  });
}

/** Body of `registerBridgeFcmToken`: registers the Huddle app's device ONLY for the verified caller. */
export async function registerBridgeFcmTokenImpl(
  data: { idToken?: string; token: string },
  deps: { invoke: Invoke; verify?: VerifyIdToken },
): Promise<{ ok: boolean; error?: string }> {
  const caller = await verifiedJourneyCaller(data.idToken, deps.verify);
  if (!caller) return { ok: false, error: "unauthorized" };
  try {
    const r = await deps.invoke({
      toolName: "register_push_token",
      // `app:"huddle"` namespaces the endpoint as `fcm:app:huddle:<token>` so journey can target this
      // app's device exclusively (and exclude it from journey-native pushes).
      args: { fcm_token: data.token, app: "huddle" },
      caller,
      context: { source: "huddle" },
    });
    return { ok: !!r.ok, error: r.ok ? undefined : String(r.error ?? "register_failed") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
