// Direct OpenAI Responses API helpers.
//
// OpenAI has deprecated Assistants (`asst_...`) and reusable stored prompts
// (`pmpt_...`); `v1/prompts` shuts down 2026-11-30. The current, forward-
// compatible shape is a plain Responses call with `model` + `instructions` +
// `input` + inline `tools`. That's what we do here.
//
// Reads OPENAI_API_KEY at call time (never at module scope — this file is
// imported dynamically inside a server-function handler).

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
    json.output?.flatMap((o) => o.content ?? []).find((c) => c?.type === "output_text" || c?.text)
      ?.text ??
    "";

  if (!text) throw new Error("OpenAI Responses returned empty output");
  return JSON.parse(text) as T;
}

export interface ToolHandler {
  (call: { name: string; arguments: Record<string, unknown> }): Promise<string>;
}

export interface OpenAIPersonaInput {
  /** Model id to run (e.g. "gpt-4o", "gpt-4o-mini"). */
  model: string;
  /** Full system prompt for this turn (persona + scene + RAG hint). */
  instructions: string;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  fastMode?: boolean;
  /** OpenAI Responses tools (function/file_search). Not code_interpreter. */
  tools?: unknown[];
  /** Called when the model emits function_call items. */
  onToolCall?: ToolHandler;
  /** Max tool-call round-trips (default 2). */
  maxToolHops?: number;
  /** Optional tool_choice override (e.g. "auto", "required", or { type: "function", name }). */
  toolChoice?: unknown;
  /** Stable key (per agent) that routes requests to the same cached prompt prefix — improves
   *  OpenAI automatic prompt-cache hit rate for the large stable instruction/tool prefix. */
  promptCacheKey?: string;
  /** memoryMode "conversation" (1:1 only): an OpenAI Conversations object id (`conv_...`). When set,
   *  continuity is carried by that server-side thread — the caller sends ONLY the new user message as
   *  `transcript`, not the full reconstructed window — and `previous_response_id` is not used (the
   *  conversation manages state across turns AND across this turn's tool hops). */
  conversation?: string;
  /** Difficulty-driven reasoning effort for reasoning-capable models (5.6/gpt-5/o-series). Escalating
   *  effort on the cheap model is the proven cost-effective lever (Luna+high ≈ Terra+med at ~1/9 cost).
   *  Ignored by non-reasoning models. */
  reasoningEffort?: "low" | "medium" | "high" | "max";
  /** 1:1 reply streaming: when true, each hop's request uses the Responses streaming API and `onDelta`
   *  is called with the cumulative answer text as tokens arrive, so the caller can persist the growing
   *  reply (durable row + client poll). Server→OpenAI streaming is unaffected by SWA response buffering
   *  (that only buffers the SWA→client HTTP body). Falls back to a normal call on any stream error. */
  stream?: boolean;
  /** Called with the cumulative output text as it streams (only when `stream` is true). */
  onDelta?: (textSoFar: string) => void;
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
    /** Present on reasoning items when reasoning.summary is enabled. */
    summary?: Array<{ text?: string; type?: string }>;
  }>;
}

function extractText(json: ResponsesReply): string {
  if (json.output_text) return json.output_text;
  const parts = (json.output ?? []).flatMap((o) => o.content ?? []);
  return parts.find((c) => c?.type === "output_text" || c?.text)?.text ?? "";
}

/** Reasoning summary text, when the model exposes one (reasoning models only). */
function extractReasoning(json: ResponsesReply): string[] {
  return (json.output ?? [])
    .filter((o) => o.type === "reasoning")
    .flatMap((o) => (o.summary ?? []).map((s) => (s.text ?? "").trim()).filter(Boolean));
}

/** Reasoning models accept `reasoning: { summary }`; classic chat models reject it. */
function isReasoningModel(model: string): boolean {
  const m = model.replace(/^openai\//, "");
  return /^o\d/.test(m) || m.startsWith("gpt-5");
}

/**
 * Read a Responses streaming (SSE) body: fire `onText` with the cumulative answer text as
 * `response.output_text.delta` events arrive, and return the terminal `response` object from
 * `response.completed` (same shape the non-streaming call returns, so the existing extractors work).
 * Server→OpenAI only — unrelated to SWA's client-response buffering. Throws on a stream error or if the
 * stream ends without a completed response, so the caller can fall back to a normal call.
 */
async function readResponsesStream(
  res: Response,
  onText: (fullSoFar: string) => void,
): Promise<ResponsesReply & { id?: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("responses stream: no body reader");
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let finalResponse: (ResponsesReply & { id?: string }) | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt: { type?: string; delta?: string; response?: ResponsesReply & { id?: string } };
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
        full += evt.delta;
        onText(full);
      } else if (evt.type === "response.completed" && evt.response) {
        finalResponse = evt.response;
      } else if (evt.type === "response.failed" || evt.type === "error") {
        throw new Error(`responses stream ${evt.type}`);
      }
    }
  }
  if (!finalResponse) throw new Error("responses stream ended without response.completed");
  return finalResponse;
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

