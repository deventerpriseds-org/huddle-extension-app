// WHAT:       The Outlook-label AUTO-TASK pass, every I/O injected: a stored email whose `categories` match the owner's
//             "Outlook labels that create a task" list becomes ONE board task with no click and no model call, through
//             the EXISTING proposal store (ProposalStore.upsert / priorRelated) and the EXISTING approveProposal.
// WHY:        Owner request 2026-11-28 ("tasks from the file that have a category of 'needs action' should
//             automatically be processed to tasks without waiting [for] me"). Contract:
//             docs/qc-evidence/AC-actions-label-autotask.md sections 3, 4, 6 (outcome table O-1..O-13).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-actions-label-autotask.md; scripts/actions-view.test.ts section LAT.
//
// LOGS ARE PUBLIC-SAFE: this module never logs text. It returns COUNTS and kind codes (autotask:*) only.
//
// Rules this module holds (each is a test in actions-view.test.ts LAT):
//  - no model call: there is no extract dependency at all (AC-3.8);
//  - creation ONLY through approveProposal, proposals ONLY through ProposalStore.upsert (AC-3.14);
//  - once per email: a persisted record (ledger result_ids.autotask) marks it done; a later label removal or re-add
//    never re-creates, edits or deletes anything (AC-3.18..3.20);
//  - any DECIDED proposal referencing this email (or its thread's verdict proposal), any title, stops it (AC-3.21);
//  - the board read happens ONCE per pass, and a FAILED board read creates nothing (fail CLOSED, AC-3.28);
//  - at most AUTO_TASK_MAX_ATTEMPTS failed attempts, persisted, then it stops and stays listed (AC-3.27);
//  - `status` is never read (section 4).

import type { ActionVerdict } from "../correspondence/action-classify";
import { matchedAutoTaskLabel, labelTaskTitle } from "../correspondence/email-labels";
import { approveProposal, type ApproveDeps } from "../proposals/engine";
import { proposalId, sanitizeTitle, titleKey, type ProposalStore, type ProposalState } from "../proposals/proposals";

/** AC-3.27 (safe default): failed auto attempts per email before the auto path stops. Persisted. */
export const AUTO_TASK_MAX_ATTEMPTS = 5;
/** AC-P2 (safe default): at most this many createTask calls (approves) per pass; the rest wait for the next pass. */
export const AUTO_TASK_PER_PASS = 10;
/** AC-3.16: the label proposal's evidence (the origin marker shown to the owner; never presented as an AI quote). */
export const LABEL_EVIDENCE_PREFIX = "Outlook label: ";

/** The persisted per-email record (chat.correspondence_ledger.result_ids.autotask). */
export interface AutoTaskRecord {
  /** The proposal this email's label resolved to (created here, or reused). */
  proposalId: string | null;
  /** Failed auto attempts so far (AC-3.26/3.27). */
  attempts: number;
  /** Terminal: the auto path never touches this email again (created, already on board, decided, meta guard). */
  done: boolean;
  /** Terminal after AUTO_TASK_MAX_ATTEMPTS failures (AC-3.27). */
  gaveUp?: boolean;
  /** Kind code of the last outcome (never text). */
  outcome: AutoTaskOutcome;
}

export type AutoTaskOutcome =
  | "created"
  | "on_board"
  | "decided"
  | "meta_guard"
  | "create_failed"
  | "board_read_failed"
  | "store_failed"
  | "gave_up"
  /** Written BEFORE the create (record-then-act, RTL-4); a crash mid-create reads as one used attempt. */
  | "attempting";

/** One stored email row the pass may act on (source 'email', content not purged). */
export interface LabelEmailRow {
  sourceItemId: string;
  subject: string | null;
  at: string | null;
  /** content.categories as stored (the matcher reads ONLY this). */
  categories: unknown;
  /** result_ids.autotask as stored, or null. */
  record: AutoTaskRecord | null;
  /** The thread this email belongs to in the Actions plan, when it is in the window. */
  thread?: {
    /** The conversation key (the needs-you judge's proposal ref). */
    conversationKey: string | null;
    /** The thread's CURRENT stored verdict (verdictIsCurrent), or null. */
    verdict: Pick<ActionVerdict, "status" | "todo" | "proposalId" | "onBoard"> | null;
  };
}

export interface LabelAutoTaskDeps {
  store: ProposalStore;
  /** The owner's open board tasks (approveProposal's ApproveDeps.openTasks). Throws on failure. Called ONCE per pass. */
  openTasks: ApproveDeps["openTasks"];
  /** The EXISTING journey create (approveProposal's ApproveDeps.createTask). */
  createTask: ApproveDeps["createTask"];
  metaGuard?: ApproveDeps["metaGuard"];
  /** Persist the per-email record (result_ids.autotask). Throws on failure. */
  saveRecord(sourceItemId: string, r: AutoTaskRecord): Promise<void>;
}

