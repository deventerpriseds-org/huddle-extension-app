/**
 * Push authoritative instructions UP to specific OpenAI assistants, so the
 * platform (the backup / source of truth) matches the role we want. Only the
 * assistants listed in PUSH below are touched — every other assistant is left
 * exactly as it is on the dashboard, so this never clobbers the rich existing
 * personas.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun run scripts/push-assistant-instructions.ts
 *
 * After running this, run `scripts/fetch-openai-assistants.ts` to pull the
 * refreshed config back into the local snapshot JSON that the runtime reads.
 */

interface Push {
  assistantId: string;
  name: string;
  instructions: string;
}

// Only these assistants are updated on the platform. Add an entry to
// re-author an assistant from source; remove it to leave the dashboard copy
// untouched.
const PUSH: Record<string, Push> = {
  "tess-sutton": {
    assistantId: "asst_KnIB4EMkB5ziEwZZdwEFzoIl",
    name: "Product Owner Agent",
    instructions: [
      "You are the user's Product Owner for their apps and products. You own the product: you decide what to build and in what order, maintain the product roadmap, define and prioritize features, and call what ships in each release. Translate goals and user needs into a clear, ordered backlog, and be decisive about scope and trade-offs.",
      "",
      "Voice: brisk, wry, product-first. Use sentence case, no emoji, no headings. Keep replies to 1-3 short sentences unless the user asks for detail.",
      "",
      "Stay in the product lane. General life prioritization (fitness, family, errands, career, travel, personal finance) belongs to the team lead, Iris Chase - @iris-chase. The business and venture around the product (fundraising, pitch, go-to-market, business model) belongs to Sam Trent - @sam-trent. Process and ceremonies (standups, sprint planning, reviews, retros, removing impediments) belong to the scrum master, Terry Locke - @terry-locke. When a request falls outside product, keep it to one line and @mention the right owner; the mention itself is the handoff, don't narrate it.",
    ].join("\n"),
  },
};

async function pushOne(handle: string, p: Push): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  process.stdout.write(`• ${handle} (${p.assistantId}) … `);
  const res = await fetch(`https://api.openai.com/v1/assistants/${p.assistantId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ name: p.name, instructions: p.instructions }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /v1/assistants/${p.assistantId} → ${res.status}: ${body.slice(0, 300)}`);
  }
  console.log(`updated · ${p.instructions.length} chars`);
}

async function main() {
  const entries = Object.entries(PUSH);
  if (entries.length === 0) {
    console.log("Nothing to push (PUSH is empty).");
    return;
  }
  for (const [handle, p] of entries) {
    await pushOne(handle, p);
  }
  console.log(`\nPushed ${entries.length} assistant(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
