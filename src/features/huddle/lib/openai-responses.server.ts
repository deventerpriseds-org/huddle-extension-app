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
  // Content is normally a plain string. When the user attached an image, the CURRENT user message's
  // content is instead the Responses content-parts array form — [{type:"input_text",text},
  // {type:"input_image",image_url}] — so the model can SEE it (ACT-45). Passed straight through as
  // `input`; the Responses API accepts either shape.
  transcript: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: "input_text" | "input_image"; text?: string; image_url?: string }>;
  }>;
  fastMode?: boolean;
  /** OpenAI Responses FUNCTION-style tools (`type:"function"` / `file_search`) — the ones this app
   *  executes itself and answers via `onToolCall`. Built-in tools that OpenAI executes server-side go
   *  in `builtInTools` instead; they are a different mechanism, not a different entry in this array.
   *  (This comment used to read "Not code_interpreter." That stopped being true when the built-in
   *  tools were offered — see `builtInTools` directly below.) */
  tools?: unknown[];
  /** Built-in tools OpenAI RUNS ITSELF inside the same response — `code_interpreter`,
   *  `image_generation` (see openai-builtin-tools.ts). Kept separate from `tools` for two concrete
   *  reasons: they never produce a `function_call` for `onToolCall` to answer, and when a model or
   *  account rejects them the 400 retry below has to be able to drop EXACTLY these and keep the
   *  function tools. Merged into the request's single `tools` array at send time. */
  builtInTools?: unknown[];
  /** Called once per file a built-in tool produced (a generated image, or a file written inside the
   *  code-interpreter container). Deduped by `key` across tool hops, so a container file cited in two
   *  hops is handed over once. A throw is logged and swallowed — losing a produced file must never
   *  fail the user's turn. */
  onBuiltInFile?: (file: BuiltInProducedFile) => Promise<void> | void;
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
  /** Tied to the caller's per-agent runBounded deadline. Without this, a timed-out attempt is only
   *  stopped being WAITED ON — the underlying model/tool-call loop keeps running in the background
   *  (a "zombie") with no cancellation, so it can still fire real, un-tracked tool calls (task
   *  creates, etc.) after the turn has already finalized without it. A later retry then discovers
   *  the zombie's own mutations and reports them as pre-existing, since it has no memory of having
   *  just made them. Aborts in-flight fetches and stops starting new hops/tool calls. */
  signal?: AbortSignal;
}

/** An annotation on an `output_text` content part. The only one this file acts on is
 *  `container_file_citation` — how a file WRITTEN BY code_interpreter is reported.
 *  Fields read from openai@7.15.0 `resources/responses/responses.d.ts`
 *  (`ResponseOutputText.annotations`, `ResponseOutputText.ContainerFileCitation`). */
interface ResponsesAnnotation {
  type?: string;
  container_id?: string;
  file_id?: string;
  filename?: string;
}

interface ResponsesReply {
  output_text?: string;
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ text?: string; type?: string; annotations?: ResponsesAnnotation[] }>;
    /** Present on reasoning items when reasoning.summary is enabled. */
    summary?: Array<{ text?: string; type?: string }>;
    /** `image_generation_call` only: the generated image, base64. (`ResponseOutputItem
     *  .ImageGenerationCall.result`, responses.d.ts:3689.) */
    result?: string | null;
    /** `image_generation_call` only: 'png' | 'webp' | 'jpeg'. */
    output_format?: string | null;
  }>;
}

