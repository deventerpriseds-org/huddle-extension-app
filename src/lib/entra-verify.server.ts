// Verifies an Entra ID token via JWKS and returns the caller's stable object
// id + primary email. Works for both the workforce authority
// (login.microsoftonline.com/{tenant}/v2.0) and the CIAM/External ID authority
// ({tenant}.ciamlogin.com/{tenant}/v2.0) — the endpoints are derived from the
// same ENTRA_AUTHORITY the client signed in with, so the two never drift apart.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export class EntraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntraAuthError";
  }
}

/**
 * Resolve the token issuer + JWKS URI from the configured authority. If an
 * explicit authority is set (workforce or CIAM), derive both from it; otherwise
 * fall back to the CIAM convention built from the tenant id.
 */
function resolveEndpoints(): { issuer: string; jwksUri: string } {
  const tenantId = process.env.ENTRA_TENANT_ID || process.env.VITE_ENTRA_TENANT_ID;
  if (!tenantId) throw new EntraAuthError("ENTRA_TENANT_ID not configured on server");
  const authority = process.env.ENTRA_AUTHORITY || process.env.VITE_ENTRA_AUTHORITY;
  if (authority) {
    // e.g. https://login.microsoftonline.com/<tid>/v2.0  ->  base = .../<tid>
    const base = authority.replace(/\/+$/, "").replace(/\/v2\.0$/i, "");
    return { issuer: `${base}/v2.0`, jwksUri: `${base}/discovery/v2.0/keys` };
  }
  return {
    issuer: `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`,
    jwksUri: `https://${tenantId}.ciamlogin.com/${tenantId}/discovery/v2.0/keys`,
  };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (jwks) return jwks;
  jwks = createRemoteJWKSet(new URL(resolveEndpoints().jwksUri));
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
  if (!clientId) {
    throw new EntraAuthError("Entra client id not configured on server");
  }
  const { issuer } = resolveEndpoints();
  const { payload } = await jwtVerify(token, getJwks(), {
    audience: clientId,
    issuer,
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
