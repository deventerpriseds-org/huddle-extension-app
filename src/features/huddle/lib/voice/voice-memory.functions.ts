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
  .handler(async ({ data }): Promise<{ ok: boolean; conversation: boolean; rag: boolean }> => {
    const text = (data.text ?? "").trim();
    const result = { ok: false, conversation: false, rag: false };
    if (text.length < 3) return result;
    if (!data.caller?.entra_email) return result;

    // Resolve the caller's canonical email EXACTLY as the text turn does (resolveTaskEmail ?? entra_email)
    // — the Conversations object is keyed by (email, huddleId, agentId), so a mismatch would write to a
    // DIFFERENT conv than the text turn reads and the memory wouldn't carry.
    let email: string | null = null;
    try {
      const { resolveTaskEmail } = await import("../journey/identity");
      email = (await resolveTaskEmail(data.caller ?? {})) ?? data.caller?.entra_email ?? null;
    } catch {
      email = data.caller?.entra_email ?? null;
    }

    // PRIMARY (1:1-native): fold the turn into the SAME OpenAI Conversations object the 1:1 TEXT turn
    // uses, so the next typed message in dm-<agent> natively "remembers" what was said on the call.
    try {
      const { getOrCreateConversationId, appendConversationItems } = await import(
        "../rag/conversation-store.server"
      );
      const convId = await getOrCreateConversationId({
        userEmail: email,
        huddleId: `dm-${data.agentId}`,
        agentId: data.agentId,
        seed: [],
      });
      if (convId) {
        result.conversation = await appendConversationItems(convId, [
          { role: data.role === "agent" ? "assistant" : "user", content: text },
        ]);
      }
    } catch {
      /* best-effort */
    }

    // SECONDARY (cross-huddle): also write to shared RAG memory so auto-retrieval can surface voice
    // content from OTHER huddles/agents (the conversation object is per 1:1 only).
    try {
      const { azurePgStore } = await import("../rag/azure-pg.server");
      const { embed } = await import("../rag/embed.server");
      const vec = await embed(text);
      const tagged = data.role === "user" ? text : `${data.agentId} (on a voice call): ${text}`;
      await azurePgStore.writeChunk({
        scope: "global",
        text: tagged,
        source: `voice:dm-${data.agentId}`,
        embedding: vec,
        authorAgentIds: [data.agentId],
      });
      result.rag = true;
    } catch {
      /* best-effort */
    }

    result.ok = result.conversation || result.rag;
    return result;
  });
