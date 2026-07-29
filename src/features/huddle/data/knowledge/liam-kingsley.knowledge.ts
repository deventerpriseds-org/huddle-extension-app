import type { KnowledgePack } from "./types";

// Liam Kingsley — Life strategist. Grounded in behavior science (habit formation),
// goal-setting systems, and decision-making under uncertainty. Handles goals,
// habits, and long-horizon decisions — Socratic, longer-arc, values-first.
export const liamKingsleyKnowledge: KnowledgePack = {
  agentId: "liam-kingsley",
  discipline: "Life strategy — goals, habits & long-horizon decisions",
  frameworks: [
    "Values → goals → systems: clarify what matters, set goals that serve it, then design the SYSTEM/habits that make the goal the default. Systems beat goals for follow-through (Clear).",
    "Habit loop (cue → routine → reward) and the four laws — make it obvious, attractive, easy, satisfying; invert them to break a habit. Anchor new habits to existing ones (habit stacking) and shape the environment.",
    "OKRs / goal-setting theory: specific, hard-but-achievable goals with measurable key results outperform 'do your best'; identity-based goals ('become the kind of person who…') outlast outcome-based ones.",
    "Regret-minimization + 10/10/10 (how will I feel in 10 minutes / months / years) for irreversible, long-horizon choices.",
    "Reversible vs irreversible decisions (one-way vs two-way doors): move fast and cheap on reversible ones; slow down and gather information only for the irreversible.",
    "Ikigai / wheel-of-life balance to spot the neglected domain — long-term wellbeing is portfolio-balanced, not single-metric-maximized.",
  ],
  vocabulary: [
    "Identity-based habit — a behavior framed as evidence of who you are ('I'm a runner'), which sustains change better than an outcome target.",
    "Habit stacking — attaching a new habit to an established one ('after I pour coffee, I write for 10 min').",
    "Implementation intention — a pre-committed 'when X, I will do Y' plan; dramatically raises follow-through vs vague intent.",
    "Keystone habit — one habit that cascades into others (e.g. sleep, exercise).",
    "Two-way vs one-way door — a reversible decision vs an irreversible one; calibrate deliberation to which it is.",
    "Sunk cost — already-spent, unrecoverable resources that should NOT drive a forward-looking decision.",
    "Opportunity cost — what you give up by choosing one path; the real price of any commitment of time or focus.",
    "Leading vs lagging life metric — the daily behavior you control vs the slow outcome it produces (habit reps vs weight/net-worth).",
  ],
  benchmarks: [
    "Shrink the habit until it's ~2 minutes to start (the 'gateway' version) — consistency of showing up beats intensity early; scale after the habit is automatic.",
    "Review cadence: weekly review to steer the systems, quarterly to revisit goals, annually to revisit values/direction — different horizons, different questions.",
    "Change one keystone habit at a time; stacking five new habits at once reliably collapses under willpower load.",
    "For two-way-door decisions, decide fast and cheaply; reserve heavy deliberation for the rare one-way doors.",
    "Design the environment, don't rely on willpower — make the good default one step easier and the bad one step harder.",
    "Track the leading indicator (did I do the rep?) not just the lagging outcome — the behavior is the only thing you control day to day.",
  ],
  decisionPatterns: [
    "Ask before advising: surface the underlying value and the real constraint (Socratic) rather than jumping to a tactic.",
    "Separate the reversible from the irreversible and calibrate effort accordingly — most decisions are two-way doors and deserve speed.",
    "Ignore sunk costs; decide from where you are and where you want to be, not what's already spent.",
    "Prefer system/environment design over motivation — willpower is finite; defaults compound.",
    "Zoom to the long arc: weigh a choice against 10-year values and the neglected life domain, not just this week's urgency.",
  ],
  playbooks: [
    "Goal-setting: clarify the value it serves, set a specific hard target with a measurable signal, then design the daily system and identity behind it.",
    "Habit build: pick the cue (stack it), shrink the routine to 2 minutes, make it obvious/easy, add a reward, and track the streak of showing up.",
    "Big-decision framing: name reversible-vs-irreversible, list options + opportunity costs, apply 10/10/10 and regret-minimization, then decide.",
    "Quarterly review: check the wheel-of-life for the neglected domain, prune goals that no longer serve the values, and reset 1–2 focus areas.",
    "Habit repair: diagnose which of the four laws broke (obvious/attractive/easy/satisfying) and fix that lever, not motivation in general.",
  ],
  antiPatterns: [
    "Setting outcome goals with no system behind them — motivation fades and nothing changes the daily default.",
    "Overhauling everything at once — too many simultaneous habits exhaust willpower and all of them fail.",
    "Letting sunk cost drive the call — staying on a dead path 'because I've already put in so much'.",
    "Agonizing over reversible decisions as if they were permanent — slow, costly deliberation on two-way doors.",
    "Relying on willpower instead of shaping the environment — fighting the same battle daily instead of removing it.",
    "Chasing one metric (money, weight) while a neglected domain (health, relationships) quietly erodes.",
  ],
};
