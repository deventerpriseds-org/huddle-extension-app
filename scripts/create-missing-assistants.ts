/**
 * Create OpenAI platform assistants for agents that don't have one yet, so every
 * agent is consistently assistant-backed (the runtime's snapshot path) instead of
 * silently falling back to the in-repo persona.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun run scripts/create-missing-assistants.ts
 *
 * Idempotent: only agents ABSENT from src/features/huddle/data/assistant-ids.json
 * are created. The newly-minted ids are merged back into that JSON (the single
 * source of truth), then `scripts/fetch-openai-assistants.ts` snapshots them.
 *
 * For agents flagged `fileSearch`, a fresh (empty) vector store is created and
 * attached so they can do OpenAI file search; files can be added later via the
 * Memory DB panel.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Spec {
  name: string;
  model: string;
  fileSearch: boolean;
  instructions: string;
}

// Explicit, authored config — nothing is created that isn't listed here.
const SPECS: Record<string, Spec> = {
  "terry-locke": {
    name: "Scrum Master Agent",
    model: "gpt-4o-mini",
    fileSearch: false,
    instructions: [
      "You are the user's Scrum Master. You run the team's process and cadence: you facilitate standups, sprint planning, reviews and retros, hold timeboxes, and actively remove impediments — surface who is blocking what and drive it to unblocked.",
      "",
      "Voice: measured, briefing-style, no fluff. Use sentence case, no emoji, no headings. Keep replies to 1-3 short sentences unless the user asks for detail.",
      "",
      "You do NOT set priorities or own delivery — that is the team lead, Iris Chase (@iris-chase). Product decisions (features, roadmap) belong to the product owner, Tess Sutton (@tess-sutton); the business/venture (fundraising, GTM) belongs to Sam Trent (@sam-trent). When a request falls outside process/ceremonies, keep it to one line and @mention the right owner; the mention itself is the handoff, don't narrate it.",
    ].join("\n"),
  },
  "finn-reid": {
    name: "Finance Strategist Agent",
    model: "gpt-4o",
    fileSearch: true,
    instructions: [
      "You are the user's Finance Strategist. You advise on budgeting, credit optimization, soft-pull loans, refinancing, cashflow and runway planning. Be professional and precise, with financial clarity and logic; show the numbers and the trade-offs.",
      "",
      "Voice: professional and precise. Use sentence case, no emoji, no headings. Keep replies to 1-3 short sentences unless the user asks for detail.",
      "",
      "Stay in the finance lane — never career or health advice. When a request is outside finance, keep it to one line and @mention the right specialist (e.g. @cole-blake for career, @iris-chase for scheduling); the mention itself is the handoff, don't narrate it.",
    ].join("\n"),
  },
  "cam-post": {
    name: "Communications Agent",
    model: "gpt-4o-mini",
    fileSearch: true,
    instructions: [
      "You are the user's Communications Agent. You craft emails, Slack replies, social posts and public-facing messaging, maintaining tone, clarity and polish like a media-savvy professional. Match the audience and the user's voice; tighten wording and fix tone.",
      "",
      "Voice: clear, polished and expressive. Use sentence case, no emoji, no headings. Keep replies to 1-3 short sentences unless the user asks for detail.",
      "",
      "Stay in the messaging lane — not scheduling or finance. When a request is outside communications, keep it to one line and @mention the right specialist; the mention itself is the handoff, don't narrate it.",
    ].join("\n"),
  },
};

const IDS_PATH = resolve(process.cwd(), "src/features/huddle/data/assistant-ids.json");

async function api(path: string, body: unknown): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`POST /v1/${path} → ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  const ids = JSON.parse(readFileSync(IDS_PATH, "utf8")) as Record<string, string>;
  let created = 0;

  for (const [agentId, spec] of Object.entries(SPECS)) {
    if (ids[agentId]) {
      console.log(`• ${agentId} — already mapped (${ids[agentId]}), skipping`);
      continue;
    }
    process.stdout.write(`• ${agentId} — creating … `);

    let toolResources: unknown = undefined;
    let tools: unknown[] = [];
    if (spec.fileSearch) {
      const store = await api("vector_stores", { name: `huddle:${agentId}` });
      tools = [{ type: "file_search" }];
      toolResources = { file_search: { vector_store_ids: [store.id] } };
      process.stdout.write(`store=${store.id} … `);
    }

    const assistant = await api("assistants", {
      name: spec.name,
      model: spec.model,
      instructions: spec.instructions,
      ...(tools.length ? { tools } : {}),
      ...(toolResources ? { tool_resources: toolResources } : {}),
    });
    ids[agentId] = assistant.id;
    created++;
    console.log(`assistant=${assistant.id}`);
  }

  writeFileSync(IDS_PATH, JSON.stringify(ids, null, 2) + "\n", "utf8");
  console.log(`\nCreated ${created} assistant(s). assistant-ids.json now has ${Object.keys(ids).length} entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
