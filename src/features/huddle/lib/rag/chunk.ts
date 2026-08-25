// Text chunking for memory intake (ACT-61).
//
// Why this exists: `saveMemoryItem` used to reject anything over 4,000 characters, so a memory
// export from another AI assistant, or a long web article, could not be saved at all. Retrieval
// also works better on focused chunks than on one huge blob — `searchChunks` returns whole chunks,
// so a 50k-character single row would flood the prompt and score poorly against a specific query.
//
// Pure and dependency-free ON PURPOSE: the server chunks what it is given, and the client uses the
// SAME function to pre-segment a large file into per-request batches (see MAX_CHARS_PER_REQUEST in
// rag.functions.ts). One implementation, identical boundaries on both sides.

export interface ChunkOptions {
  /** Target maximum characters per chunk. Chunks land at or under this except for hard-split runs. */
  maxChars?: number;
  /** Characters of trailing context copied from the previous chunk, so a fact split across a
   *  boundary is still retrievable from at least one side. */
  overlap?: number;
}

/** ~1800 chars ≈ 450 tokens — small enough to score sharply in retrieval, large enough to hold a
 *  complete thought. Matches the granularity of the auto-written per-turn chunks already in the store. */
export const DEFAULT_CHUNK_CHARS = 1800;
export const DEFAULT_OVERLAP_CHARS = 150;

/** Split on sentence enders followed by whitespace. Keeps the punctuation with the sentence. */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter((p) => p.length > 0);
}

/** Last resort for a run with no paragraph or sentence boundary (minified JSON, a long URL list). */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

/**
 * Split `text` into retrieval-sized chunks, preferring paragraph boundaries, then sentence
 * boundaries, then a hard split. Returns [] for blank input.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_CHUNK_CHARS);
  const overlap = Math.max(0, Math.min(opts.overlap ?? DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 2)));

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  // Paragraphs first — a blank line is the strongest semantic boundary in notes/exports/markdown.
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  // Break any single oversized paragraph down before packing, so `units` are all <= maxChars.
  const units: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      units.push(para);
      continue;
    }
    for (const sentence of splitSentences(para)) {
      if (sentence.length <= maxChars) units.push(sentence);
      else units.push(...hardSplit(sentence, maxChars));
    }
  }

  // Pack units into chunks up to maxChars.
  const packed: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
    } else if (current.length + 2 + unit.length <= maxChars) {
      current += "\n\n" + unit;
    } else {
      packed.push(current);
      current = unit;
    }
  }
  if (current) packed.push(current);

  if (overlap === 0 || packed.length < 2) return packed;

  // Prepend the tail of the previous chunk to each subsequent chunk. Applied AFTER packing so the
  // overlap never pushes a chunk over maxChars during packing decisions.
  return packed.map((chunk, i) => {
    if (i === 0) return chunk;
    const prev = packed[i - 1];
    const tail = prev.slice(-overlap).trimStart();
    return tail ? `${tail}\n\n${chunk}` : chunk;
  });
}
