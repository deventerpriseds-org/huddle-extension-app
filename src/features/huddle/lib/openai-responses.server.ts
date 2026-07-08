// Direct OpenAI Responses API helpers. Used when:
//   1. Router backend === "openai"           → callOpenAIRouter (structured JSON)
//   2. Agent backend === "openai"            → callOpenAIResponses (persona reply)
//
// All calls hit https://api.openai.com/v1/responses. Reads OPENAI_API_KEY at
// call time (never at module scope — .functions.ts modules ship stubs to the
// client bundle).

const OPENAI_URL = "https://api.openai.com/v1/responses";

export interface OpenAIRouterInput {
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  schemaName: string;
  fastMode?: boolean;
}

export async function callOpenAIRouter<T>(input: OpenAIRouterInput): Promise<T> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");

  const body = {
    model: input.model,
    input: [
      { role: "system", content: input.system },
      { role: "user", content: input.prompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: input.schemaName,
        schema: input.schema,
        strict: true,
      },
    },
    ...(input.fastMode ? { service_tier: "priority" } : {}),
  };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI Responses ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };

  const text =
    json.output_text ??
    json.output?.flatMap((o) => o.content ?? []).find((c) => c?.type === "output_text" || c?.text)?.text ??
    "";

  if (!text) throw new Error("OpenAI Responses returned empty output");
  return JSON.parse(text) as T;
}

export interface OpenAIPersonaInput {
  assistantId: string;
  /** When set, overrides the assistant's stored prompt (useStoredPrompt === false). */
  instructions?: string;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  fastMode?: boolean;
}

export async function callOpenAIResponses(input: OpenAIPersonaInput): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");

  const body: Record<string, unknown> = {
    prompt: { id: input.assistantId },
    input: input.transcript,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.fastMode ? { service_tier: "priority" } : {}),
  };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI Responses ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };

  const text =
    json.output_text ??
    json.output?.flatMap((o) => o.content ?? []).find((c) => c?.type === "output_text" || c?.text)?.text ??
    "";

  return (text ?? "").trim();
}
