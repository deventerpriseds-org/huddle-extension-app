// Assist/produce router — classifies HOW an agent contributes to a task and shapes the confirm-intent
// ask so the user confirms a concrete assumption instead of explaining from scratch ("confirm, not
// explain"). An agent never does a task INSTEAD of the user — it's always in service of them, in one of
// two modes:
//   - ASSIST  — the user completes the task; the agent reminds / drafts / preps (e.g. "Go to church" →
//               set an 11am reminder; "Reply to DBA email" → draft the reply for the user to send).
//   - PRODUCE — the agent completes it and the OUTPUT is what the user consumes (e.g. "Research X" → a
//               brief the user reads).
// Both modes still route through the confirm-intent gate → review, so a MIS-classification here is caught
// by the user's confirmation (the mode hint explicitly tells the agent to propose the other mode if this
// one is wrong). Data-driven off the task's title verb + category + tags — no per-task hardcoding.

//   - REMIND  — the agent can complete NOTHING here on its own. The task needs facts, access, or a
//               physical/financial act only the user has ("Order replacement tire" — it doesn't know the
//               car or the tire size; "Investigate Veridian transfer issues" — it cannot reach those
//               records). Its honest contribution is the FOLLOW-UP, so the task isn't dropped.
//
// REMIND exists because the alternative is what shipped: with no way to say "I can't do this", an agent
// handed such a task invented a deliverable that silently depended on the user supplying everything —
// "I'll verify the tire specification", "I'll reconstruct the transaction details from available
// records". The user's words for the result: "they are just overreaching in things I would have to do
// and give them which makes it me doing it not them."
//
// REMIND is a DEFAULT, never a verdict. It flows through the SAME queue, the same UP_NEXT lane and the
// same confirm-ask as every other task — it is not a separate path. The user can answer "no, actually
// research it" and it becomes produce. That direction matters: guessing REMIND wrongly costs one
// correcting message, while guessing PRODUCE wrongly costs an invented deliverable and a task that
// jams. Cheapest-honest-action first, escalation on request.
export type TaskMode = "assist" | "produce" | "remind";

// Communication verbs: the agent drafts, the USER sends → assist.
const COMMS_VERBS =
  /^\s*(reply|respond|email|e-mail|message|dm|follow[\s-]?up|reach out|contact|ping)\b/i;
// Physical / relational / personal-action verbs only the USER can perform → assist.
const ASSIST_VERBS =
  /^\s*(go|attend|visit|call|phone|text|meet|see|pray|worship|exercise|work\s?out|walk|run|eat|drink|buy|purchase|pick up|drop off|pay|sign|enroll|enrol|register|take|bring|celebrate|rest|sleep|travel|fly|drive|schedule a|book a)\b/i;
// Deliverable verbs an agent can produce for the user to consume → produce.
const PRODUCE_VERBS =
  /^\s*(research|find|compile|draft|write|design|build|develop|create|plan|outline|prepare|analy[sz]e|review|layout|architect|map|summar[iy][sz]e|explore|investigate|assemble|lock|transfer|migrate|configure|scope|spec|sketch)\b/i;

/**
 * The board tag grooming writes when an agent can finish NOTHING on this task alone. A plain tag, so it
 * renders as a chip on the card for free, is filterable, and the user can remove it to escalate the task
 * back to real work — same mechanism as `parking-lot`, no new lane and no parallel classifier.
 * MUST also be listed in groom.ts's CONTROL_TAGS or the next grooming pass deletes it.
 */
export const REMINDER_TAG = "reminder";

// Category / tag signals that lean personal (the user acts) when no verb decides it.
const PERSONAL_CATEGORIES = new Set(["LIFE", "PERSONAL", "HEALTH"]);
const PERSONAL_TAGS = new Set([
  "family", "personal", "health", "errand", "chore", "social", "spiritual", "life", "fitness",
]);

export function classifyTaskMode(task: {
  title?: string | null;
  category?: string | null;
  tags?: string[] | null;
}): TaskMode {
  const title = (task.title ?? "").trim();
  const tags = (task.tags ?? []).map((t) => String(t).toLowerCase());
  const cat = (task.category ?? "").toUpperCase();

  // The `reminder` tag OUTRANKS every verb heuristic — deliberately, and this order is load-bearing.
  // The tag is an explicit decision written by grooming (and correctable by the user in the UI), whereas
  // the verb lists are a guess. Checking verbs first would silently discard it: "Update LinkedIn
  // profile", "Apply to Trinnex" and "Order replacement tire" all miss every verb list and fall through
  // to the PRODUCE default below, which is exactly how agents ended up promising work they cannot do.
  if (tags.includes(REMINDER_TAG)) return "remind";

  // Verb in the title is the strongest signal, in priority order.
  if (COMMS_VERBS.test(title)) return "assist";
  if (PRODUCE_VERBS.test(title)) return "produce";
  if (ASSIST_VERBS.test(title)) return "assist";

  // No decisive verb → lean on the task's own category/tags.
  if (PERSONAL_CATEGORIES.has(cat) || tags.some((t) => PERSONAL_TAGS.has(t))) return "assist";

  // Default: an assigned task with no personal signal is knowledge-work the agent can produce.
  return "produce";
}

// A short hint appended to the confirm-intent directive so the agent proposes the RIGHT kind of assumed
// action + Definition of Done for the mode — and, crucially, self-corrects if the mode is wrong (the
// user's confirmation is the final catch). NOT a per-task script.
export function modeProposalHint(mode: TaskMode): string {
  if (mode === "remind") {
    return (
      `MODE — REMIND: you cannot complete any part of this yourself. It needs facts, access, or an act ` +
      `only the user has. Do NOT invent a deliverable, do NOT promise to "verify", "confirm", "prepare" ` +
      `or "reconstruct" anything that would require information they have not given you, and do NOT ` +
      `hand them a plan for YOU to do it. Your contribution is the FOLLOW-UP so this isn't dropped.\n` +
      `Propose exactly one thing: WHEN to remind them, with a specific day and time you suggest (pick a ` +
      `sensible one from the task and what you know of their week — do not ask an open "when works?"). ` +
      `The Definition of Done is the reminder itself: "a reminder is set for Saturday 10am." Say in one ` +
      `line why you can't take it further — the specific thing only they can supply or do — so the ` +
      `hand-off is honest rather than a silent dependency.\n` +
      `If you are WRONG and you genuinely could produce something real with only what you already have, ` +
      `say so and propose that deliverable instead — their answer settles it. Being corrected here is ` +
      `expected and cheap; over-promising is not.`
    );
  }
  if (mode === "assist") {
    return (
      `MODE — ASSIST: this looks like something the USER does themselves, so your job is to help them do ` +
      `it, NOT to produce a document about it. Propose the concrete assist you'd provide — e.g. set a ` +
      `reminder at a specific time, draft a message for them to send, or prep the options they'll choose ` +
      `from — and a Definition of Done that matches ("a reminder is set for 11am", "a draft reply is ready ` +
      `for you to send"). Do NOT propose "I'll research/produce a document" for an assist task. If you ` +
      `actually think this needs a real deliverable, say so and propose that instead — let the user's ` +
      `answer settle it.`
    );
  }
  return (
    `MODE — PRODUCE: this looks like knowledge-work you can complete FOR the user to consume. Propose the ` +
    `concrete deliverable you'd produce (a brief, plan, analysis, draft, or design) and a testable ` +
    `Definition of Done for it. If it's really something only the user can do (an assist), say so and ` +
    `propose the assist — reminder/draft/prep — instead, and let the user's answer settle it.`
  );
}
