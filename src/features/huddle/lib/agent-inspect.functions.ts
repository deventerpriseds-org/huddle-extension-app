import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type AgentId } from "../data/agents";

const AgentIds = AGENTS.map((a) => a.id) as [AgentId, ...AgentId[]];

const AgentIdInput = z.object({ agentId: z.enum(AgentIds) });

/**
 * Return the resolved config the runtime would use for this agent, so the UI
 * can show the full system prompt and confirm whether it's snapshot-authored
 * or a fallback in-repo prompt.
 */
export const getAgentDebug = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown) => AgentIdInput.parse(raw))
  .handler(async ({ data }) => {
    const winner = AGENT_BY_ID[data.agentId];
    const { getAssistantSnapshot, snapshotResponsesTools } = await import(
      "./openai-assistants.server"
    );
    const { buildRoster } = await import("./roster");
    const snapshot = getAssistantSnapshot(data.agentId);

    // Build a preview of the instructions exactly as the runtime constructs
    // them (persona/snapshot + placeholder-scene + roster). The real per-turn
    // scene block is dropped in at reply time.
    const scenePlaceholder =
      ` You are ${winner.name} in a huddle. Reply naturally as yourself, in-character. If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle. 1–3 short sentences unless asked for detail.`;
    const roster = buildRoster(
      AGENTS.map((a) => a.id),
      winner.id,
    );

    const snapshotInstructions = snapshot?.instructions?.trim();
    const previewInstructions = snapshotInstructions
      ? snapshotInstructions + scenePlaceholder + roster
      : winner.systemPrompt + scenePlaceholder + roster;

    return {
      agentId: data.agentId,
      hasSnapshot: !!snapshot,
      snapshotName: snapshot?.name ?? null,
      resolvedModel: snapshot?.model ?? "gpt-4o (fallback default)",
      fetchedAt: snapshot?.fetchedAt ?? null,
      snapshotTools: snapshotResponsesTools(snapshot).map(
        (t) => (t as { type?: string })?.type ?? "unknown",
      ),
      droppedTools:
        snapshot?.tools
          .map((t) => t?.type as string | undefined)
          .filter((t): t is string => !!t && t !== "file_search" && t !== "function") ?? [],
      previewInstructions,
    };
  });

/**
 * Refetch a single assistant snapshot from OpenAI and update the on-disk JSON
 * used at runtime. Returns a diff summary.
 *
 * NB: This writes to `src/features/huddle/data/openai-assistant-snapshots.json`
 * which is bundled — the dev server picks it up on the next Vite reload; the
 * currently-running server function still holds the old import until the
 * module graph invalidates.
 */
export const refetchAgentSnapshot = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => AgentIdInput.parse(raw))
  .handler(async ({ data }) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return { ok: false as const, error: "OPENAI_API_KEY not configured" };
    }
    const { ASSISTANT_IDS } = await import("./agent-backends");
    const id = ASSISTANT_IDS[data.agentId];
    if (!id) {
      return { ok: false as const, error: "No assistant ID mapped for this agent" };
    }
    const res = await fetch(`https://api.openai.com/v1/assistants/${id}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "OpenAI-Beta": "assistants=v2",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false as const,
        error: `GET /v1/assistants/${id} → ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const a = (await res.json()) as {
      id: string;
      name: string | null;
      model: string;
      instructions: string | null;
      tools?: unknown[];
      tool_resources?: unknown;
      metadata?: Record<string, string> | null;
      temperature?: number | null;
      top_p?: number | null;
      response_format?: unknown;
    };

    // Persist to disk (dev + prod on Cloudflare: fs.writeFile works in the
    // sandbox; if this ever ships to a read-only filesystem, wrap in try).
    try {
      const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import("node:fs");
      const { dirname, resolve } = await import("node:path");
      const outPath = resolve(process.cwd(), "src/features/huddle/data/openai-assistant-snapshots.json");
      const existing = existsSync(outPath)
        ? (JSON.parse(readFileSync(outPath, "utf8")) as Record<string, unknown>)
        : {};
      existing[data.agentId] = {
        assistantId: a.id,
        name: a.name,
        model: a.model,
        instructions: a.instructions,
        tools: a.tools ?? [],
        toolResources: a.tool_resources ?? null,
        metadata: a.metadata ?? null,
        temperature: a.temperature ?? null,
        topP: a.top_p ?? null,
        responseFormat: a.response_format ?? null,
        fetchedAt: new Date().toISOString(),
      };
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    } catch (err) {
      // On a read-only runtime the fetched data still comes back, but the
      // caller should know the on-disk snapshot did not update.
      return {
        ok: true as const,
        persisted: false,
        model: a.model,
        instructionsLen: (a.instructions ?? "").length,
        warning: err instanceof Error ? err.message : "Could not persist snapshot to disk",
      };
    }

    return {
      ok: true as const,
      persisted: true,
      model: a.model,
      instructionsLen: (a.instructions ?? "").length,
    };
  });
