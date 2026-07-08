// OpenAI direct embeddings — 3072-dim text-embedding-3-large.
// Same vectors go into every store (Azure now, Lovable Cloud later).

const EMBED_URL = "https://api.openai.com/v1/embeddings";
export const EMBED_MODEL = "text-embedding-3-large";
export const EMBED_DIM = 3072;

export async function embed(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured (required for embeddings)");

  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${res.status}: ${err.slice(0, 300)}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  const vec = json.data?.[0]?.embedding;
  if (!vec || vec.length !== EMBED_DIM) {
    throw new Error(`Unexpected embedding shape (len=${vec?.length ?? 0})`);
  }
  return vec;
}

/** Format a vector for pgvector literal input (e.g. "[0.1,0.2,...]"). */
export function toPgVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
