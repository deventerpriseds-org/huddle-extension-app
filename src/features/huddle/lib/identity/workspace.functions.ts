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

async function loadImpl(oid: string, recentDays?: number): Promise<LoadedWorkspace> {
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
  let state = (row.state ?? {}) as Record<string, unknown>;
  // Paged history (workspace-window.ts): only a client that ASKS for the recent window gets one. An older
  // cached client never asks, so it still receives -- and saves back -- the full history.
  if (recentDays && Array.isArray(state.messages)) {
    const { windowMessages } = await import("./workspace-window");
    const w = windowMessages(state.messages as never[], Date.now(), recentDays);
    state = { ...state, messages: w.messages, olderMessageCount: w.olderCount };
  }
  return {
    stateJson: JSON.stringify(state),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

async function saveImpl(oid: string, state: unknown, version: number, mergeMessages = false) {
  const { getPool, ensureWorkspaceBootstrapped } = await import(
    "@/features/huddle/lib/identity/workspace.server"
  );
  await ensureWorkspaceBootstrapped();
  if (mergeMessages) return saveMergedImpl(oid, state as Record<string, unknown>, version);
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

/**
 * Save from a client that may hold only PART of the history (paged load): union the client's messages into
 * the stored ones by id (workspace-window.ts mergeMessages) inside one transaction, so a paged client can
 * never drop the messages it has not loaded. Everything else in the blob is the client's, as before.
 */
async function saveMergedImpl(oid: string, state: Record<string, unknown>, version: number) {
  const { getPool } = await import("@/features/huddle/lib/identity/workspace.server");
  const { mergeMessages } = await import("./workspace-window");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ messages: unknown }>(
      `SELECT state->'messages' AS messages FROM identity.workspace_state WHERE entra_object_id = $1 FOR UPDATE`,
      [oid],
    );
    const stored = Array.isArray(cur.rows[0]?.messages) ? (cur.rows[0].messages as never[]) : [];
    const incoming = Array.isArray(state.messages) ? (state.messages as never[]) : [];
    const { olderMessageCount: _drop, ...rest } = state;
    const merged = { ...rest, messages: mergeMessages(stored, incoming) };
    const res = await client.query<{ updated_at: string }>(
      `INSERT INTO identity.workspace_state (entra_object_id, state, version)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (entra_object_id) DO UPDATE
         SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()
       RETURNING updated_at`,
      [oid, JSON.stringify(merged), version],
    );
    await client.query("COMMIT");
    return { updatedAt: res.rows[0].updated_at };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const loadWorkspace = createServerFn({ method: "POST" })
  .inputValidator((d) => AuthInput.extend({ recentDays: z.number().int().min(1).max(3650).optional() }).parse(d))
  .handler(async ({ data }) => {
    const { verifyEntraIdToken } = await import("@/lib/entra-verify.server");
    const { getOrCreateProfile, canonicalOid } = await import(
      "@/features/huddle/lib/identity/identity.server"
    );
    const claims = await verifyEntraIdToken(data.idToken);
    const oid = await canonicalOid(claims.oid, claims.email);
    // Ensure the profile row exists so FK is satisfied on subsequent save.
    await getOrCreateProfile({ oid, email: claims.email, name: claims.name });
    return loadImpl(oid, data.recentDays);
  });

export const saveWorkspace = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    AuthInput.extend({
      // Was 2_000_000. The owner's workspace reached ~2.0M chars on 2026-10-18 and every save after that
      // was rejected here — silently, for 10 days. Headroom until messages move out of this blob.
      stateJson: z.string().min(2).max(8_000_000),
      version: z.number().int().min(1).max(9999).optional(),
      // Set by a client that loaded a PAGED history: merge its messages into the stored ones instead of
      // replacing them. Absent (older cached clients): full replace, exactly as before.
      mergeMessages: z.boolean().optional(),
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
    return saveImpl(oid, parsed, data.version ?? WORKSPACE_VERSION, data.mergeMessages === true);
  });

/** One page of a huddle's history older than `beforeTs` (scroll-up paging), oldest first. */
export const loadOlderMessages = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    AuthInput.extend({
      huddleId: z.string().min(1).max(200),
      beforeTs: z.number(),
      limit: z.number().int().min(1).max(200).optional(),
    }).parse(d),
  )
  .handler(async ({ data }): Promise<{ messagesJson: string; hasMore: boolean }> => {
    const { verifyEntraIdToken } = await import("@/lib/entra-verify.server");
    const { canonicalOid } = await import("@/features/huddle/lib/identity/identity.server");
    const claims = await verifyEntraIdToken(data.idToken);
    const oid = await canonicalOid(claims.oid, claims.email);
    const { getPool, ensureWorkspaceBootstrapped } = await import(
      "@/features/huddle/lib/identity/workspace.server"
    );
    await ensureWorkspaceBootstrapped();
    const limit = data.limit ?? 60;
    // Filtered in SQL so only the page crosses the wire (the full blob stays in the database).
    // The CASE guards the cast: Postgres does not promise to evaluate WHERE terms in order, so a bare
    // regex-then-cast could still cast a malformed ts and fail the whole page.
    const res = await getPool().query<{ m: unknown }>(
      `SELECT m FROM (
         SELECT e AS m,
                CASE WHEN (e->>'ts') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (e->>'ts')::numeric END AS t
           FROM identity.workspace_state w, jsonb_array_elements(w.state->'messages') e
          WHERE w.entra_object_id = $1 AND e->>'huddleId' = $2
       ) x
       WHERE t < $3
       ORDER BY t DESC
       LIMIT $4`,
      [oid, data.huddleId, data.beforeTs, limit + 1],
    );
    const rows = res.rows.map((r) => r.m);
    const hasMore = rows.length > limit;
    return { messagesJson: JSON.stringify(rows.slice(0, limit).reverse()), hasMore };
  });

export const CURRENT_WORKSPACE_VERSION = WORKSPACE_VERSION;