export interface LabelAutoTaskResult {
  matched: number;
  created: number;
  onBoard: number;
  decided: number;
  metaGuard: number;
  failed: number;
  gaveUp: number;
  skippedDone: number;
  deferred: number;
  /** Kind codes of failures, e.g. "autotask:board_read_failed" (counts only, never text). */
  kinds: Record<string, number>;
}

const DECIDED: ReadonlySet<ProposalState | string> = new Set(["approved", "completed", "dismissed", "delegated"]);

/** Pure (AC-3.27 + red-team RTL-3): a record the auto path never touches again -- done, gave up, OR already at the
 *  attempt cap (a record written without the gaveUp flag, e.g. by an older writer, still stops at the cap). */
export function recordIsTerminal(r: AutoTaskRecord | null | undefined): boolean {
  return !!r && (r.done || r.gaveUp === true || r.attempts >= AUTO_TASK_MAX_ATTEMPTS);
}

/** Pure: the label task title for a row (AC-3.9 / 3.10): the CURRENT open verdict's to-do, else the stripped subject. */
export function rowTaskTitle(r: Pick<LabelEmailRow, "subject" | "thread">): string {
  const v = r.thread?.verdict;
  const todo = v && v.status === "open" ? v.todo ?? null : null;
  return sanitizeTitle(labelTaskTitle(r.subject, todo)).trim() || labelTaskTitle(null);
}

/**
 * The pass. `labels` = the resolved autoTaskLabels setting ([] = off, AC-3.2). Never throws for one email: each email
 * is isolated (AC-3.31); a failure is counted by kind and retried next pass, bounded by AUTO_TASK_MAX_ATTEMPTS.
 */
