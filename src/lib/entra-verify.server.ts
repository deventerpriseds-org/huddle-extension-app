// Verifies an Entra External ID (CIAM) ID token via JWKS and returns the
// caller's stable object id + primary email.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export class EntraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntraAuthError";
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (jwks) return jwks;
  const tenantId = process.env.ENTRA_TENANT_ID || process.env.VITE_ENTRA_TENANT_ID;
  if (!tenantId) throw new EntraAuthError("ENTRA_TENANT_ID not configured on server");
  const url = new URL(
    `https://${tenantId}.ciamlogin.com/${tenantId}/discovery/v2.0/keys`,
  );
  jwks = createRemoteJWKSet(url);
  return jwks;
}

export interface EntraClaims {
  oid: string;
  email: string | null;
  name: string | null;
  raw: JWTPayload;
}

export async function verifyEntraIdToken(token: string): Promise<EntraClaims> {
  const clientId = process.env.ENTRA_CLIENT_ID || process.env.VITE_ENTRA_CLIENT_ID;
  const tenantId = process.env.ENTRA_TENANT_ID || process.env.VITE_ENTRA_TENANT_ID;
  if (!clientId || !tenantId) {
    throw new EntraAuthError("Entra client/tenant not configured on server");
  }
  const { payload } = await jwtVerify(token, getJwks(), {
    audience: clientId,
    issuer: `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`,
  });
  const oid =
    (payload.oid as string | undefined) ||
    (payload.sub as string | undefined) ||
    null;
  if (!oid) throw new EntraAuthError("ID token missing oid/sub");
  const email =
    (payload.email as string | undefined) ||
    (payload.preferred_username as string | undefined) ||
    null;
  const name = (payload.name as string | undefined) || null;
  return { oid, email: email ?? null, name, raw: payload };
}
