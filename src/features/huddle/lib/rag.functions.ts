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

/**
 * Largest input accepted in ONE request (ACT-61). This is a LATENCY bound, not a storage one: each
 * chunk costs an embedding round-trip, and this app has a ~45s hosting ceiling (see CLAUDE.md), so a
 * single request must stay comfortably under it. 20k chars ≈ 11 chunks ≈ a few seconds at
 * EMBED_CONCURRENCY. Larger documents are handled by the CLIENT pre-segmenting with the same
 * `chunkText` and calling this repeatedly with progress — never by raising this blindly.
 */
export const MAX_CHARS_PER_REQUEST = 20_000;
/** Parallel embed+write fan-out. Keeps a multi-chunk save a few seconds rather than N × latency. */
const EMBED_CONCURRENCY = 6;
/**
 * Triple extraction is an LLM call PER CHUNK, so a document import would otherwise fire a dozen of
 * them and blow the ceiling. Cap it: the leading chunks carry the summary/most factual content in
 * practice. The response reports how many were actually processed so the UI never overstates it.
 */
const MAX_FACT_CHUNKS = 3;

/** Run `fn` over `items` with bounded parallelism, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const saveMemoryItem = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        text: z.string().min(1).max(MAX_CHARS_PER_REQUEST),
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
    const { chunkText } = await import("./rag/chunk");

    // Anything over one chunk used to be rejected outright by the 4k validator. Now it is split on
    // paragraph/sentence boundaries and stored as several retrievable chunks.
    const texts = chunkText(data.text);
    if (texts.length === 0) return { chunkId: "", chunkIds: [], chunkCount: 0, tripleCount: 0, factChunks: 0 };

    const chunkIds = await mapWithConcurrency(texts, EMBED_CONCURRENCY, async (text) => {
      const chunk = await azurePgStore.writeChunk({
        scope: data.scope,
        agentId: data.agentId,
        text,
        source: data.source ?? "manual",
      });
      return chunk.id;
    });

    let tripleCount = 0;
    let factChunks = 0;
    if (data.extractFacts) {
      const factTargets = texts.slice(0, MAX_FACT_CHUNKS);
      factChunks = factTargets.length;
      const perChunk = await mapWithConcurrency(factTargets, EMBED_CONCURRENCY, async (text, i) => {
        const triples = await extractTriples(text);
        if (triples.length === 0) return 0;
        const res = await azurePgStore.writeTriples(
          triples.map((t) => ({
            scope: data.scope,
            agentId: data.agentId,
            subject: t.subject,
            predicate: t.predicate,
            object: t.object,
            confidence: t.confidence,
            sourceChunkId: chunkIds[i],
          })),
        );
        return res.ids.length;
      });
      tripleCount = perChunk.reduce((a, b) => a + b, 0);
    }

    // `chunkId` kept for backward compatibility with the single-item caller contract.
    return { chunkId: chunkIds[0], chunkIds, chunkCount: chunkIds.length, tripleCount, factChunks };
  });

export const listMemoryItems = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        agentId: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(raw),
  )
  .handler(async ({ data }) => {
    const { listChunksForAgent } = await import("./rag/azure-pg.server");
    return listChunksForAgent({ agentId: data.agentId, limit: data.limit });
  });

export const deleteMemoryItem = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ id: z.string().uuid() }).parse(raw))
  .handler(async ({ data }) => {
    const { deleteChunkById } = await import("./rag/azure-pg.server");
    return deleteChunkById(data.id);
  });
