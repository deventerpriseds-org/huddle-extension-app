/**
 * One-shot script: pulls the current config of each OpenAI assistant referenced
 * in `src/features/huddle/lib/agent-backends.ts` and writes a snapshot to
 * `src/features/huddle/data/openai-assistant-snapshots.json`.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun run scripts/fetch-openai-assistants.ts
 *
 * Rerun anytime you edit an assistant on OpenAI's dashboard and want to pull
 * the update. The runtime never calls the Assistants API — it reads this JSON.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ASSISTANT_IDS: Record<string, string> = {
  "flex-grimes": "asst_TkRNda28gmRggEb1duj31a8J",
  "charleston-lewis": "asst_epZActkpqNmqw7KusXBmyfuT",
  "troy-lennox": "asst_AqTwFwQx5RICAH3OPYVPCG5Q",
  "ezra-miles": "asst_FIdoVvUYjszVEei8QBo2LFoO",
  "faith-hartley": "asst_gY8usQIJelYXLZzQm08Z0C2x",
  "sam-trent": "asst_zIO5Sfb4k4IzHOF2TbJQf1tH",
  "elle-rowan": "asst_yLrJPsX4gJjiQo92kLUUOhnh",
  "cole-blake": "asst_nk9d9XZcVacBHyhzUPvAVM5o",
  "tess-sutton": "asst_KnIB4EMkB5ziEwZZdwEFzoII",
  "iris-chase": "asst_BcZBxIx9zH8VlPvfJrhPP3EF",
  "eli-vaughn": "asst_hNYvCTsP7t8XB4Md0xFN7DwC",
  "liam-kingsley": "asst_GVIrKekZI0p9UsqAgGYZHtOE",
};

interface AssistantSnapshot {
  assistantId: string;
  name: string | null;
  model: string;
  instructions: string | null;
  tools: unknown[];
  toolResources: unknown;
  metadata: Record<string, string> | null;
  temperature: number | null;
  topP: number | null;
  responseFormat: unknown;
  fetchedAt: string;
}

const OUT_PATH = resolve(
  process.cwd(),
  "src/features/huddle/data/openai-assistant-snapshots.json",
);

async function fetchAssistant(id: string): Promise<AssistantSnapshot> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch(`https://api.openai.com/v1/assistants/${id}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "OpenAI-Beta": "assistants=v2",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /v1/assistants/${id} → ${res.status}: ${body.slice(0, 300)}`);
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
  return {
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
}

async function main() {
  const previous: Record<string, AssistantSnapshot> = existsSync(OUT_PATH)
    ? (JSON.parse(readFileSync(OUT_PATH, "utf8")) as Record<string, AssistantSnapshot>)
    : {};
  const next: Record<string, AssistantSnapshot> = {};

  for (const [handle, id] of Object.entries(ASSISTANT_IDS)) {
    process.stdout.write(`• ${handle} (${id}) … `);
    try {
      const snap = await fetchAssistant(id);
      next[handle] = snap;
      const prev = previous[handle];
      if (!prev) {
        console.log(`new · model=${snap.model} · ${snap.instructions?.length ?? 0} chars`);
      } else if (
        prev.instructions !== snap.instructions ||
        prev.model !== snap.model ||
        JSON.stringify(prev.tools) !== JSON.stringify(snap.tools)
      ) {
        console.log(`updated · model=${snap.model} · ${snap.instructions?.length ?? 0} chars`);
      } else {
        console.log(`unchanged · model=${snap.model}`);
      }
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
      if (previous[handle]) next[handle] = previous[handle]; // keep the last good snapshot
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${Object.keys(next).length} snapshots → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
