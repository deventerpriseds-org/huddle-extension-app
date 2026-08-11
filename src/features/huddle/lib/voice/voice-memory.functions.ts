import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Write a 1:1 VOICE-call turn into shared RAG memory (rag_chunks, scope='global') — the SAME store the
// text turn writes to (huddle.functions.ts). The voice path previously only READ memory and never wrote
// it, so anything said or produced on a call (e.g. a budget breakdown) was invisible to later text/voice
// turns → "I don't have that in this chat" (ACT-huddle-37). Mirrors the text path's global write:
// embed(text) → azurePgStore.writeChunk({scope:'global', ...}). Fire-and-forget from the client; every
// failure returns {ok:false} instead of throwing so it can never stall or break a live call.
//
// Pollution guard: the caller only sends genuine user/agent utterances with non-trivial text; we also
// hard-skip empty/whitespace and ultra-short (<3 char) fragments here so silence-echo or "ok" noise
// doesn't accrete into memory.

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

export const rememberVoiceTurn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        agentId: z.string().min(1),
        role: z.enum(["user", "agent"]),
        text: z.string(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const text = (data.text ?? "").trim();
    if (text.length < 3) return { ok: false };
    if (!data.caller?.entra_email) return { ok: false };
    try {
      const { azurePgStore } = await import("../rag/azure-pg.server");
      const { embed } = await import("../rag/embed.server");
      const vec = await embed(text);
      // Prefix so a reader/agent can tell this fact came from a spoken call, and attribute authorship to
      // the agent on the call (1:1 has exactly one). scope 'global' = findable from any huddle, same as text.
      const tagged = data.role === "user" ? text : `${data.agentId} (on a voice call): ${text}`;
      await azurePgStore.writeChunk({
        scope: "global",
        text: tagged,
        source: `voice:dm-${data.agentId}`,
        embedding: vec,
        authorAgentIds: [data.agentId],
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
