import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { azurePgStore } from "./rag/azure-pg.server";
import { extractTriples } from "./rag/triples.server";

export const pingRagStore = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ store: z.enum(["azure"]) }).parse(raw))
  .handler(async () => {
    return azurePgStore.ping();
  });

export const saveMemoryItem = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        text: z.string().min(1).max(4000),
        agentId: z.string().optional(),
        scope: z.enum(["agent", "global"]).default("agent"),
        source: z.string().optional(),
        extractFacts: z.boolean().default(true),
      })
      .parse(raw),
  )
  .handler(async ({ data }) => {
    const chunk = await azurePgStore.writeChunk({
      scope: data.scope,
      agentId: data.agentId,
      text: data.text,
      source: data.source ?? "manual",
    });
    let tripleCount = 0;
    if (data.extractFacts) {
      const triples = await extractTriples(data.text);
      if (triples.length > 0) {
        const res = await azurePgStore.writeTriples(
          triples.map((t) => ({
            scope: data.scope,
            agentId: data.agentId,
            subject: t.subject,
            predicate: t.predicate,
            object: t.object,
            confidence: t.confidence,
            sourceChunkId: chunk.id,
          })),
        );
        tripleCount = res.ids.length;
      }
    }
    return { chunkId: chunk.id, tripleCount };
  });