/** One file a built-in tool produced, normalised across the two very different ways they arrive. */
export interface BuiltInProducedFile {
  /** `image` — bytes are already in hand, base64. `container` — must be fetched from the container. */
  kind: "image" | "container";
  /** Filename WITH extension. For a container file this is the name the model chose. */
  filename: string;
  /** Stable identity, for deduping the same file across tool hops. */
  key: string;
  base64?: string;
  containerId?: string;
  fileId?: string;
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

/**
 * Files produced by BUILT-IN tools in this response.
 *
 * The two built-ins report their output in two entirely different places, which is the whole reason
 * this function exists rather than one filter:
 *
 *   image_generation  ->  an `image_generation_call` OUTPUT ITEM whose `result` is the base64 image.
 *                         Nothing further to fetch.
 *   code_interpreter  ->  a file written inside the container. The `code_interpreter_call` item does
 *                         NOT carry it (its `outputs` are only `logs` and inline `image` URLs); the
 *                         file surfaces as a `container_file_citation` ANNOTATION on the message text,
 *                         carrying `container_id` + `file_id` + `filename`. The bytes need a second,
 *                         authenticated GET — see fetchContainerFileBytes.
 *
 * Both shapes were read from openai@7.15.0's generated declarations, not from memory:
 * responses.d.ts:3689 (ImageGenerationCall), :1553 (ResponseCodeInterpreterToolCall), :5353 +
 * :5418 (ResponseOutputText.annotations / ContainerFileCitation).
 *
 * Returns at most one entry per distinct file; the caller dedups again ACROSS hops via `key`.
 */
function extractBuiltInFiles(json: ResponsesReply): BuiltInProducedFile[] {
  const out: BuiltInProducedFile[] = [];
  const seen = new Set<string>();
  for (const item of json.output ?? []) {
    if (item.type === "image_generation_call" && typeof item.result === "string" && item.result) {
      const key = `image:${item.id ?? out.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The tool pins output_format:"png", but the item reports what was ACTUALLY produced — trust
      // that over our request, and fall back to png only when the field is absent.
      const ext = (item.output_format ?? "png").toLowerCase();
      out.push({
        kind: "image",
        // The id is `ig_<hash>`; its tail keeps two images in one turn from colliding on name.
        filename: `generated-image-${(item.id ?? "").slice(-8) || String(out.length + 1)}.${ext}`,
        key,
        base64: item.result,
      });
    }
    for (const part of item.content ?? []) {
      for (const ann of part.annotations ?? []) {
        if (ann.type !== "container_file_citation") continue;
        if (!ann.container_id || !ann.file_id) continue;
        const key = `container:${ann.container_id}:${ann.file_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          kind: "container",
          filename: ann.filename || ann.file_id,
          key,
          containerId: ann.container_id,
          fileId: ann.file_id,
        });
      }
    }
  }
  return out;
}

/**
 * Download one file the code interpreter wrote, from its container.
 *
 * Endpoint read from the OpenAI SDK itself (openai@7.15.0
 * `resources/containers/files/content.js:14`): `GET /containers/{container_id}/files/{file_id}/content`.
 * Returns the raw bytes; throws with the status so the caller can report a real failure rather than
 * silently saving an empty artifact.
 */
