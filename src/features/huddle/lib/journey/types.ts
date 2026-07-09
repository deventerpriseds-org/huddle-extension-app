// Shared types for the journey-voice ↔ huddle proxy contract.
//
// Both sides speak the same JSON shape so either app can be the caller
// or the callee. Journey-voice ships `getToolDefinitions()` at
// `supabase/functions/_shared/tool-definitions.ts` — the shape below is a
// verbatim mirror so we do NOT hand-copy schemas across repos.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonValue = any;

export interface JourneyToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonValue>;
    required?: string[];
  };
}

/** OpenAI Responses-shape tool built from a JourneyToolDefinition. */
export interface JourneyResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, JsonValue>;
  strict: false;
}

/** Task row mirrored from journey-voice into the huddle board view. */
export interface JourneyTask {
  id: string;
  title: string;
  status: string;                 // journey status verbatim (BACKLOG, DOING, DONE, …)
  category?: string | null;
  topic_group?: string | null;
  updated_at?: string;
  origin: "journey-voice";
}

/** Identity hints passed to the proxy so it can resolve a Supabase user id. */
export interface JourneyCallerIdentity {
  entra_object_id?: string;
  entra_email?: string;
}

/** Request shape for POST {proxy}/tool */
export interface JourneyToolInvocationRequest {
  toolName: string;
  args: Record<string, unknown>;
  caller: JourneyCallerIdentity;
  context?: { source: "huddle"; huddleId?: string; agentId?: string };
}

/** Response shape for POST {proxy}/tool */
export interface JourneyToolInvocationResponse {
  ok: boolean;
  /** Raw tool result serialized as string — the model consumes this verbatim. */
  output: string;
  /** Optional: journey may return any task rows it mutated so the huddle board can mirror them. */
  tasks?: JourneyTask[];
  error?: string;
}

/** Response shape for GET {proxy}/tools */
export interface JourneyToolsListResponse {
  ok: boolean;
  tools: JourneyToolDefinition[];
  error?: string;
}

export interface JourneyHealthResponse {
  ok: boolean;
  version?: string;
  toolCount?: number;
  error?: string;
  configured: boolean;
  proxyUrl?: string;
  latencyMs?: number;
}
