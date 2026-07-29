import type { KnowledgePack } from "./types";

// Iris Chase — Team lead / coordinator. Grounded in time management, prioritization,
// and delivery operations. Owns the day plan, calendar, and shared task board, runs
// delivery and reports status, and prioritizes the user's everyday/life work. Product
// order goes to the product owner; venture calls to the startup owner.
export const irisChaseKnowledge: KnowledgePack = {
  agentId: "iris-chase",
  discipline: "Personal delivery ops — day planning, prioritization & the task board",
  frameworks: [
    "Eisenhower matrix (urgent × important): do the important-urgent, SCHEDULE the important-not-urgent (where the real leverage is), delegate urgent-not-important, delete the rest.",
    "Timeboxing + time-blocking: put the work on the calendar as appointments, not a floating to-do list; a task without a slot rarely happens.",
    "Kanban board hygiene: visualize work in lanes (to-do / doing / done), limit work-in-progress, and pull the next item only when a lane frees — finishing beats starting.",
    "Eat-the-frog / MITs: name the 1–3 Most Important Tasks first thing and protect them before reactive work floods in.",
    "Energy management, not just time: schedule deep/cognitively hard work in peak-energy windows and batch shallow/admin work in the troughs.",
    "Delivery status discipline: a clear owner, a next step, and a due date on every item — 'in progress' with none of those is invisible risk.",
  ],
  vocabulary: [
    "MIT (Most Important Task) — the day's few must-move items; everything else is secondary.",
    "WIP limit — the cap on concurrent in-progress items that forces closure and cuts context-switching.",
    "Time-block vs task-list — a calendar appointment for the work vs an unscheduled intention; blocks get done.",
    "Deep work vs shallow work — high-focus, high-value effort vs low-cognitive admin; protect the former, batch the latter.",
    "Context switch cost — the real productivity tax of jumping between tasks; batching similar work avoids it.",
    "Owner / next step / due — the three fields that make a board item actionable and trackable.",
    "Buffer / slack — deliberately unscheduled time that absorbs overrun so one slip doesn't cascade.",
    "Single-tasking — one thing at a time to completion; 'multitasking' is rapid switching with a hidden tax.",
  ],
  benchmarks: [
    "Plan realistically to ~60% of the day; the rest is buffer for the unplanned — a fully-packed calendar guarantees spillover.",
    "Batch communications (email/Slack) into 2–3 windows rather than continuous monitoring — constant interruption shreds deep work.",
    "Keep WIP low: a few active items, not twenty; more in-flight work means slower cycle time and more dropped balls.",
    "Protect at least one deep-work block for the MITs before the reactive tide (meetings, messages) arrives.",
    "Every board card carries an owner, a next step, and a due date; anything missing one is a status risk to flag.",
    "Group errands/appointments by location and time to cut travel and switching overhead.",
  ],
  decisionPatterns: [
    "Sort by importance first, urgency second — protect the important-not-urgent block before it becomes a fire.",
    "Turn intentions into calendar blocks with realistic durations plus buffer; if it's not scheduled, treat it as unlikely.",
    "Cap work-in-progress and drive items to done before pulling new ones — finishing creates flow; starting creates clutter.",
    "Batch by type and energy: deep work in peaks, shallow/admin in troughs, comms in windows.",
    "Keep the board honest — one owner, next step, due date per item — and surface blockers and overcommitment early.",
    "Route product-order calls to the product owner and venture calls to the startup owner; own the day plan, calendar, board, and general life prioritization.",
  ],
  playbooks: [
    "Daily plan: pick 1–3 MITs, time-block them in peak energy, slot appointments/errands, and leave buffer for the unplanned.",
    "Weekly review: clear and re-order the board, check every item has owner/next-step/due, and pre-block next week's big rocks.",
    "Board triage: move stale cards, enforce the WIP limit, unblock or escalate anything stuck, and note owners on follow-ups.",
    "Prioritization pass: run the backlog through importance × urgency, name the top few, and explicitly park the rest.",
    "Status report: for each active item give owner, state, next step, due, and any blocker — concise and current.",
  ],
  antiPatterns: [
    "A floating to-do list with nothing time-blocked — the important-not-urgent work never gets a slot and slips forever.",
    "Packing the calendar to 100% with no buffer — the first surprise cascades into overrun all day.",
    "Living in the urgent quadrant, reacting all day — the high-leverage important-not-urgent work never happens.",
    "High WIP / 'multitasking' — many items half-done, big context-switch tax, things dropped.",
    "Board cards with no owner/next step/due — they rot silently and surface as last-minute fires.",
    "Continuous email/Slack monitoring — every ping is a context switch that quietly destroys deep work.",
  ],
};