export async function fetchContainerFileBytes(
  containerId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");
  const res = await fetch(
    `https://api.openai.com/v1/containers/${encodeURIComponent(containerId)}/files/${encodeURIComponent(fileId)}/content`,
    { headers: { Authorization: `Bearer ${key}` }, signal },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI container file ${res.status}: ${errText.slice(0, 200)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
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
  // Built-in files already handed to onBuiltInFile, so a container file cited again on a later hop
  // (which is normal — the citation rides the message text) is not saved twice.
  const seenBuiltInFiles = new Set<string>();
  // Flipped by the 400 fallback below. Once a request has been rejected WITH built-ins and accepted
  // WITHOUT them, every remaining hop drops them too rather than re-paying for the same rejection.
  let suppressBuiltIns = false;

  for (let hop = 0; hop <= maxHops; hop++) {
    // The caller's deadline already fired and stopped waiting on us — do not start another hop (a
    // fresh model call, or more tool execution). Whatever text/reasoning we've accumulated so far is
    // returned below; the caller has already moved on and discarded it, but this stops the loop from
    // continuing to mutate real state with no one tracking it.
    if (input.signal?.aborted) break;
    // On the FINAL hop, withhold tools so the model MUST answer with text. This prevents a tool call
    // we'd never get to answer (we'd bail right after) — which, in conversation-object mode, would be
    // stored in the thread as a dangling function_call and 400 every subsequent turn ("No tool output
    // found for function call …"). Forcing text on the last hop closes the loop cleanly.
    const isFinalHop = hop === maxHops;
    // Function tools and built-ins travel in ONE `tools` array on the wire but are tracked separately
    // here, because the 400 fallback below must be able to drop exactly the built-ins.
    const fnTools = input.tools ?? [];
    const builtIns = suppressBuiltIns ? [] : (input.builtInTools ?? []);
    const allTools = [...fnTools, ...builtIns];
    const hasTools = !isFinalHop && allTools.length > 0;
    const body: Record<string, unknown> = {
      model: input.model,
      instructions: input.instructions,
      input: runningInput,
      ...(priority ? { service_tier: "priority" } : {}),
      ...(wantReasoning
        ? { reasoning: { ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}), summary: "auto" } }
        : {}),
      ...(hasTools ? { tools: allTools } : {}),
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
    const send = (b: Record<string, unknown>) =>
      fetch(OPENAI_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(input.stream ? { ...b, stream: true } : b),
        signal: input.signal,
      });

    let res = await send(body);
    // The body that was ACTUALLY accepted. The stream-parse fallback further down re-posts this rather
    // than `body`, so a stream error after a built-ins retry doesn't re-send the shape just rejected.
    let sentBody = body;

    // BUILT-IN TOOL FALLBACK. A 400 is a request-SHAPE rejection, and when built-ins are attached they
    // are the newest thing in that shape — a model or account that cannot run code_interpreter /
    // image_generation rejects the whole request, which would otherwise cost the user their entire
    // reply. So retry this hop ONCE with only the function tools. No error-string matching: if the 400
    // was about something else, the retry is rejected identically and we throw exactly as before, so
    // this can only ever turn a hard failure into a degraded success.
    if (res.status === 400 && builtIns.length > 0) {
      const errText = await res.text().catch(() => "");
      console.warn(
        `[callOpenAIResponses] ${input.model} rejected the request with built-in tools attached; ` +
          `retrying without them (reply preserved, no code interpreter / image generation this turn): ` +
          errText.slice(0, 200),
      );
      suppressBuiltIns = true;
      const retryBody: Record<string, unknown> = { ...body };
      if (!isFinalHop && fnTools.length > 0) {
        retryBody.tools = fnTools;
      } else {
        // Nothing left to offer — drop tool_choice too, since it is only meaningful with tools.
        delete retryBody.tools;
        delete retryBody.tool_choice;
      }
      res = await send(retryBody);
      sentBody = retryBody;
    }

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
        const res2 = await fetch(OPENAI_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(sentBody),
          signal: input.signal,
        });
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

    // BUILT-IN OUTPUT. Handed over BEFORE the return below, because a response that produced a file
    // usually has no function_call at all and so returns on this very iteration. A built-in tool ran
    // server-side and is already finished — there is no output for us to submit back, only bytes to
    // collect.
    if (input.onBuiltInFile) {
      for (const file of extractBuiltInFiles(json)) {
        if (seenBuiltInFiles.has(file.key)) continue;
        seenBuiltInFiles.add(file.key);
        try {
          await input.onBuiltInFile(file);
        } catch (err) {
          // Never fail the turn over a file we could not store — the user still gets their reply.
          console.error(
            `[callOpenAIResponses] onBuiltInFile failed for ${file.filename}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    const toolCalls = extractToolCalls(json);
    if (toolCalls.length === 0 || !input.onToolCall || hop === maxHops) {
      return { text: extractText(json).trim(), reasoning };
    }

    const nextInput: unknown[] = [];
    for (const tc of toolCalls) {
      // The model can return SEVERAL tool calls in one hop; don't start any more of them once the
      // deadline has fired mid-batch (a call already in flight via onToolCall below still finishes —
      // this only stops the NEXT one from starting).
      if (input.signal?.aborted) break;
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
