// WHAT:       One PROPOSAL row inside the EXISTING in-chat checklist (HuddleView ChecklistCard): a to-do found
//             in email / Teams / a meeting, with Approve, Edit, Mark done and Dismiss.
// WHY:        AC docs/ac/AC-correspondence-checklist.md section 5: proposals are a second row KIND in the same
//             card, not a second widget. Same contract as ChecklistItem: optimistic setChecklistRow -> server
//             -> rollbackChecklistRow on failure, one write in flight per row (`busy`), 44px touch targets.
//             Actions go to actOnProposalFn, NEVER to updateBoardTask (AC-5.3).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-task-proposals.md.
import { useState } from "react";
import { Check, ChevronDown, Loader2, Pencil, X, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { actOnProposalFn } from "../lib/proposals/proposals.functions";
import type { ChecklistRow } from "../data/seed";
import { useHuddleStore, type ChecklistRowState } from "../store";

const STATE_LABEL: Record<string, string> = {
  proposed: "Proposed",
  approved: "Added to board",
  completed: "Marked done",
  dismissed: "Dismissed",
};

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
}

export function ProposalChecklistItem({
  row,
  live,
  caller,
}: {
  row: ChecklistRow;
  live?: ChecklistRowState;
  caller?: { entra_object_id?: string; entra_email?: string };
}) {
  const signedOut = !caller?.entra_email;
  const info = row.proposal;
  const state = live?.status ?? info?.state ?? "proposed";
  const title = live?.title ?? row.title;
  const busy = live?.busy ?? false;
  const open = state === "proposed";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  async function act(action: "approve" | "complete" | "dismiss" | "edit", nextTitle?: string) {
    const store = useHuddleStore.getState();
    const before: ChecklistRowState = store.checklistState[row.taskId] ?? { status: state, tags: [] };
    if (before.busy) return; // one in-flight write per row
    const optimistic =
      action === "edit"
        ? { title: nextTitle }
        : { status: action === "approve" ? "approved" : action === "complete" ? "completed" : "dismissed" };
    store.setChecklistRow(row.taskId, { ...optimistic, busy: true });
    try {
      const r = await actOnProposalFn({ data: { caller, id: row.taskId, action, ...(nextTitle !== undefined ? { title: nextTitle } : {}) } });
      if (r.row) {
        // Server truth wins, including when another device already decided it (AC-5.6).
        if (r.row.taskId) store.seedChecklistRows([{ taskId: r.row.taskId, status: "BACKLOG", tags: [] }]);
        store.setChecklistRow(row.taskId, { status: r.row.state, title: r.row.title, linkedTaskId: r.row.taskId, busy: false });
      } else if (!r.ok) {
        store.rollbackChecklistRow(row.taskId, before);
      }
      if (!r.ok) {
        toast.error(r.error || "Couldn't update that proposal.");
        return;
      }
      if (!r.row) store.setChecklistRow(row.taskId, { busy: false });
      if (r.alreadyOnBoard || r.note) toast(r.note ?? "It was already on your board.");
    } catch (err) {
      store.rollbackChecklistRow(row.taskId, before);
      toast.error(err instanceof Error ? err.message : "Couldn't update that proposal.");
    }
  }

  function saveEdit() {
    const t = draft.trim();
    setEditing(false);
    if (!t || t === title) return;
    void act("edit", t);
  }

  const meta = [
    info?.sourceLabel,
    shortDate(info?.at),
    info?.dueDate ? `due ${shortDate(info.dueDate)}` : info?.dueText ? info.dueText : "",
    info?.assignee ?? "",
  ].filter(Boolean);

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        aria-label={`Approve "${title}" — add it to your board`}
        disabled={!open || busy || signedOut}
        onClick={() => act("approve")}
        className="-my-3 -ml-3 flex size-11 shrink-0 items-center justify-center disabled:opacity-50"
      >
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded border border-dashed transition",
            open ? "border-foreground/40 hover:border-foreground/70" : "border-transparent bg-muted text-muted-foreground",
          )}
        >
          {!open && <Check size={11} strokeWidth={3} />}
        </span>
      </button>

      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            aria-label="Edit proposed task"
            value={draft}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-full rounded border border-hairline bg-background px-1.5 py-0.5 text-[13px]"
          />
        ) : (
          <span
            className={cn("block truncate text-[13px] leading-snug", open ? "text-foreground" : "text-muted-foreground line-through")}
            title={info?.evidence ? `“${info.evidence}”` : title}
          >
            {title}
          </span>
        )}
        <span className="block truncate text-[10px] text-muted-foreground">
          {open ? meta.join(" · ") : STATE_LABEL[state] ?? state}
        </span>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!open || busy || signedOut}>
          <button
            type="button"
            aria-label={`Proposal: ${STATE_LABEL[state] ?? state}. Actions for "${title}"`}
            className="-my-2.5 inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-md border border-dashed border-hairline bg-muted px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-secondary disabled:opacity-50"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <span>{open ? "Proposed" : STATE_LABEL[state] ?? state}</span>}
            <ChevronDown size={9} className="opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => act("approve")}>
            <Check size={12} className="mr-2" /> Approve
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setDraft(title);
              setEditing(true);
            }}
          >
            <Pencil size={12} className="mr-2" /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => act("complete")}>
            <CheckCheck size={12} className="mr-2" /> Mark done
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => act("dismiss")}>
            <X size={12} className="mr-2" /> Dismiss
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
