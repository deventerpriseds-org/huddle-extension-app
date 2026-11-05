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

//   - REMIND  — the user EXPLICITLY asked to be reminded ("Remind me to renew the passport"), or has to GO
//               somewhere ("Go to church", "Go to the mall Saturday") — an alarm. Never for research.
//
// HISTORY (superseded 2026-11-04). REMIND used to be the mode for "the agent can complete nothing here",
// keyed off a `reminder` tag grooming added "when in doubt" and kept forever. Measured on the live queue
// that day: six doable tasks ("Research AI-assisted SDLC practices", "Research someone to install brakes",
// "Research Paper" …) got reminder-only check-ins. The owner: "To have suggested their action be to remind
// me about research or tasks is not the experience I am looking for as it comes off as just kicking down
// the road … I want them to pick up tickets they can realistically finish, end to end." So: a task no
// agent can finish is now left UNASSIGNED by grooming (groom.ts NO_AGENT) and never reaches a check-in at
// all, and REMIND is keyed off the task's own words (asksForReminder), not off a tag a model guessed.
export type TaskMode = "assist" | "produce" | "remind";

// Communication verbs: the agent drafts, the USER sends → assist.
const COMMS_VERBS =
  /^\s*(reply|respond|email|e-mail|message|dm|follow[\s-]?up|reach out|contact|ping)\b/i;
// Physical / relational / personal-action verbs only the USER can perform → assist.
const ASSIST_VERBS =
  /^\s*(go|attend|visit|call|phone|text|meet|see|pray|worship|exercise|work\s?out|walk|run|eat|drink|buy|purchase|order|subscribe|renew|apply|start|pick up|drop off|pay|sign|enroll|enrol|register|take|bring|celebrate|rest|sleep|travel|fly|drive|schedule a|book a)\b/i;

/**
 * True only when the task's OWN words ask for a reminder ("Remind me to renew the passport",
 * "Reminder: call mom", "Set a reminder for the dentist"). The `reminder` tag — and so REMIND mode —
 * exists only for these (owner, 2026-11-04: "I don't need to just be reminded unless I actually say
 * remind me to xxx"). A noun use inside a topic ("Research reminder apps") is not an ask.
 */
const EXPLICIT_REMINDER =
  /^\s*(remind\s+me\b|reminder\s*[:\-–—]|set\s+(a|an)\s+(reminder|alarm)\b)|\bremind\s+me\s+(to|about|of)\b/i;
/**
 * The user's own graded coursework ("📚 Research Paper", "📚 Checkpoint 2 - Details 1 of 2 (MGT-702)",
 * "Obtain MGT-782 Module 3 materials"). Owner, 2026-11-05: "coursework shouldn't be assigned to the agents.
 * the router should know that during grooming." Keyed on the Nexus 📚 marker or a course code like MGT-702.
 */
// A bare code like "UA-123", "DS-160" or "ABC-123" is NOT enough (VERIFY-wip-e2e-pickup-fit-1 C4 found
// "Book UA-123 flight", "Complete DS-160 visa form", "Fix the ABC-123 bug" all wrongly unassigned). A code
// counts only when it is in brackets — how Nexus writes it, "(MGT-702)" — or next to a course word.
const COURSE_CODE_SRC = "[A-Za-z]{2,5}[- ]?\\d{3,4}";
const COURSE_CODE_IN_BRACKETS = new RegExp(`\\(\\s*${COURSE_CODE_SRC}[^)]*\\)`);
const COURSE_WORDS =
  "module|seminar|checkpoint|assignment|residency|research paper|paper|course|class|lecture|syllabus|discussion|quiz|exam|midterm|homework|materials|case study|capstone";
const COURSE_CODE_NEAR_WORD = new RegExp(
  `\\b${COURSE_CODE_SRC}\\b[^.]{0,40}\\b(${COURSE_WORDS})\\b|\\b(${COURSE_WORDS})\\b[^.]{0,40}\\b${COURSE_CODE_SRC}\\b`,
  "i",
);
export function isCoursework(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  return t.startsWith("📚") || COURSE_CODE_IN_BRACKETS.test(t) || COURSE_CODE_NEAR_WORD.test(t);
}

export function asksForReminder(title: string | null | undefined): boolean {
  return EXPLICIT_REMINDER.test(title ?? "");
}

/**
 * Somewhere the user has to GO ("Go to church", "Go to the mall Saturday", "Attend the open house",
 * "Pick up the dry cleaning"). The owner, 2026-11-04: "another instance where suggesting to remind me
 * with an alarm is okay is when i say i need to go somewhere, like church or the mall on saturday, but
 * still not research etc." Title-initial only, so "Research mall hours" stays research.
 */
