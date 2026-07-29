import type { KnowledgePack } from "./types";

// Elle Rowan — EMBA planner. Grounded in adult-learning science, academic writing,
// and deadline/workload management for a working executive doing an MBA. Keeps
// coursework, essays, and application deadlines on track — a structured coach.
export const elleRowanKnowledge: KnowledgePack = {
  agentId: "elle-rowan",
  discipline: "Executive-MBA planning, academic writing & application strategy",
  frameworks: [
    "Backward planning from the deadline: decompose every deliverable into milestones with buffer, and schedule backward so the due date is never the first time you look at the whole.",
    "Spaced practice + retrieval + interleaving (evidence-based learning science): distributed study beats cramming; self-testing beats re-reading; mixing topics beats blocking.",
    "The essay/argument spine: thesis → structured argument → evidence → 'so what'. Every paragraph earns its place by advancing the thesis (topic sentence first).",
    "Application narrative arc: goals (short + long) → why-now → why-this-program → what you bring; a coherent, specific story beats a list of achievements.",
    "Eisenhower / MoSCoW triage for a working exec: protect deep-work blocks for the important-not-urgent (the thesis, the big case) before it becomes urgent.",
    "Rubric-first work: read the grading rubric BEFORE writing, and map the draft to each criterion — points live in the rubric, not in effort.",
  ],
  vocabulary: [
    "Thesis statement — the one-sentence claim the whole piece defends; if you can't state it, the essay isn't ready to write.",
    "Topic sentence — the first sentence of a paragraph that states its point and ties to the thesis.",
    "Signposting — explicit transitions that tell the reader the structure ('First… Consequently… However…').",
    "Literature review — the synthesis of prior work that situates your argument; synthesize, don't summarize serially.",
    "Citation style (APA/Chicago) — the required reference format; consistency and attribution avoid plagiarism and lost marks.",
    "Deliverable vs milestone — the graded artifact vs the checkpoints that de-risk finishing it on time.",
    "Cohort / cracked cadence — the fixed rhythm of an EMBA (residencies, modules); plan work around the immovable calendar.",
    "STAR / leadership essay — application and reflection essays that want a concrete story with your specific action and result.",
  ],
  benchmarks: [
    "Start major deliverables at ~2× your estimated writing time before the deadline — first drafts always run long and life intervenes for a working exec.",
    "Study in focused ~25–50 min blocks with breaks (Pomodoro-style); distributed sessions across days beat one marathon for retention.",
    "Essay drafting: outline → messy first draft → revise for argument → line-edit last. Never line-edit a draft whose argument isn't settled.",
    "Applications: submit in the earliest viable round when possible — later rounds compete for fewer seats.",
    "Reserve a fixed weekly deep-work block for the highest-stakes work (thesis/capstone) and defend it like a client meeting.",
    "Leave a 1–2 day buffer before every hard deadline for formatting, citations, and a final read-aloud pass.",
  ],
  decisionPatterns: [
    "Read the rubric/prompt first, then reverse-plan milestones with buffer; the deadline is an output of the plan, not the plan.",
    "Protect deep work for the cognitively hard, high-stakes items; batch shallow tasks (readings, admin) into low-energy windows.",
    "Draft ugly, revise structured: get the argument down before polishing sentences — editing a blank page is impossible.",
    "For applications, lead with a specific, coherent narrative and tailor every essay to that program's values and the prompt.",
    "Triage under overload: cut scope to protect the highest-weight deliverables rather than doing everything at 70%.",
  ],
  playbooks: [
    "Term plan: map every deliverable and residency onto one calendar, back-plan milestones, and set weekly targets with buffer.",
    "Essay pipeline: prompt + rubric → thesis → outline → first draft → argument revision → line edit → citations → read-aloud.",
    "Application plan: define goals/why-now/why-program, draft the core narrative, tailor per-school essays, and sequence deadlines by round.",
    "Study system: convert readings into retrieval practice (self-quiz, summaries from memory), space sessions, interleave subjects.",
    "Deadline triage: when the week is overloaded, rank by weight × proximity, protect the top items, and renegotiate or descope the rest.",
  ],
  antiPatterns: [
    "Starting a major essay the night before — no time for the argument-revision pass that actually earns the grade.",
    "Re-reading highlights and calling it studying — passive review feels productive but retrieval practice is what sticks.",
    "Writing before reading the rubric — effort pointed at things the grader isn't scoring.",
    "A generic application essay reused across schools — it reads as low interest and loses to specific, tailored narratives.",
    "Line-editing a draft whose thesis is still unsettled — polishing sentences you'll delete.",
    "Booking every hour with no buffer — one slipped deadline cascades across the whole term.",
  ],
};
