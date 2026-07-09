import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
  JourneyCallerIdentity,
  JourneyHealthResponse,
  JourneyResponsesTool,
  JourneyToolDefinition,
  JourneyToolInvocationRequest,
  JourneyToolInvocationResponse,
  JourneyToolsListResponse,
  JourneyTask,
} from "./types";

// -------------------------------------------------------------------------
// Environment
// -------------------------------------------------------------------------
// JOURNEY_PROXY_URL   e.g.  https://<journey-project>.supabase.co/functions/v1/huddle-proxy
// JOURNEY_PROXY_TOKEN shared bearer used on BOTH sides of the contract.
//
// The proxy exposes:
//   GET  /health        → { ok, version, toolCount }
//   GET  /tools         → { ok, tools: ToolDefinition[] }   (mirrors _shared/tool-definitions.ts)
//   POST /tool          → executes one tool, resolves user by Entra identity
//
// Reads env at call time (never at module scope — this module is imported
// dynamically inside handlers).
// -------------------------------------------------------------------------

function journeyEnv() {
  const url = (process.env.JOURNEY_PROXY_URL ?? "").trim().replace(/\/$/, "");
  const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
  return { url, token, configured: !!url && !!token };
}

async function journeyFetch(path: string, init?: RequestInit): Promise<Response> {
  const { url, token, configured } = journeyEnv();
  if (!configured) {
    throw new Error("JOURNEY_PROXY_URL / JOURNEY_PROXY_TOKEN not configured");
  }
  const res = await fetch(url + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-huddle-proxy": "1",
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

// -------------------------------------------------------------------------
// Server-only helpers (also usable directly from other server modules).
// -------------------------------------------------------------------------

export async function fetchJourneyToolDefinitions(): Promise<JourneyToolDefinition[]> {
  const res = await journeyFetch("/tools", { method: "GET" });
  if (!res.ok) throw new Error(`journey /tools ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as JourneyToolsListResponse;
  if (!body.ok) throw new Error(body.error ?? "journey /tools returned ok=false");
  return body.tools ?? [];
}

/** Convert a journey ToolDefinition into an OpenAI Responses `type:"function"` tool. */
export function toResponsesTool(t: JourneyToolDefinition): JourneyResponsesTool {
  return {
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown> as Record<string, unknown>,
    strict: false,
  };
}

export async function invokeJourneyTool(
  req: JourneyToolInvocationRequest,
): Promise<JourneyToolInvocationResponse> {
  const res = await journeyFetch("/tool", {
    method: "POST",
    body: JSON.stringify(req),
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      output: JSON.stringify({ error: `journey /tool ${res.status}`, detail: text.slice(0, 400) }),
      error: `journey /tool ${res.status}: ${text.slice(0, 200)}`,
    };
  }
  try {
    return JSON.parse(text) as JourneyToolInvocationResponse;
  } catch {
    return { ok: false, output: text, error: "journey /tool returned non-JSON" };
  }
}

// -------------------------------------------------------------------------
// Server functions (client-callable)
// -------------------------------------------------------------------------

export const listJourneyTools = createServerFn({ method: "GET" }).handler(
  async (): Promise<JourneyToolsListResponse> => {
    const { configured } = journeyEnv();
    if (!configured) return { ok: false, tools: [], error: "not configured" };
    try {
      const tools = await fetchJourneyToolDefinitions();
      return { ok: true, tools };
    } catch (err) {
      return { ok: false, tools: [], error: err instanceof Error ? err.message : String(err) };
    }
  },
);

export const checkJourneyHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<JourneyHealthResponse> => {
    const { url, configured } = journeyEnv();
    if (!configured) {
      return {
        ok: false,
        configured: false,
        error: "JOURNEY_PROXY_URL / JOURNEY_PROXY_TOKEN not set",
      };
    }
    const started = Date.now();
    try {
      const res = await journeyFetch("/health", { method: "GET" });
      const latencyMs = Date.now() - started;
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          configured: true,
          proxyUrl: url,
          latencyMs,
          error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        };
      }
      let body: { ok?: boolean; version?: string; toolCount?: number; error?: string } = {};
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: "non-JSON health response" };
      }
      return {
        ok: !!body.ok,
        configured: true,
        proxyUrl: url,
        latencyMs,
        version: body.version,
        toolCount: body.toolCount,
        error: body.error,
      };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        proxyUrl: url,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);

/**
 * Debug-only: manually invoke a journey tool with the caller's Entra identity.
 * Not used in the hot path — the agent turn loop calls `invokeJourneyTool()`
 * directly. Kept so the settings drawer can smoke-test end-to-end.
 */
const InvokeInput = z.object({
  toolName: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  caller: z.object({
    entra_object_id: z.string().optional(),
    entra_email: z.string().optional(),
  }),
  agentId: z.string().optional(),
  huddleId: z.string().optional(),
});

export const invokeJourneyToolDebug = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => InvokeInput.parse(raw))
  .handler(async ({ data }): Promise<JourneyToolInvocationResponse> => {
    const caller: JourneyCallerIdentity = data.caller;
    return invokeJourneyTool({
      toolName: data.toolName,
      args: data.args,
      caller,
      context: { source: "huddle", huddleId: data.huddleId, agentId: data.agentId },
    });
  });

// Re-export for consumers that only need the type
export type { JourneyTask };