const GOING_SOMEWHERE = /^\s*(go|head|attend|visit|drive|travel|fly|pick up|drop off)\b/i;
/** An alarm is the right proposal: the user asked to be reminded, or has to be somewhere. Never for research. */
export function alarmFits(title: string | null | undefined): boolean {
  return asksForReminder(title) || GOING_SOMEWHERE.test(title ?? "");
}
// Deliverable verbs an agent can produce for the user to consume → produce.
const PRODUCE_VERBS =
  /^\s*(research|find|compile|draft|write|design|build|develop|create|plan|outline|prepare|analy[sz]e|review|layout|architect|map|summar[iy][sz]e|explore|investigate|assemble|lock|transfer|migrate|configure|scope|spec|sketch)\b/i;

/**
 * Work an agent can always finish itself (research, find, compare, draft …), judged on the title's own
 * verb. Grooming's "none" (nobody can finish it) is overruled for these: measured 2026-11-04, the first
 * pass under the new rule unassigned "Research harness engineering best practices for Claude Code" and
 * "Research authentic writing practices for Winston AI review". Owner: "Research is one of the things it
 * should be able to just do as an ai llm strength."
 */
export function isAgentWork(title: string | null | undefined): boolean {
  return PRODUCE_VERBS.test(title ?? "") || /^\s*compare\b/i.test(title ?? "");
}

/**
 * The board chip for a task that explicitly asks to be reminded. groom.ts groomTags DERIVES it from the
 * title on every pass (asksForReminder) — it is never taken from the model and never preserved, so a
 * stale tag from the old "agent can finish nothing" rule is stripped at the next grooming.
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

  // An explicit "remind me" in the task's own words outranks every verb heuristic. The `reminder` TAG no
  // longer decides anything here: a tag grooming added under the old "when in doubt" rule must not keep a
  // research task in reminder-only mode until the next grooming pass strips it.
  if (alarmFits(title)) return "remind";

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
  // Shared by all three modes (owner, 2026-11-04): agents take tickets they can FINISH, end to end, with
  // as little support from the user as possible. A reminder offered in place of work reads as "kicking
  // it down the road", so it is never an acceptable substitute — only for a task that asks for one.
  const finishIt =
    `Propose only what you can realistically FINISH yourself, end to end, with as little help from the ` +
    `user as possible. Never offer a reminder in place of doing the work. Any comparison of options ` +
    `(products, plans, courses, providers) always includes reviews and forum feedback, not just the ` +
    `vendor's own pages. When the work depends on facts only the user has (company specifics, their own ` +
    `data): if you can still produce something genuinely useful with reasonable confidence, do it and ` +
    `deliver it as "Here's what I was able to do", followed by "Here are my questions to fully satisfy ` +
    `what you may want" (short, specific questions). Only if you could not produce anything credible ` +
    `without those facts, ask for them first. Never present guesses about their company as findings.`;
  if (mode === "remind") {
    return (
      `MODE — REMIND: the user explicitly asked to be reminded about this, or it is somewhere they need ` +
      `to GO (church, the mall, an appointment). Propose an ALARM with a specific day and time you ` +
      `suggest — for a place, early enough before they need to leave — picked from the task and what you ` +
      `know of their week (do not ask an open "when works?"). The Definition of Done is the alarm itself: ` +
      `"an alarm is set for Saturday 10am." If there is legwork you can finish that makes the moment ` +
      `easier (opening hours, the address, travel time, the exact link, the price), include it and say ` +
      `you'll put it on the card. Do NOT ` +
      `invent a deliverable, and do NOT promise to "verify", "confirm", "prepare" or "reconstruct" ` +
      `anything that would require information they have not given you.\n` +
      finishIt
    );
  }
  if (mode === "assist") {
    return (
      `MODE — ASSIST: the final act here is the USER's (they subscribe, sign up, buy, attend, call, ` +
      `start). Your job is all the legwork that gets them there with the least effort — NOT a document ` +
      `about the task, and NOT a reminder. Propose the concrete legwork you will finish, e.g. find the ` +
      `exact subscription or sign-up link and the plan options and put them on the card; compare the ` +
      `courses, products or providers including reviews and forum feedback; find where to buy and the ` +
      `price; draft the message for them to send. The Definition of Done is that legwork, saved to the ` +
      `card ("the Aha! plan options and the subscription link are on the card", "a comparison of three ` +
      `courses with reviews is on the card"). If there is truly no legwork you can finish, say so in one ` +
      `line rather than offering a reminder.\n` +
      finishIt
    );
  }
  return (
    `MODE — PRODUCE: this is knowledge-work you can complete FOR the user — research, finding, ` +
    `comparing, drafting, outlining, planning. Research is your strength: just do it. Propose the ` +
    `concrete deliverable (a brief, plan, analysis, comparison, draft, or design) and a testable ` +
    `Definition of Done for it. If it is really something only the user can do, propose the legwork you ` +
    `can finish for them instead (the link, the options, the draft) — never a reminder.\n` +
    finishIt
  );
}
