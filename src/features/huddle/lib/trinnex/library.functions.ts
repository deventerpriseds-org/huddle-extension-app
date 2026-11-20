// WHAT:       client-callable server functions for the Trinnex Library view: list, upload, process (kick), retry,
//             set speakers, remove, and the read-only Fireflies "waiting for triage" count.
// WHY:        AC-trinnex-workspace.md section 2. Every call resolves the caller's canonical email exactly as the
//             artifact store does (resolveTaskEmail) and scopes reads and writes to it (AC-C7). Server-only modules
//             are imported dynamically so they never bundle into the client.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-library.md.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { LibraryItem, RemovalResult } from "./library.server";
import { MAX_UPLOAD_BYTES, extOf, isAcceptedName } from "./library-core";

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();

async function callerEmail(caller: { entra_object_id?: string; entra_email?: string } | undefined): Promise<string | null> {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller.entra_email;
}

export interface LibraryListing {
  items: LibraryItem[];
  categories: string[];
  /** The ONE owner-scoped people list (chat.trinnex_people, owner first) -- the same list Meetings reads. */
  people: string[];
  /** The owner's display name (pinned first in every picker). */
  owner?: string | null;
  firefliesWaiting: number | null;
  memoryReady: boolean;
  error?: string;
}

export const listTrinnexLibraryFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<LibraryListing> => {
    const empty: LibraryListing = { items: [], categories: [], people: [], firefliesWaiting: null, memoryReady: false };
    const email = await callerEmail(data.caller);
    if (!email) return empty;
    try {
      const lib = await import("./library.server");
      const { trinnexConfigured } = await import("./memory.server");
      const { getPeople } = await import("./meetings.server");
      const [{ items, categories }, ff, ppl] = await Promise.all([
        lib.listLibrary(email),
        // The Meetings module's owner set (every linked address), not just the signed-in one -- see firefliesWaiting.
        import("../proposals/proposals.server")
          .then(({ callerOwners }) => callerOwners(data.caller))
          .then((owners) => lib.firefliesWaiting(owners?.length ? owners : [email]))
          .catch(() => null),
        getPeople(data.caller).catch(() => null),
      ]);
      const people = ppl && ppl.ok ? ppl.people : [];
      const owner = ppl && ppl.ok ? ppl.owner : null;
      return { items, categories, people, owner, firefliesWaiting: ff, memoryReady: trinnexConfigured() };
    } catch {
      return { ...empty, error: "load_failed" };
    }
  });

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  vtt: "text/vtt",
  srt: "application/x-subrip",
};

export const uploadTrinnexFileFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        name: z.string().min(1).max(255),
        kind: z.enum(["document", "transcript"]),
        category: z.string().max(200),
        participants: z.array(z.string().max(80)).max(40),
        speakerMap: z.record(z.string().max(120), z.string().max(80)),
        docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        base64: z.string().min(1),
        replace: z.boolean().optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ item?: LibraryItem; duplicateOf?: LibraryItem; error?: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { error: "not_signed_in" };
    if (!isAcceptedName(data.name)) return { error: "unsupported_type" };
    const bytes = new Uint8Array(Buffer.from(data.base64, "base64"));
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return { error: "too_large" };
    if (bytes.byteLength === 0) return { error: "no_readable_text" };
    try {
      const lib = await import("./library.server");
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const dup = await lib.findDuplicate(email, hash);
      if (dup && !data.replace) return { duplicateOf: dup }; // AC-L10: ask "replace?" instead of doubling passages
      if (dup && data.replace) {
        // Loop-2 2b: never re-remove a row that is already being removed (a worker may hold it). The second Replace
        // used to call removeLibraryItem again and delete the row under the running worker.
        if (dup.status === "removing") return { error: "already_being_removed" };
        const r = await lib.removeLibraryItem(email, dup.id);
        if (r && !r.removed) return { error: "replace_incomplete" };
      }
      const ext = extOf(data.name);
      const item = await lib.createUpload(email, {
        name: data.name,
        fileType: ext,
        kind: data.kind,
        category: data.category,
        participants: data.participants,
        speakerMap: data.speakerMap,
        docDate: data.docDate,
        bytes,
        mime: MIME[ext] ?? "application/octet-stream",
        hash,
      });
      // One people list: names tagged here join chat.trinnex_people (what Meetings reads and writes).
      await (await import("./meetings.server")).rememberPeople(data.caller, [...data.participants, ...Object.values(data.speakerMap)]);
      return { item };
    } catch {
      return { error: "storage_error" };
    }
  });

/** Kick processing right after upload. Bounded by the item's own size; the heartbeat picks up anything left. */
export const processTrinnexFileFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, id: z.string().uuid() }).parse(raw))
  .handler(async ({ data }): Promise<{ status: string | null }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { status: null };
    try {
      const { processLibraryItem } = await import("./library.server");
      return { status: await processLibraryItem(email, data.id) };
    } catch {
      return { status: null };
    }
  });

export const retryTrinnexFileFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, id: z.string().uuid() }).parse(raw))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false };
    try {
      const { requeue } = await import("./library.server");
      return { ok: await requeue(email, data.id) };
    } catch {
      return { ok: false };
    }
  });

export const setTrinnexSpeakersFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        id: z.string().uuid(),
        speakerMap: z.record(z.string().max(120), z.string().max(80)),
        participants: z.array(z.string().max(80)).max(40),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false };
    try {
      const { setSpeakerMap } = await import("./library.server");
      const ok = await setSpeakerMap(email, data.id, data.speakerMap, data.participants);
      if (ok) await (await import("./meetings.server")).rememberPeople(data.caller, [...data.participants, ...Object.values(data.speakerMap)]);
      return { ok };
    } catch {
      return { ok: false };
    }
  });

export const removeTrinnexFileFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, id: z.string().uuid() }).parse(raw))
  .handler(async ({ data }): Promise<RemovalResult | { removed: false; remaining: []; error: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { removed: false, remaining: [], error: "not_signed_in" };
    try {
      const { removeLibraryItem } = await import("./library.server");
      return (await removeLibraryItem(email, data.id)) ?? { removed: false, remaining: [], error: "not_found" };
    } catch {
      return { removed: false, remaining: [], error: "remove_failed" };
    }
  });
