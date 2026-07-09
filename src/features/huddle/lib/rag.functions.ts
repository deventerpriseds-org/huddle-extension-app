import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const pingRagStore = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ store: z.enum(["azure"]) }).parse(raw))
  .handler(async () => {
    const { azurePgStore } = await import("./rag/azure-pg.server");
    return azurePgStore.ping();
  });

/**
 * Deep diagnostic: DNS → TCP → Postgres handshake → schema/row counts.
 * Never throws. Returns the raw ground truth for every layer so the UI can
 * show exactly what Azure is saying.
 */
export const diagnoseRagStore = createServerFn({ method: "POST" })
  .handler(async () => {
    const { diagnoseAzurePg } = await import("./rag/azure-pg.server");
    return diagnoseAzurePg();
  });

/**
 * Explicit schema bootstrap. Runs the CREATE EXTENSION / CREATE TABLE SQL
 * and returns the raw result. Idempotent.
 */
export const runRagBootstrap = createServerFn({ method: "POST" })
  .handler(async () => {
    const { runBootstrap } = await import("./rag/azure-pg.server");
    return runBootstrap();
  });

/**
 * True end-to-end round-trip: write → semantic search → direct read → delete.
 * Every step reports its raw outcome. Proves the store is actually usable.
 */
export const verifyRagRoundTrip = createServerFn({ method: "POST" })
  .handler(async () => {
    const { verifyRoundTrip } = await import("./rag/azure-pg.server");
    return verifyRoundTrip();
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
    const { azurePgStore } = await import("./rag/azure-pg.server");
    const { extractTriples } = await import("./rag/triples.server");
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
