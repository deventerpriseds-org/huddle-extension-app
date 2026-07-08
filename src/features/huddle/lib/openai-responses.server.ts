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

export interface ToolHandler {
  (call: { name: string; arguments: Record<string, unknown> }): Promise<string>;
}

export interface OpenAIPersonaInput {
  assistantId: string;
  /** When set, overrides the assistant's stored prompt (useStoredPrompt === false). */
  instructions?: string;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  fastMode?: boolean;
  /** OpenAI Responses tools (function/file_search). */
  tools?: unknown[];
  /** Called when the model emits function_call items. */
  onToolCall?: ToolHandler;
  /** Max tool-call round-trips (default 2). */
  maxToolHops?: number;
}

interface ResponsesReply {
  output_text?: string;
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ text?: string; type?: string }>;
  }>;
}

function extractText(json: ResponsesReply): string {
  if (json.output_text) return json.output_text;
  const parts = (json.output ?? []).flatMap((o) => o.content ?? []);
  return parts.find((c) => c?.type === "output_text" || c?.text)?.text ?? "";
}

function extractToolCalls(json: ResponsesReply): Array<{
  call_id: string;
  name: string;
  arguments: string;
}> {
  return (json.output ?? [])
    .filter((o) => o.type === "function_call" && o.call_id && o.name)
    .map((o) => ({
      call_id: o.call_id!,
      name: o.name!,
      arguments: o.arguments ?? "{}",
    }));
}

export async function callOpenAIResponses(input: OpenAIPersonaInput): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");

  const maxHops = input.maxToolHops ?? 2;

  // Build the running input array. Each tool round appends function_call_output items.
  const runningInput: unknown[] = [...input.transcript];

  let previousResponseId: string | undefined;

  for (let hop = 0; hop <= maxHops; hop++) {
    // OpenAI Responses API accepts `prompt: { id }` only for stored prompts
    // (`pmpt_...`). Legacy Assistants IDs (`asst_...`) are a different resource
    // and are rejected. Fall back to a plain model + instructions call in that
    // case so agents configured with assistant IDs still work.
    const isStoredPrompt = input.assistantId.startsWith("pmpt_");
    const body: Record<string, unknown> = {
      ...(isStoredPrompt
        ? { prompt: { id: input.assistantId } }
        : { model: "gpt-5.5" }),
      input: runningInput,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.fastMode ? { service_tier: "priority" } : {}),
      ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
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

    const json = (await res.json()) as ResponsesReply & { id?: string };
    previousResponseId = json.id;

    const toolCalls = extractToolCalls(json);
    if (toolCalls.length === 0 || !input.onToolCall || hop === maxHops) {
      return extractText(json).trim();
    }

    // Execute tools; append function_call_output for each to the next input.
    // With previous_response_id, we only need to send the new outputs.
    const nextInput: unknown[] = [];
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      let output: string;
      try {
        output = await input.onToolCall({ name: tc.name, arguments: args });
      } catch (err) {
        output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      nextInput.push({
        type: "function_call_output",
        call_id: tc.call_id,
        output,
      });
    }
    // Replace running input for the next hop (previous_response_id carries prior state).
    runningInput.length = 0;
    runningInput.push(...nextInput);
  }

  return "";
}
