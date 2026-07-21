// Deterministic task-prioritization scoring — ported from journey-voice's
// src/lib/schedulingCandidates.ts (scoreSchedulingCandidate / selectSchedulingCandidates /
// explainSchedulingScore). Pure TypeScript, no external deps, so it runs self-contained in
// Huddle over the Azure-PG mirror (supabase-independent). Weights are journey's "as a start";
// extend here as needed. Keep behavior aligned with journey until intentionally diverged.

export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

/** The subset of the mirrored journey task a scorer needs. */
export interface ScorableTask {
  id: string;
  title: string;
  status: string | null;
  priority: TaskPriority;
  category: string | null;
  is_priority: boolean;
  priority_rank: number | null;
  due_date: string | null;
  pushed_count: number | null;
  created_at: string;
  completed_at: string | null;
  assigned_agent?: string | null;
  tags?: string[] | null;
  is_scheduled?: boolean | null;
  start_time?: string | null;
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

const PRIORITY_KEYWORDS = {
  financial: ["payment", "invoice", "bill", "tax", "budget", "contract", "financial", "money", "pay", "credit", "transfer", "fee"],
  comms: ["email", "follow up", "follow-up", "respond", "reply", "call", "meeting", "text", "message", "contact", "coach"],
};

export function normalizeTaskTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hasSchedulingPriorityKeyword(title: string): boolean {
  const lower = title.toLowerCase();
  return [...PRIORITY_KEYWORDS.financial, ...PRIORITY_KEYWORDS.comms].some((kw) => lower.includes(kw));
}

export function isDueSoon(dueDate?: string | null, hoursThreshold = 48): boolean {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  const cutoff = new Date(Date.now() + hoursThreshold * 60 * 60 * 1000);
  return due <= cutoff;
}

export function scoreTask(task: ScorableTask, targetDate: Date = new Date()): number {
  let score = PRIORITY_WEIGHT[task.priority] || 1;

  if (task.is_priority) score += 10 + Math.max(5 - (task.priority_rank ?? 0), 0);

  if (task.pushed_count && task.pushed_count > 0) {
    const n = task.pushed_count;
    if (n <= 3) score += 1;
    else if (n <= 7) {
      /* neutral */
    } else if (!task.is_priority) score -= 1;
  }

  if (isDueSoon(task.due_date)) score += 5;

  if (task.due_date) {
    const dueDate = new Date(task.due_date);
    const twoDaysOut = new Date(targetDate.getTime() + 2 * 24 * 60 * 60 * 1000);
    const sevenDaysOut = new Date(targetDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (dueDate > twoDaysOut && dueDate <= sevenDaysOut) score += 3;
    // Keep important-but-old work competitive so it isn't buried below the view limit — mirrors
    // journey's scheduler/explain. Priority-lane and HIGH/URGENT skip the staleness penalty.
    const isImportant = task.is_priority || task.priority === "HIGH" || task.priority === "URGENT";
    if (!isImportant) {
      if (dueDate < thirtyDaysAgo) score -= 10;
      else if (dueDate < fourteenDaysAgo) score -= 3;
    }
  }

  const daysSinceCreated = (Date.now() - new Date(task.created_at).getTime()) / (24 * 60 * 60 * 1000);
  if (daysSinceCreated <= 3) score += 2;
  else if (daysSinceCreated <= 7) score += 1;

  if (hasSchedulingPriorityKeyword(task.title)) score += 5;
  if (task.status === "UP_NEXT") score += 1;

  return Math.max(score, 0);
}

/** One-line human explanation of the dominant scoring factors, for the tool output. */
export function explainScore(task: ScorableTask): string {
  const parts: string[] = [];
  if (task.is_priority) parts.push(`on the priority lane (rank ${task.priority_rank ?? "?"})`);
  if (isDueSoon(task.due_date)) parts.push("due within 48h");
  else if (task.due_date) {
    const d = new Date(task.due_date);
    if (d < new Date()) parts.push("overdue");
    else parts.push(`due ${d.toISOString().slice(0, 10)}`);
  }
  if (task.priority === "URGENT" || task.priority === "HIGH") parts.push(`${task.priority.toLowerCase()} priority`);
  if (hasSchedulingPriorityKeyword(task.title)) parts.push("money/comms sensitive");
  return parts.join(", ") || "baseline";
}

export interface RankedTask {
  id: string;
  title: string;
  category: string | null;
  status: string | null;
  due_date: string | null;
  is_scheduled: boolean | null;
  start_time: string | null;
  score: number;
  why: string;
}

/**
 * Rank open tasks (not DONE/BLOCKED, not completed) by the scoring above, applying journey's
 * tiebreaker (explicit priority → priority_rank → score → due_date NULLS LAST) and title dedup.
 */
export function rankTasks(tasks: ScorableTask[], limit = 25): RankedTask[] {
  const seen = new Set<string>();
  return tasks
    .filter((t) => t.status !== "DONE" && t.status !== "BLOCKED")
    .filter((t) => !t.completed_at)
    .map((t) => ({ t, score: scoreTask(t) }))
    .sort((a, b) => {
      const aPri = a.t.is_priority ? 1 : 0;
      const bPri = b.t.is_priority ? 1 : 0;
      if (aPri !== bPri) return bPri - aPri;
      if (aPri && bPri) {
        const aRank = a.t.priority_rank ?? 9999;
        const bRank = b.t.priority_rank ?? 9999;
        if (aRank !== bRank) return aRank - bRank;
      }
      if (b.score !== a.score) return b.score - a.score;
      if (a.t.due_date && b.t.due_date) return new Date(a.t.due_date).getTime() - new Date(b.t.due_date).getTime();
      if (a.t.due_date) return -1;
      if (b.t.due_date) return 1;
      return 0;
    })
    .filter(({ t }) => {
      const norm = normalizeTaskTitle(t.title);
      if (seen.has(norm)) return false;
      seen.add(norm);
      return true;
    })
    .slice(0, limit)
    .map(({ t, score }) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      status: t.status,
      due_date: t.due_date,
      is_scheduled: t.is_scheduled ?? null,
      start_time: t.start_time ?? null,
      score,
      why: explainScore(t),
    }));
}
