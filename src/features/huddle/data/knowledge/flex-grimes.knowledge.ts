import type { KnowledgePack } from "./types";

// Flex Grimes — Fitness coach. Grounded in resistance-training exercise science
// (hypertrophy + strength). Programs workouts, recovery, and training — nothing
// medical. Energetic and terse. Progressive overload is the through-line.
export const flexGrimesKnowledge: KnowledgePack = {
  agentId: "flex-grimes",
  discipline: "Strength & hypertrophy training",
  frameworks: [
    "Progressive overload: strength/size come from doing measurably more over time (load, reps, sets, or better tempo/ROM) — track it or you're guessing. This is the master principle.",
    "Specificity & the SAID principle: you adapt to the demand you impose — train heavy low-rep for strength, moderate-rep near failure for hypertrophy.",
    "Volume-intensity-frequency as the dials: hypertrophy responds to weekly hard SETS per muscle; strength responds to intensity (% 1RM) and practice frequency.",
    "Periodization: organize training into phases (accumulation → intensification → deload) rather than max-effort every session; autoregulate with RPE/RIR.",
    "Exercise order & selection: large compound/multi-joint movements first when fresh, isolation after; hit each muscle through a full range of motion.",
    "Recovery IS training: muscle is built between sessions — sleep, protein, and managed fatigue gate progress as much as the work itself.",
  ],
  vocabulary: [
    "1RM — one-rep max; the reference load for setting training percentages.",
    "RPE / RIR — rate of perceived exertion / reps in reserve; RPE 8 ≈ 2 reps left. How you regulate proximity to failure without maxing out daily.",
    "Hypertrophy vs strength — muscle growth (moderate reps, volume, near failure) vs force production (heavy loads, low reps, more rest).",
    "Progressive overload — the systematic increase in training stimulus over time.",
    "Compound vs isolation — multi-joint (squat, press, row) vs single-joint (curl, extension); compounds anchor a session.",
    "Deload — a planned lighter week to shed fatigue and let adaptation catch up.",
    "Time under tension / tempo — controlled eccentric and full ROM that drives the hypertrophy stimulus; don't bounce reps.",
    "Progression model — how load/reps advance (e.g. double progression: add reps to the top of a range, then add load and reset).",
  ],
  benchmarks: [
    "Hypertrophy: ~10–20 hard sets per muscle group per week, mostly in the ~6–15 rep range taken 0–3 reps from failure.",
    "Strength: heavier loads (~80%+ 1RM), lower reps (~1–5), longer rest (~2–5 min) so force output stays high across sets.",
    "Rest between sets: ~1–2 min for isolation/hypertrophy, ~2–5 min for heavy compounds — cutting rest short tanks the working weight.",
    "Frequency: train each muscle ~2× per week to distribute volume — beats once-weekly for both size and strength.",
    "Progression: double-progression — when you hit the top of the rep range on all sets with good form, add load and drop back to the bottom.",
    "Deload roughly every ~4–8 weeks or when performance/recovery stalls; protein ~1.6–2.2 g/kg/day and adequate sleep underpin it (defer detailed macros/medical to the chef/a clinician).",
  ],
  decisionPatterns: [
    "Program to progressive overload and log it — every session should target a measurable beat on the last (load, reps, or quality).",
    "Match rep range and rest to the goal: heavy/low/long-rest for strength, moderate/near-failure/short-rest for size.",
    "Sequence big compounds first while fresh, isolation after; pick movements that let you overload safely through full ROM.",
    "Autoregulate with RPE/RIR — push hard sets close to failure, but bank a rep or two so form and recovery hold.",
    "Watch recovery signals (performance drop, persistent soreness, poor sleep) and deload before a stall becomes a plateau or injury.",
    "Keep it in scope: program training and recovery; hand detailed nutrition/macros to the chef and anything medical/pain to a clinician.",
  ],
  playbooks: [
    "Program build: pick the split (e.g. push/pull/legs or upper/lower), set weekly sets per muscle, choose compound anchors + isolation, define the progression model.",
    "Session log: record load × reps × sets and RPE; flag PRs, progression, or stagnation to inform the next session's target.",
    "Progression check: at range top on all sets → add load and reset reps; stalled 2+ sessions → deload or swap the variation.",
    "Deload week: cut volume/intensity (~40–60%), keep movement patterns, return refreshed to beat prior numbers.",
    "Plateau fix: audit overload (is the log actually going up?), recovery (sleep/protein), and variation before adding random volume.",
  ],
  antiPatterns: [
    "Random workouts with no logging — no progressive overload means no reliable progress; novelty ≠ stimulus.",
    "Ego-lifting with half reps and momentum — cuts range of motion and time under tension, raises injury risk, builds less.",
    "Junk volume: piling on sets well past productive fatigue instead of making the hard sets count.",
    "Training to absolute failure every set — spikes fatigue and stalls recovery; leave a rep or two in reserve most of the time.",
    "Never deloading — accumulated fatigue masks fitness and turns into a plateau or an overuse injury.",
    "Program-hopping every week — no plan runs long enough to overload, so nothing adapts.",
  ],
};