// Only some OpenAI models honor the priority service tier. Gate to avoid
// silent no-ops and per-model billing surprises.
const PRIORITY_MODELS = new Set([
  "gpt-4o",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
]);

export interface OpenAIPersonaResult {
  text: string;
  /** Reasoning summary lines, when the model exposes them (reasoning models). */
  reasoning: string[];
}

export async function callOpenAIResponses(input: OpenAIPersonaInput): Promise<OpenAIPersonaResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");

  const maxHops = input.maxToolHops ?? 2;
  const priority = input.fastMode && PRIORITY_MODELS.has(input.model);
  const wantReasoning = isReasoningModel(input.model);
  const reasoning: string[] = [];

  // Running input array. Each tool round appends function_call_output items.
  const runningInput: unknown[] = [...input.transcript];
  let previousResponseId: string | undefined;

  for (let hop = 0; hop <= maxHops; hop++) {
    // On the FINAL hop, withhold tools so the model MUST answer with text. This prevents a tool call
    // we'd never get to answer (we'd bail right after) — which, in conversation-object mode, would be
    // stored in the thread as a dangling function_call and 400 every subsequent turn ("No tool output
    // found for function call …"). Forcing text on the last hop closes the loop cleanly.
    const isFinalHop = hop === maxHops;
    const hasTools = !isFinalHop && !!(input.tools && input.tools.length > 0);
    const body: Record<string, unknown> = {
      model: input.model,
      instructions: input.instructions,
      input: runningInput,
      ...(priority ? { service_tier: "priority" } : {}),
      ...(wantReasoning
        ? { reasoning: { ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}), summary: "auto" } }
        : {}),
      ...(hasTools ? { tools: input.tools } : {}),
      ...(input.promptCacheKey ? { prompt_cache_key: input.promptCacheKey } : {}),
      // Only force tool_choice on the FIRST hop; subsequent hops let the model
      // produce a normal text answer using the tool output.
      ...(hasTools && input.toolChoice && hop === 0 ? { tool_choice: input.toolChoice } : {}),
      // Conversation-object mode owns cross-turn AND cross-hop state, so it replaces
      // previous_response_id (mixing the two requires the id to be inside the conversation). When no
      // conversation is set, thread the tool-hop loop with previous_response_id as before.
      ...(input.conversation
        ? { conversation: input.conversation }
        : previousResponseId
          ? { previous_response_id: previousResponseId }
          : {}),
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(input.stream ? { ...body, stream: true } : body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenAI Responses ${res.status}: ${errText.slice(0, 300)}`);
    }

    let json: ResponsesReply & { id?: string };
    if (input.stream) {
      try {
        json = await readResponsesStream(res, (full) => input.onDelta?.(full));
      } catch {
        // Streaming parse failed mid-flight — retry this hop non-streamed so the reply is never lost.
        // (A partial already persisted by the caller is harmlessly replaced by the final text.)
        const res2 = await fetch(OPENAI_URL, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res2.ok) {
          const t = await res2.text().catch(() => "");
          throw new Error(`OpenAI Responses ${res2.status}: ${t.slice(0, 300)}`);
        }
        json = (await res2.json()) as ResponsesReply & { id?: string };
      }
    } else {
      json = (await res.json()) as ResponsesReply & { id?: string };
    }
    previousResponseId = json.id;
    if (wantReasoning) reasoning.push(...extractReasoning(json));

    const toolCalls = extractToolCalls(json);
    if (toolCalls.length === 0 || !input.onToolCall || hop === maxHops) {
      return { text: extractText(json).trim(), reasoning };
    }

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
    runningInput.length = 0;
    runningInput.push(...nextInput);
  }

  return { text: "", reasoning };
}
