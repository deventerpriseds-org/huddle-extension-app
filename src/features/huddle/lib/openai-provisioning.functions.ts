import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";

const AgentIds = AGENTS.map((a) => a.id) as [AgentId, ...AgentId[]];

interface ProvisionResult {
  agentId: AgentId;
  vectorStoreId?: string;
  created: boolean;
  reused: boolean;
  error?: string;
  existedRemote?: boolean;
}

const ProvisionInput = z.object({
  /** Existing store ids from the client (persisted per-agent config). */
  existing: z.record(z.enum(AgentIds), z.string().optional()).default({}),
  /** If true, only provision agents that don't already have an id. */
  onlyMissing: z.boolean().default(true),
});

async function verifyStore(key: string, id: string): Promise<boolean> {
  const res = await fetch(`https://api.openai.com/v1/vector_stores/${id}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  return res.ok;
}

async function createStore(key: string, name: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/vector_stores", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /v1/vector_stores → ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id: string };
  return j.id;
}

/**
 * Provision an OpenAI vector store for every agent that doesn't already have
 * one. Returns the resulting id per agent so the client can persist them
 * into the backend config and flip `rag.fileSearch = true`.
 */
export const provisionAgentVectorStores = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => ProvisionInput.parse(raw))
  .handler(async ({ data }) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return {
        ok: false as const,
        error: "OPENAI_API_KEY not configured",
        results: [] as ProvisionResult[],
      };
    }

    const results: ProvisionResult[] = [];
    for (const agent of AGENTS) {
      const existing = data.existing[agent.id];
      try {
        if (existing) {
          const alive = await verifyStore(key, existing);
          if (alive) {
            results.push({
              agentId: agent.id,
              vectorStoreId: existing,
              created: false,
              reused: true,
              existedRemote: true,
            });
            continue;
          }
          // The saved id doesn't resolve on OpenAI — fall through to create.
        }
        const name = `huddle:${agent.id}`;
        const id = await createStore(key, name);
        results.push({
          agentId: agent.id,
          vectorStoreId: id,
          created: true,
          reused: false,
        });
      } catch (err) {
        results.push({
          agentId: agent.id,
          created: false,
          reused: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const okCount = results.filter((r) => r.vectorStoreId).length;
    return {
      ok: okCount > 0,
      results,
      summary: {
        total: results.length,
        created: results.filter((r) => r.created).length,
        reused: results.filter((r) => r.reused).length,
        failed: results.filter((r) => r.error).length,
      },
    };
  });

/**
 * Verify each stored vector-store id actually exists on OpenAI. Used by the
 * Memory DB panel to show status without mutating anything.
 */
export const inspectAgentVectorStores = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ existing: z.record(z.enum(AgentIds), z.string().optional()).default({}) }).parse(raw),
  )
  .handler(async ({ data }) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ok: false as const, error: "OPENAI_API_KEY not configured", rows: [] };
    const rows: Array<{ agentId: AgentId; name: string; vectorStoreId?: string; alive: boolean }> = [];
    for (const agent of AGENTS) {
      const id = data.existing[agent.id];
      if (!id) {
        rows.push({ agentId: agent.id, name: AGENT_BY_ID[agent.id].name, alive: false });
        continue;
      }
      const alive = await verifyStore(key, id);
      rows.push({ agentId: agent.id, name: AGENT_BY_ID[agent.id].name, vectorStoreId: id, alive });
    }
    return { ok: true as const, rows };
  });
