// Classifier-accuracy harness. Runs a live LLM over every ask in the shared catalog, asks it to emit a
// taskType, and compares to the catalog label. This is the REAL accuracy number (the offline 59% was
// just the regex fallback). Run via model-lab.yml (has OPENAI_API_KEY). No deps — global fetch + fs.
import { readFileSync } from "node:fs";

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.CLASSIFIER_MODEL || "gpt-5.6-luna"; // cheap classifier — what production would use
const catalog = JSON.parse(readFileSync(new URL("../asks-catalog.json", import.meta.url), "utf8")).asks;

const TYPES = ["ack", "read", "crud", "recall", "short_draft", "plan", "decide", "analyze", "produce", "deep_strategy", "research"];
const DEFS = `
ack: acknowledgement / social filler / thanks — no real task.
read: quick fact or status lookup (calendar, balance, "what's on…", "when is…", "status of…").
crud: a single create/update/delete/schedule op (add task, set reminder/alarm, reschedule, book, park, assign).
recall: asking to remember something from earlier in the conversation or memory ("what did we decide…").
short_draft: a quick one-liner / brief note / low-stakes riff.
plan: multi-step planning, sequencing, itinerary, or roadmap.
decide: judgment, prioritization, tradeoff, or recommendation ("should I…", "which…", "what should I focus on").
analyze: numeric/analytical reasoning (budget, compare costs, runway, model the numbers).
produce: create a substantive written deliverable (essay, resume, email, announcement, brief, proposal).
deep_strategy: complex, multi-constraint strategy or modeling (GTM, business model, financial model, major life decision).
research: gather external information and synthesize it into a written brief/report.`;

async function classify(ask, role) {
  const body = {
    model: MODEL,
    reasoning: { effort: "low" },
    instructions: `You classify a user's message to an AI ${role} into exactly ONE task type. Definitions:${DEFS}\nReturn only the single best-fitting taskType.`,
    input: [{ role: "user", content: ask }],
    text: { format: { type: "json_schema", name: "cls", schema: { type: "object", additionalProperties: false, properties: { taskType: { type: "string", enum: TYPES } }, required: ["taskType"] }, strict: true } },
  };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const txt = j.output_text ?? (j.output ?? []).flatMap((o) => o.content ?? []).find((c) => c.type === "output_text" || c.text)?.text ?? "{}";
  return JSON.parse(txt).taskType;
}

const ROLE = { "iris-chase": "team lead", "terry-locke": "scrum master", "finn-reid": "finance strategist", "faith-hartley": "family scheduler", "elle-rowan": "EMBA planner", "flex-grimes": "fitness coach", "ezra-miles": "errands assistant", "sam-trent": "startup planner", "cole-blake": "career coach", "charleston-lewis": "personal chef", "eli-vaughn": "executive assistant", "liam-kingsley": "life strategist", "cam-post": "communications agent", "troy-lennox": "travel agent", "tess-sutton": "product owner" };

let hit = 0;
const confusion = {};
const misses = [];
for (const a of catalog) {
  try {
    const got = await classify(a.ask, ROLE[a.agent] || "assistant");
    const ok = got === a.expectType;
    if (ok) hit++;
    else { misses.push({ ask: a.ask, expect: a.expectType, got }); const k = `${a.expectType}->${got}`; confusion[k] = (confusion[k] || 0) + 1; }
    console.log(`${ok ? "✓" : "✗"} [${a.expectType}${ok ? "" : "→" + got}] ${a.ask.slice(0, 60)}`);
  } catch (e) {
    console.log(`! ERROR ${a.id}: ${String(e).slice(0, 120)}`);
    misses.push({ ask: a.ask, expect: a.expectType, got: "ERROR" });
  }
}
console.log(`\n===== CLASSIFIER ACCURACY (${MODEL}): ${hit}/${catalog.length} = ${Math.round((100 * hit) / catalog.length)}% =====`);
console.log("Confusions (expected->got):", JSON.stringify(confusion));
console.log("Misses:", JSON.stringify(misses, null, 0).slice(0, 1500));
