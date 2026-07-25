import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { ArtifactRow } from "./artifacts.server";

// Client-callable server functions for the artifact workspace. Every call resolves the signed-in
// user's canonical email (the same resolution the task board uses) and scopes reads/writes to it, so
// one user can never list, open, or review another's artifacts. Server-only modules (pg, blob) are
// imported dynamically so they never bundle into the client.

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();
const STATUS = z.enum(["review", "approved", "changes", "draft"]);

async function callerEmail(caller: { entra_object_id?: string; entra_email?: string } | undefined): Promise<string | null> {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller.entra_email;
}

export const listArtifactsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        folder: z.string().optional(),
        status: STATUS.optional(),
        agentId: z.string().optional(),
        taskId: z.string().optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ artifacts: ArtifactRow[]; folders: { folder: string; n: number }[] }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { artifacts: [], folders: [] };
    try {
      const { listArtifacts, listArtifactFolders } = await import("./artifacts.server");
      const [artifacts, folders] = await Promise.all([
        listArtifacts(email, { folder: data.folder, status: data.status, agentId: data.agentId, taskId: data.taskId }),
        listArtifactFolders(email),
      ]);
      return { artifacts, folders };
    } catch {
      return { artifacts: [], folders: [] };
    }
  });

export const getArtifactFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, id: z.string().min(1) }).parse(raw))
  .handler(async ({ data }): Promise<{ artifact: (ArtifactRow & { url: string | null }) | null }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { artifact: null };
    try {
      const { getArtifact } = await import("./artifacts.server");
      const artifact = await getArtifact(email, data.id); // scoped by email → wrong owner = null (no SAS leak)
      return { artifact };
    } catch {
      return { artifact: null };
    }
  });

export const reviewArtifactFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        id: z.string().min(1),
        action: z.enum(["approve", "changes", "reopen"]),
        note: z.string().max(2000).optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; artifact?: ArtifactRow; error?: string; mirror?: { ok: boolean; error?: string; needsConsent?: boolean; onedrive_url?: string | null } }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    if (data.action === "changes" && !data.note?.trim()) {
      return { ok: false, error: "Add a note describing the changes you want." };
    }
    const status = data.action === "approve" ? "approved" : data.action === "changes" ? "changes" : "review";
    try {
      const { setArtifactStatus, getMirrorConfig, mirrorArtifactToOneDrive } = await import("./artifacts.server");
      const artifact = await setArtifactStatus(email, data.id, status, data.note ?? null, email);
      if (!artifact) return { ok: false, error: "Not found." }; // wrong owner or missing → no change
      // On approve: mirror to enabled+built destinations if configured. NEVER fail the approve on a
      // mirror error — the approve already succeeded; the mirror result is reported separately.
      let mirror: { ok: boolean; error?: string; needsConsent?: boolean; onedrive_url?: string | null } | undefined;
      if (status === "approved") {
        try {
          const cfg = await getMirrorConfig(email);
          if (cfg.mirror_on_approve && cfg.onedrive_enabled) {
            const r = await mirrorArtifactToOneDrive(email, data.id);
            mirror = r;
            if (r.ok) artifact.onedrive_url = r.onedrive_url ?? artifact.onedrive_url;
          }
        } catch (e) {
          mirror = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return { ok: true, artifact, mirror };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

// Mirror config: read + write (whole object). Email-scoped.
export const getMirrorConfigFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }) => {
    const email = await callerEmail(data.caller);
    const defaults = { mirror_on_approve: true, onedrive_enabled: true, gdrive_enabled: true };
    if (!email) return { config: defaults };
    try {
      const { getMirrorConfig } = await import("./artifacts.server");
      return { config: await getMirrorConfig(email) };
    } catch {
      return { config: defaults };
    }
  });

export const setMirrorConfigFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        mirror_on_approve: z.boolean(),
        onedrive_enabled: z.boolean(),
        gdrive_enabled: z.boolean(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    try {
      const { setMirrorConfig } = await import("./artifacts.server");
      await setMirrorConfig(email, {
        mirror_on_approve: data.mirror_on_approve,
        onedrive_enabled: data.onedrive_enabled,
        gdrive_enabled: data.gdrive_enabled,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

// Manual "Mirror now" — pushes an artifact to a destination on demand, at any status, respecting the
// per-destination toggle. Phase 2: OneDrive is live; Google Drive is deferred (returns a Phase-3 note).
export const mirrorArtifactFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, id: z.string().min(1), destination: z.enum(["onedrive", "gdrive"]).default("onedrive") }).parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; onedrive_url?: string | null; error?: string; needsConsent?: boolean; deferred?: boolean }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    try {
      const { getMirrorConfig, mirrorArtifactToOneDrive } = await import("./artifacts.server");
      const cfg = await getMirrorConfig(email);
      if (data.destination === "gdrive") {
        if (!cfg.gdrive_enabled) return { ok: false, error: "Google Drive mirroring is turned off." };
        return { ok: false, deferred: true, error: "Google Drive mirroring ships in Phase 3." };
      }
      if (!cfg.onedrive_enabled) return { ok: false, error: "OneDrive mirroring is turned off." };
      return await mirrorArtifactToOneDrive(email, data.id);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

// Delete an artifact (row + blob), scoped to the caller. Idempotent: deleting a missing/other-owner id
// is a no-op that returns deleted:0 rather than an error.
export const deleteArtifactFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, id: z.string().min(1) }).parse(raw))
  .handler(async ({ data }): Promise<{ ok: boolean; deleted: number; error?: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false, deleted: 0, error: "Sign-in required." };
    try {
      const { deleteArtifact } = await import("./artifacts.server");
      const { deleted } = await deleteArtifact(email, data.id);
      return { ok: true, deleted };
    } catch (err) {
      return { ok: false, deleted: 0, error: err instanceof Error ? err.message : String(err) };
    }
  });

// Create an artifact from text content (markdown/plain/csv/json). Agents write binary artifacts by
// calling createArtifact server-side directly; this fn is the client/manual + test-seed path, scoped
// to the caller. Bytes are the UTF-8 encoding of `text`.
export const createArtifactFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        folder: z.string().min(1).max(80),
        name: z.string().min(1).max(200),
        mime: z.string().min(1).max(120),
        text: z.string().max(500_000),
        agentId: z.string().optional(),
        taskId: z.string().optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; id?: string; deepLink?: string; error?: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    try {
      const { createArtifact } = await import("./artifacts.server");
      const { id, deepLink } = await createArtifact({
        userEmail: email,
        agentId: data.agentId ?? null,
        taskId: data.taskId ?? null,
        folder: data.folder,
        name: data.name,
        mime: data.mime,
        bytes: Buffer.from(data.text, "utf8"),
      });
      return { ok: true, id, deepLink };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
