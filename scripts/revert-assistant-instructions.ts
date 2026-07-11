/**
 * Realign specific platform assistants with the canonical instructions now stored
 * in openai-assistant-snapshots.json. Used to undo a destructive overwrite: after
 * the snapshot has been restored from git, this pushes that restored text back UP
 * to the OpenAI assistant so the platform and the repo agree again (otherwise the
 * daily pull-only refresh would re-introduce the overwrite).
 *
 * Reads the text from the committed snapshot — nothing is re-embedded here, so it
 * cannot drift from what the runtime actually uses.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun run scripts/revert-assistant-instructions.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Agents whose platform copy must be realigned to the restored snapshot.
const REVERT = ["iris-chase", "sam-trent"];

const SNAP_PATH = resolve(process.cwd(), "src/features/huddle/data/openai-assistant-snapshots.json");
const IDS_PATH = resolve(process.cwd(), "src/features/huddle/data/assistant-ids.json");

async function main() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const snap = JSON.parse(readFileSync(SNAP_PATH, "utf8")) as Record<
    string,
    { name: string | null; instructions: string | null }
  >;
  const ids = JSON.parse(readFileSync(IDS_PATH, "utf8")) as Record<string, string>;

  for (const agentId of REVERT) {
    const assistantId = ids[agentId];
    const s = snap[agentId];
    if (!assistantId || !s) {
      console.log(`• ${agentId} — no id/snapshot, skipping`);
      continue;
    }
    process.stdout.write(`• ${agentId} (${assistantId}) … `);
    const res = await fetch(`https://api.openai.com/v1/assistants/${assistantId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ name: s.name, instructions: s.instructions }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`POST /v1/assistants/${assistantId} → ${res.status}: ${body.slice(0, 300)}`);
    }
    console.log(`realigned · ${(s.instructions ?? "").length} chars (${s.name})`);
  }
  console.log(`\nRealigned ${REVERT.length} assistant(s) to the restored canonical text.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
