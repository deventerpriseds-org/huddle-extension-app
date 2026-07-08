// Triple extraction. Cheap regex heuristic decides when to call the LLM;
// gpt-5.5 with a strict JSON schema returns up to 5 (subject, predicate, object) triples.

const HEURISTIC = /\b(prefer|prefers|allergic|owns?|manages?|reports? to|deadline|due|hate|hates|love|loves|avoid|avoids|never eat|always|dislike|dislikes|assigned to|responsible for)\b/i;

export function shouldExtractTriples(text: string): boolean {
  if (text.length < 8) return false;
  return HEURISTIC.test(text);
}

interface Triple {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    triples: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string" },
          predicate: { type: "string" },
          object: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["subject", "predicate", "object", "confidence"],
      },
    },
  },
  required: ["triples"],
} as const;

const SYSTEM =
  "Extract structured facts from the user's message as (subject, predicate, object) triples. " +
  "Only include durable facts about people, preferences, ownership, allergies, roles, or commitments. " +
  "Skip ephemeral chit-chat. Normalize subjects (e.g. 'the user' → 'user'). " +
  "Confidence 0–1. Return at most 5 triples. Empty array if no durable facts.";

export async function extractTriples(text: string): Promise<Triple[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];

  const body = {
    model: "gpt-5.5",
    input: [
      { role: "system", content: SYSTEM },
      { role: "user", content: text },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "triples_out",
        schema: SCHEMA,
        strict: true,
      },
    },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Non-fatal — just skip extraction on failure.
    return [];
  }

  const json = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };
  const raw =
    json.output_text ??
    json.output?.flatMap((o) => o.content ?? []).find((c) => c?.type === "output_text" || c?.text)?.text ??
    "";
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as { triples: Triple[] };
    return Array.isArray(parsed.triples) ? parsed.triples.slice(0, 5) : [];
  } catch {
    return [];
  }
}
