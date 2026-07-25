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
  .handler(async ({ data }): Promise<{ ok: boolean; artifact?: ArtifactRow; error?: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    if (data.action === "changes" && !data.note?.trim()) {
      return { ok: false, error: "Add a note describing the changes you want." };
    }
    const status = data.action === "approve" ? "approved" : data.action === "changes" ? "changes" : "review";
    try {
      const { setArtifactStatus } = await import("./artifacts.server");
      const artifact = await setArtifactStatus(email, data.id, status, data.note ?? null, email);
      if (!artifact) return { ok: false, error: "Not found." }; // wrong owner or missing → no change
      return { ok: true, artifact };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
