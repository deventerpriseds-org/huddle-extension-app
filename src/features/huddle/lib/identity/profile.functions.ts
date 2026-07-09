import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const AuthInput = z.object({ idToken: z.string().min(20) });

async function withClaims<T>(idToken: string, fn: (claims: { oid: string; email: string | null; name: string | null }) => Promise<T>) {
  const { verifyEntraIdToken } = await import("@/lib/entra-verify.server");
  const claims = await verifyEntraIdToken(idToken);
  return fn({ oid: claims.oid, email: claims.email, name: claims.name });
}

export const getMyProfile = createServerFn({ method: "POST" })
  .inputValidator((d) => AuthInput.parse(d))
  .handler(async ({ data }) => {
    const { getOrCreateProfile } = await import("@/features/huddle/lib/identity/identity.server");
    return withClaims(data.idToken, (c) => getOrCreateProfile(c));
  });

export const updateUsername = createServerFn({ method: "POST" })
  .inputValidator((d) => AuthInput.extend({ username: z.string().min(3).max(30) }).parse(d))
  .handler(async ({ data }) => {
    const { setUsername } = await import("@/features/huddle/lib/identity/identity.server");
    return withClaims(data.idToken, (c) => setUsername(c.oid, data.username));
  });

export const updateDisplayName = createServerFn({ method: "POST" })
  .inputValidator((d) => AuthInput.extend({ displayName: z.string().max(80).nullable() }).parse(d))
  .handler(async ({ data }) => {
    const { setDisplayName } = await import("@/features/huddle/lib/identity/identity.server");
    return withClaims(data.idToken, (c) => setDisplayName(c.oid, data.displayName));
  });

export const addProfileEmail = createServerFn({ method: "POST" })
  .inputValidator((d) => AuthInput.extend({ email: z.string().email() }).parse(d))
  .handler(async ({ data }) => {
    const { addEmail } = await import("@/features/huddle/lib/identity/identity.server");
    return withClaims(data.idToken, (c) => addEmail(c.oid, data.email));
  });

export const removeProfileEmail = createServerFn({ method: "POST" })
  .inputValidator((d) => AuthInput.extend({ emailId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { removeEmail } = await import("@/features/huddle/lib/identity/identity.server");
    return withClaims(data.idToken, (c) => removeEmail(c.oid, data.emailId));
  });
