import type { KnowledgePack } from "./types";

// Cole Blake — Career coach. Grounded in evidence-based career development,
// performance/promotion mechanics, and structured interview prep. Coaches growth,
// reviews, and interviews — not finance, health, or day scheduling.
export const coleBlakeKnowledge: KnowledgePack = {
  agentId: "cole-blake",
  discipline: "Career development, performance & interviewing",
  frameworks: [
    "STAR (Situation, Task, Action, Result) for behavioral interview answers and self-reviews — lead with context, own the Action ('I', not 'we'), and quantify the Result.",
    "Impact = scope × complexity × autonomy: promotions reward operating at the NEXT level's scope BEFORE the title, not tenure. Show you're already doing the job.",
    "SMART goals (specific, measurable, achievable, relevant, time-bound) for development plans and review objectives.",
    "The skill/will and situational-leadership lens for growth conversations — match support to whether the gap is capability or motivation.",
    "Sponsorship vs mentorship: mentors advise you, sponsors spend their capital ON you in rooms you're not in. Career acceleration needs sponsors, not just mentors.",
    "The 'brag doc' / impact journal: a running, evidence-based record of accomplishments with metrics — the antidote to recency bias at review time.",
  ],
  vocabulary: [
    "Behavioral vs situational interview — 'tell me about a time' (past behavior) vs 'what would you do' (hypothetical); STAR fits the former.",
    "Calibration — the cross-manager meeting where ratings/promotions are normalized; your manager must defend your case with evidence there.",
    "Promotion packet / case — the written evidence that you're already operating at the next level (scope, impact, peer feedback).",
    "Competency / leveling rubric — the ladder defining what each level looks like; map your evidence to it explicitly.",
    "Managing up — proactively giving your manager the context, visibility, and asks they need to advocate for you.",
    "Total comp — base + bonus + equity; evaluate offers on the whole package and vesting, not base alone.",
    "BATNA — best alternative to a negotiated agreement; your leverage in any comp/offer negotiation is your walk-away.",
    "Radical candor / SBI feedback — care personally + challenge directly; deliver feedback as Situation-Behavior-Impact, not character judgments.",
  ],
  benchmarks: [
    "Promotion is earned by demonstrating next-level scope for ~1–2 review cycles first; build the case continuously, don't spring it at review time.",
    "Interview prep: 6–10 STAR stories covering leadership, conflict, failure, impact, and ambiguity — reusable across most behavioral questions.",
    "Salary negotiation: name a researched range anchored to market data; the first counter after an offer typically has real room — silence is a tool.",
    "1:1 cadence: weekly or biweekly with your manager; own the agenda, bring blockers and wins, don't let it become pure status.",
    "Feedback ratio: specific and timely beats saved-up; deliver close to the event, privately for corrective, publicly for recognition.",
    "Resume: reverse-chronological, impact bullets as 'accomplished X measured by Y by doing Z', one page per ~10 years, tuned to the target role's keywords.",
  ],
  decisionPatterns: [
    "Anchor every claim to evidence and a metric — 'led the migration that cut latency 40%' beats 'strong technical leader'.",
    "Diagnose before advising: is this a skill gap, a visibility gap, a sponsorship gap, or a fit gap? Each has a different fix.",
    "Optimize for scope and learning rate over title/comp early; compounding skills and sponsors pay more over a career than a marginal raise.",
    "Prep interviews to the rubric: map your stories to the competencies the role screens for, and rehearse out loud, not just on paper.",
    "In negotiation, get the offer in writing, never accept on the spot, and negotiate the whole package (equity, sign-on, start date), not just base.",
  ],
  playbooks: [
    "Promotion case: map current work to the next level's rubric line by line, collect peer/stakeholder evidence, and arm your manager for calibration.",
    "Interview prep: build the STAR story bank, research the company/role/interviewers, prepare sharp questions, and run a mock with out-loud reps.",
    "Performance review: draft a self-review from the brag doc (metrics-first), pre-align with your manager, and set 2–3 SMART goals for next cycle.",
    "Development plan: pick 1–2 high-leverage skills, define observable success, find a stretch project + a sponsor, and review progress in 1:1s.",
    "Offer/negotiation: gather market comp data, set your BATNA, counter once thoughtfully on the full package, and confirm terms in writing.",
  ],
  antiPatterns: [
    "Waiting until review season to 'make the case' — with no running evidence, the story loses to recency bias and better-documented peers.",
    "'We did X' throughout an interview — the panel can't tell what YOU did; own your specific Action.",
    "Accepting the first number on the spot — you leave equity/sign-on/base on the table and signal you don't negotiate.",
    "Chasing titles over scope — a bigger title with no real scope stalls the next move and reads as inflated.",
    "Confusing mentors with sponsors — collecting advice while no one is spending capital to advance you.",
    "Feedback saved for the annual review — stale, un-actionable, and it erodes trust; give it close to the moment.",
  ],
};
