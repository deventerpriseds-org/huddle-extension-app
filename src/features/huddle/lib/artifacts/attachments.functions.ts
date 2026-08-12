import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Client-callable upload for CHAT attachments (ACT-45). The composer uploads a screenshot / invite /
// appointment / doc here BEFORE sending the turn; the turn payload then carries only the returned id
// (not the bytes), so the durable turn row stays small. Storage reuses the artifact blob store (folder
// "Uploads", status "approved" so it never enters the review queue), scoped to the addressed agent, so
// an upload shows up in that agent's Files tab (ACT-43 already scopes Files to the channel's agents).
// The server later resolves the id → a fresh read SAS (images → OpenAI vision) or decoded text.

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

// ~8 MB of raw bytes; base64 inflates ~4/3, so cap the encoded string a bit above that.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_B64 = Math.ceil((MAX_BYTES * 4) / 3) + 256;

// What an agent can actually make use of today: images (vision), and common text/office/pdf documents
// (text is inlined; office/pdf are acknowledged with a follow-on parse path). Everything else is refused
// up front rather than stored and silently ignored.
const ALLOWED_MIME =
  /^(image\/(png|jpe?g|gif|webp|heic|heif)|text\/|application\/(pdf|json|csv|rtf|vnd\.openxmlformats-officedocument\.[a-z.]+|msword|vnd\.ms-excel|vnd\.ms-powerpoint)|text\/calendar)/i;

async function callerEmail(
  caller: { entra_object_id?: string; entra_email?: string } | undefined,
): Promise<string | null> {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller.entra_email;
}

export const uploadChatAttachmentFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        // The agent this attachment is being shared WITH (1:1 → that agent), so it lands in their Files.
        agentId: z.string().optional(),
        name: z.string().min(1).max(200),
        mime: z.string().min(1).max(150),
        // base64 (no data: prefix) of the file bytes.
        dataBase64: z.string().min(1).max(MAX_B64),
      })
      .parse(raw),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: boolean; id?: string; name?: string; mime?: string; size?: number; error?: string }> => {
      const email = await callerEmail(data.caller);
      if (!email) return { ok: false, error: "Not signed in" };
      if (!ALLOWED_MIME.test(data.mime)) return { ok: false, error: `Unsupported file type (${data.mime})` };
      let bytes: Buffer;
      try {
        bytes = Buffer.from(data.dataBase64, "base64");
      } catch {
        return { ok: false, error: "Couldn't decode the file" };
      }
      if (bytes.length === 0) return { ok: false, error: "Empty file" };
      if (bytes.length > MAX_BYTES) return { ok: false, error: "File is larger than 8 MB" };
      try {
        const { createArtifact } = await import("./artifacts.server");
        const { id } = await createArtifact({
          userEmail: email,
          agentId: data.agentId ?? null,
          taskId: null,
          folder: "Uploads",
          name: data.name,
          mime: data.mime,
          bytes,
          status: "approved", // an input, not a deliverable to review
        });
        return { ok: true, id, name: data.name, mime: data.mime, size: bytes.length };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Upload failed" };
      }
    },
  );
