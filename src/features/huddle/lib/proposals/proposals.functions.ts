// WHAT:       Client-callable server functions behind the proposal rows of the in-chat checklist: one read for
//             a mounted checklist's proposal rows, and one action endpoint (approve / complete / dismiss / edit).
// WHY:        AC docs/ac/AC-correspondence-checklist.md AC-5.3 (proposal actions NEVER go through
//             updateBoardTask), AC-5.6 (a mounted checklist reconciles from the proposal store), AC-5.24 (one
//             request for all rows). Ownership is enforced server-side by every store query (AC-5.4).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-task-proposals.md.
//
// Server modules are imported dynamically so pg / server-only deps never reach the client bundle (the
// board.functions.ts pattern).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();
const PropId = z.string().regex(/^prop-[0-9a-f]{1,32}$/);

/** The live state of a mounted checklist's proposal rows (one request, AC-5.24). */
export interface ProposalRowState {
  id: string;
  state: "proposed" | "approved" | "completed" | "dismissed" | "untriaged" | "delegated";
  title: string;
  taskId: string | null;
  /** Meeting triage, For someone: the typed name (text only). */
  assignee?: string | null;
}

export const getProposalStatesFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, ids: z.array(PropId).max(500) }).parse(raw))
  .handler(async ({ data }): Promise<{ rows: ProposalRowState[] }> => {
    try {
      const { getProposalRows } = await import("./proposals.server");
      const rows = await getProposalRows(data.caller, data.ids);
      return { rows: rows.map((r) => ({ id: r.id, state: r.state, title: r.title, taskId: r.taskId, ...(r.state === "delegated" ? { assignee: r.assignee } : {}) })) };
    } catch {
      return { rows: [] };
    }
  });

export const actOnProposalFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        id: PropId,
        action: z.enum(["approve", "complete", "dismiss", "edit", "triage"]),
        title: z.string().max(400).optional(),
        // Meeting triage (AC-correspondence-redesign R5.8): Mine / For someone (+ a typed name) / Skip.
        choice: z.enum(["mine", "someone", "skip"]).optional(),
        name: z.string().max(400).optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; row?: ProposalRowState; alreadyDone?: boolean; alreadyOnBoard?: boolean; note?: string }> => {
    try {
      const { actOnProposal } = await import("./proposals.server");
      const r = await actOnProposal(data.caller, data.id, data.action, data.title, data.choice ? { choice: data.choice, name: data.name } : undefined);
      const row = r.row
        ? { id: r.row.id, state: r.row.state, title: r.row.title, taskId: r.row.taskId, ...(r.row.state === "delegated" ? { assignee: r.row.assignee } : {}) }
        : undefined;
      if (!r.ok) return { ok: false, error: r.error, row };
      return { ok: true, row, alreadyDone: r.alreadyDone, alreadyOnBoard: r.alreadyOnBoard, note: r.note };
    } catch {
      return { ok: false, error: "Couldn't update that proposal." };
    }
  });
