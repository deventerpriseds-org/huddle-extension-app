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

/** extractTriples's result WITH the failure kind (AC-C5, Trinnex). `failureKind` is the HTTP status plus the
 *  provider's error CODE (e.g. "429 insufficient_quota"), never message text; null on success or "no facts". */
export interface ExtractResult {
  triples: Triple[];
  failureKind: string | null;
}

/** Unchanged contract for every existing caller: any failure is an empty list. */
export async function extractTriples(text: string): Promise<Triple[]> {
  return (await extractTriplesDetailed(text)).triples;
}

export async function extractTriplesDetailed(text: string): Promise<ExtractResult> {
  const none = (failureKind: string | null = null): ExtractResult => ({ triples: [], failureKind });
  const key = process.env.OPENAI_API_KEY;
  // AC-C5 (verifier loop 1): a missing key is a KIND, not "no facts". extractTriples (every existing caller)
  // still gets [].
  if (!key) return none("no_api_key");

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

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    });
  } catch (e) {
    return none(/timeout|abort/i.test(String((e as Error)?.name ?? "")) ? "timeout" : "network_error");
  }

  if (!res.ok) {
    // Non-fatal for the caller -- but the KIND is returned: status + provider code only, never the message.
    let code = "";
    try {
      const j = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
      const c = j?.error?.code ?? j?.error?.type;
      if (typeof c === "string" && /^[a-z0-9_]{1,64}$/i.test(c)) code = c;
    } catch {
      /* no body: the status alone is the kind */
    }
    return none(code ? `${res.status} ${code}` : String(res.status));
  }

  const json = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };
  const raw =
    json.output_text ??
    json.output?.flatMap((o) => o.content ?? []).find((c) => c?.type === "output_text" || c?.text)?.text ??
    "";
  if (!raw) return none();

  try {
    const parsed = JSON.parse(raw) as { triples: Triple[] };
    return { triples: Array.isArray(parsed.triples) ? parsed.triples.slice(0, 5) : [], failureKind: null };
  } catch {
    return none("bad_output");
  }
}