export async function runLabelAutoTask(owner: string, owners: string[], rows: readonly LabelEmailRow[], labels: readonly string[], deps: LabelAutoTaskDeps): Promise<LabelAutoTaskResult> {
  const res: LabelAutoTaskResult = { matched: 0, created: 0, onBoard: 0, decided: 0, metaGuard: 0, failed: 0, gaveUp: 0, skippedDone: 0, deferred: 0, kinds: {} };
  if (!labels.length) return res;
  const todo: { row: LabelEmailRow; label: string }[] = [];
  for (const row of rows) {
    const label = matchedAutoTaskLabel(row.categories, labels);
    if (!label) continue;
    res.matched++;
    if (recordIsTerminal(row.record)) {
      res.skippedDone++;
      continue;
    }
    todo.push({ row, label });
  }
  if (!todo.length) return res;

  // AC-3.28: ONE board read per pass; a failed read creates NOTHING this pass (fail closed: no human in the loop).
  let board: Array<{ id: string; title: string }> | null = null;
  try {
    board = await deps.openTasks();
  } catch {
    board = null;
  }

  const save = async (row: LabelEmailRow, r: AutoTaskRecord) => {
    await deps.saveRecord(row.sourceItemId, r).catch(() => {
      res.kinds["autotask:record_failed"] = (res.kinds["autotask:record_failed"] ?? 0) + 1;
    });
  };
  const fail = async (row: LabelEmailRow, kind: AutoTaskOutcome, pid: string | null) => {
    const attempts = (row.record?.attempts ?? 0) + 1;
    const gaveUp = attempts >= AUTO_TASK_MAX_ATTEMPTS;
    res.failed++;
    res.kinds[`autotask:${kind}`] = (res.kinds[`autotask:${kind}`] ?? 0) + 1;
    if (gaveUp) {
      res.gaveUp++;
      res.kinds["autotask:gave_up"] = (res.kinds["autotask:gave_up"] ?? 0) + 1;
    }
    await save(row, { proposalId: pid ?? row.record?.proposalId ?? null, attempts, done: false, ...(gaveUp ? { gaveUp: true } : {}), outcome: gaveUp ? "gave_up" : kind });
  };
  const finish = async (row: LabelEmailRow, outcome: AutoTaskOutcome, pid: string | null) => {
    await save(row, { proposalId: pid, attempts: row.record?.attempts ?? 0, done: true, outcome });
  };

  let approvals = 0;
  for (const { row, label } of todo) {
    if (approvals >= AUTO_TASK_PER_PASS) {
      res.deferred++;
      continue;
    }
    try {
      const title = rowTaskTitle(row);
      const normTitle = titleKey(title);
      const ref = { source: "email" as const, sourceItemId: row.sourceItemId };
      // ── Which proposal? (AC-3.11 reuse, AC-3.21 decided across titles) ──
      let pid: string | null = null;
      const v = row.thread?.verdict ?? null;
      if (v?.onBoard === true) {
        res.onBoard++;
        await finish(row, "on_board", null);
        continue;
      }
      if (v?.proposalId) {
        const [p] = await deps.store.getMany(owners, [v.proposalId]);
        if (p && DECIDED.has(p.state)) {
          res.decided++;
          await finish(row, "decided", p.id);
          continue;
        }
        if (p && p.state === "proposed") pid = p.id;
      }
      if (!pid) {
        // Every proposal that references THIS email (any title, any origin) -- and the needs-you judge's conversation
        // ref -- plus a dismissal of the same to-do elsewhere (F15). Any decided one stops the auto path.
        const refs = [ref, ...(row.thread?.conversationKey ? [{ source: "email" as const, sourceItemId: row.thread.conversationKey }] : [])];
        const prior = (await Promise.all(refs.map((r) => deps.store.priorRelated(owners, r, normTitle)))).flat();
        const decided = prior.find((p) => DECIDED.has(p.state) && (p.sameItem || p.normTitle === normTitle));
        if (decided) {
          res.decided++;
          await finish(row, "decided", decided.id);
          continue;
        }
        const open = prior.find((p) => p.sameItem && p.state === "proposed");
        if (open) pid = open.id;
      }
      if (!pid) {
        try {
          const up = await deps.store.upsert({
            id: proposalId(owner, ref, normTitle),
            owner,
            title,
            normTitle,
            evidence: `${LABEL_EVIDENCE_PREFIX}${label}`.slice(0, 400),
            assignee: null,
            dueText: null,
            dueDate: null,
            ref: { ...ref, at: row.at, context: String(row.subject ?? "").slice(0, 160) || null },
          });
          pid = up.id;
        } catch {
          await fail(row, "store_failed", null);
          continue;
        }
      }
      if (!board) {
        await fail(row, "board_read_failed", pid);
        continue;
      }
      // RTL-4 (record-then-act, the classify pass's recordCall pattern): persist THIS attempt BEFORE the create, so the
      // AUTO_TASK_MAX_ATTEMPTS cap holds even when the create then fails. If the record cannot be written, NO create
      // this pass (never swallow the write error into a create); the email stays retryable and nothing is lost.
      const nextAttempts = (row.record?.attempts ?? 0) + 1;
      try {
        await deps.saveRecord(row.sourceItemId, { proposalId: pid, attempts: nextAttempts, done: false, outcome: "attempting" });
      } catch {
        res.failed++;
        res.kinds["autotask:record_failed"] = (res.kinds["autotask:record_failed"] ?? 0) + 1;
        continue;
      }
      approvals++;
      const cached = board;
      const r = await approveProposal(owners, pid, { store: deps.store, openTasks: async () => cached, createTask: deps.createTask, ...(deps.metaGuard ? { metaGuard: deps.metaGuard } : {}) });
      if (r.ok) {
        if (r.alreadyDone) {
          res.decided++;
          await finish(row, "decided", pid);
        } else if (r.alreadyOnBoard) {
          res.onBoard++;
          await finish(row, "on_board", pid);
        } else {
          res.created++;
          // AC-6.3: a second labelled email in the same pass sees the task just created.
          board.push({ id: r.row.taskId ?? `new:${pid}`, title: r.row.title });
          await finish(row, "created", pid);
        }
        continue;
      }
      if (r.error.startsWith("Not added:")) {
        // AC-3.15: the meta-task guard is terminal; the proposal stays proposed and listed for the owner.
        res.metaGuard++;
        await finish(row, "meta_guard", pid);
        continue;
      }
      if (r.row && r.row.state === "proposed" && /already being approved/.test(r.error)) {
        // AC-3.23: another pass holds the lease; the loser records no failure.
        res.deferred++;
        continue;
      }
      await fail(row, "create_failed", pid);
    } catch {
      await fail(row, "store_failed", row.record?.proposalId ?? null);
    }
  }
  return res;
}

/** Pure: a stored result_ids.autotask value -> a record, or null when absent / malformed. */
export function readAutoTaskRecord(raw: unknown): AutoTaskRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const attempts = typeof o.attempts === "number" && Number.isFinite(o.attempts) && o.attempts >= 0 ? Math.floor(o.attempts) : 0;
  return {
    proposalId: typeof o.proposalId === "string" && o.proposalId ? o.proposalId : null,
    attempts,
    done: o.done === true,
    ...(o.gaveUp === true ? { gaveUp: true } : {}),
    outcome: typeof o.outcome === "string" ? (o.outcome as AutoTaskOutcome) : "create_failed",
  };
}

/** Pure (AC-3.25): how many stored labelled emails a pass would try to task (no done / gave-up record). */
export function wouldAutoTaskCount(rows: readonly Pick<LabelEmailRow, "categories" | "record">[], labels: readonly string[]): number {
  if (!labels.length) return 0;
  return rows.filter((r) => matchedAutoTaskLabel(r.categories, labels) && !recordIsTerminal(r.record)).length;
}
