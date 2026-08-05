// Per-user workspace state persisted to Azure Postgres as a single JSONB blob.
// Keyed by Entra oid (identity.profiles.entra_object_id).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const WORKSPACE_VERSION = 3;

const AuthInput = z.object({ idToken: z.string().min(20) });

// Return `state` as a JSON string so the server-fn RPC layer doesn't need to
// validate the arbitrary blob shape as serializable — the client parses it.
export type LoadedWorkspace =
  | { stateJson: string; version: number; updatedAt: string }
  | null;

async function loadImpl(oid: string): Promise<LoadedWorkspace> {
  const { getPool, ensureWorkspaceBootstrapped } = await import(
    "@/features/huddle/lib/identity/workspace.server"
  );
  await ensureWorkspaceBootstrapped();
  const res = await getPool().query<{ state: unknown; version: number; updated_at: string }>(
    `SELECT state, version, updated_at FROM identity.workspace_state WHERE entra_object_id = $1`,
    [oid],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    stateJson: JSON.stringify(row.state ?? {}),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

async function saveImpl(oid: string, state: unknown, version: number) {
  const { getPool, ensureWorkspaceBootstrapped } = await import(
    "@/features/huddle/lib/identity/workspace.server"
  );
  await ensureWorkspaceBootstrapped();
  const res = await getPool().query<{ updated_at: string }>(
    `INSERT INTO identity.workspace_state (entra_object_id, state, version)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (entra_object_id) DO UPDATE
       SET state = EXCLUDED.state,
           version = EXCLUDED.version,
           updated_at = now()
     RETURNING updated_at`,
    [oid, JSON.stringify(state ?? {}), version],
  );
  return { updatedAt: res.rows[0].updated_at };
}

export const loadWorkspace = createServerFn({ method: "POST" })
  .inputValidator((d) => AuthInput.parse(d))
  .handler(async ({ data }) => {
    const { verifyEntraIdToken } = await import("@/lib/entra-verify.server");
    const { getOrCreateProfile, canonicalOid } = await import(
      "@/features/huddle/lib/identity/identity.server"
    );
    const claims = await verifyEntraIdToken(data.idToken);
    const oid = await canonicalOid(claims.oid, claims.email);
    // Ensure the profile row exists so FK is satisfied on subsequent save.
    await getOrCreateProfile({ oid, email: claims.email, name: claims.name });
    return loadImpl(oid);
  });

export const saveWorkspace = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    AuthInput.extend({
      stateJson: z.string().min(2).max(2_000_000),
      version: z.number().int().min(1).max(9999).optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { verifyEntraIdToken } = await import("@/lib/entra-verify.server");
    const { canonicalOid } = await import("@/features/huddle/lib/identity/identity.server");
    const claims = await verifyEntraIdToken(data.idToken);
    const oid = await canonicalOid(claims.oid, claims.email);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.stateJson);
    } catch {
      throw new Error("Invalid workspace state payload");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Workspace state must be an object");
    }
    return saveImpl(oid, parsed, data.version ?? WORKSPACE_VERSION);
  });

export const CURRENT_WORKSPACE_VERSION = WORKSPACE_VERSION;
