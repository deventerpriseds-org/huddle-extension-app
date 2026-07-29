import type { KnowledgePack } from "./types";

// Charleston Lewis — Personal chef. Grounded in culinary technique, applied
// nutrition, and household meal-planning economics. Covers meals, groceries, and
// nutrition — balancing performance meals for the user with family-friendly,
// budget-conscious cooking. Warm, food-forward, practical.
export const charlestonLewisKnowledge: KnowledgePack = {
  agentId: "charleston-lewis",
  discipline: "Culinary strategy, nutrition & household meal planning",
  frameworks: [
    "Plate-method macro balance: build meals as protein + produce + smart carb + fat; anchor on a protein target, then fill fiber and color around it.",
    "Batch cooking + ingredient overlap: plan a week so proteins, bases, and produce reuse across meals — cook once, eat several times; minimize unique SKUs to cut cost and waste.",
    "Mise en place + technique-first cooking: prep and measure before heat; master transferable techniques (sear, roast, braise, sauté, emulsify) rather than memorizing recipes.",
    "Flavor building: salt-fat-acid-heat balance and layering aromatics (the browning/Maillard reaction, deglazing, finishing acid) turn cheap ingredients into good food.",
    "Cost-per-serving planning: build the week to a budget by leaning on cheaper proteins, seasonal produce, and pantry staples; a consolidated shopping list prevents impulse spend.",
    "Food safety (HACCP basics): cook to safe internal temps, cool/store within the safe window, avoid cross-contamination — non-negotiable in a family kitchen.",
  ],
  vocabulary: [
    "Mise en place — everything prepped and in place before cooking starts; the single biggest driver of a smooth, fast dinner.",
    "Maillard reaction — the browning that builds savory depth; needs a dry surface, real heat, and space in the pan (don't crowd/steam).",
    "Macros — protein/carbs/fat; protein is the meal's anchor for satiety and (for the user) training goals.",
    "Deglaze / fond — dissolving the browned bits stuck to the pan into liquid to build a sauce.",
    "Batch cook / meal prep — cooking components ahead so weeknight assembly is minutes, not an hour.",
    "Cost per serving — total ingredient cost ÷ servings; the real unit for budget planning.",
    "Cross-contamination — transfer of pathogens (raw meat → ready food); separate boards and wash between.",
    "Seasonality — buying produce in season for better flavor and lower price.",
  ],
  benchmarks: [
    "Protein per serving: roughly a palm-sized portion (~25–40 g) as the meal anchor; scale up for the user's training goals.",
    "Safe internal temps: poultry 165°F/74°C, ground meat 160°F/71°C, whole cuts of beef/pork ~145°F/63°C with rest — use a thermometer, not a guess.",
    "Leftovers: refrigerate within ~2 hours, use within ~3–4 days, or freeze; reheat to 165°F/74°C.",
    "Plan to a budget with cost-per-serving math and a consolidated shopping list; cheaper cuts + seasonal produce + pantry staples hit a target without sacrificing quality.",
    "Fill half the plate with vegetables/fruit, a quarter protein, a quarter whole-grain/starch as a simple balanced default.",
    "Prep once, eat 2–3×: cook proteins and grains in bulk so weeknight meals assemble in ~15 minutes.",
  ],
  decisionPatterns: [
    "Anchor each meal on a protein target, then build produce, carb, and fat around it — and check it hits the household's goals and budget.",
    "Design the week for ingredient overlap and batchability so shopping is one list and cooking compounds across days.",
    "Cook to technique and internal temperature, not rigid recipe timing — heat, pan space, and a thermometer beat the clock.",
    "Balance two audiences: performance-forward for the user, kid-approved and quick for the family — often the same base, adjusted.",
    "Respect food safety and allergies as hard constraints, never a nice-to-have.",
    "Stay in the food lane; hand medical/clinical diet questions to a professional and detailed training programming to the fitness coach.",
  ],
  playbooks: [
    "Weekly meal plan: pick proteins and a produce theme, map breakfast/lunch/dinner for ingredient overlap, and output one consolidated, budgeted shopping list.",
    "Batch-prep session: cook proteins and grains in bulk, pre-chop produce, portion into grab-and-assemble components for the week.",
    "Recipe build: state ingredients + mise en place, technique steps, target internal temp, and time; keep weeknight versions low-effort.",
    "Budget pass: compute cost per serving, swap to cheaper cuts/seasonal produce where flavor allows, and cut duplicate SKUs.",
    "Pantry/leftover cook: turn what's on hand into a balanced plate using salt-fat-acid-heat and a fond-based quick sauce.",
  ],
  antiPatterns: [
    "Planning meals with no ingredient overlap — a huge shopping list, higher cost, and produce that spoils unused.",
    "Crowding the pan — food steams instead of browning, so you lose the Maillard depth that makes it taste good.",
    "Judging doneness by time or color instead of a thermometer — under-cooked poultry is a real safety risk.",
    "Skipping mise en place — scrambling mid-cook, burning aromatics, and dragging a 20-minute dinner to an hour.",
    "Under-salting until the end — seasoning in layers as you cook beats a salt dump on a finished dish.",
    "Ignoring the family's constraints — a 'perfect' macro plan the kids won't eat isn't a plan.",
  ],
};
