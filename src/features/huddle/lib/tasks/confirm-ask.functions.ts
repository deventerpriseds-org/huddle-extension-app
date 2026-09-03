import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Deterministic server actions behind the confirm-ask button row (Confirm/Backlog/Archive) — NO model/
// agent-turn involvement at all, which is the whole point: free-text confirmation/edit parsing is
// unreliable in practice, so these three common actions bypass NLU entirely. Mirrors board.functions.ts's
// updateBoardTask (a createServerFn calling invokeJourneyTool directly), extended with an ownership check
// board.functions.ts itself does NOT do — task.journey_tasks / task.task_engagement_state have no
// per-row access control below this layer, so a forged/guessed taskId must be rejected HERE.

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

async function resolveCallerEmail(caller: z.infer<typeof Caller>): Promise<string | null> {
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller?.entra_email ?? null;
}

type ButtonResult = { ok: boolean; error?: string; alreadyDone?: boolean };

/**
 * THE confirm-intent/DoD gate's one server-authoritative unlock. Extracted from
 * `confirmTaskFromButtonFn` (its only caller until now) so the VOICE surface can ratify a confirm ask
 * WITHOUT a second implementation of a safety gate — the exact way this gate leaked before
 * (memory.md 2026-08-05: the gate was ON and 8 unconfirmed tasks still reached review).
 *
 * Everything that makes it fail CLOSED lives here and is therefore identical on every surface:
 *  - OWNERSHIP: `getOwnedTaskForConfirmAsk` returns null for a task that does not exist OR is not the
 *    caller's — indistinguishably, so a guessed id cannot be used to probe.
 *  - PROPOSAL REQUIRED: with no `proposed_dod` there is nothing to ratify and it REFUSES. An agent
 *    cannot manufacture a confirmation for a task the user was never asked about.
 *  - SERVER TEXT WINS: the confirmed DoD is the server's own recorded proposal, never text supplied by
 *    a caller/model. `additions` (a spoken correction) is APPENDED to it, clearly attributed — it can
 *    never replace it.
 *  - IDEMPOTENT: an already-confirmed task returns `alreadyDone` and re-writes nothing.
 *  - REMIND MODE: confirming IS the scheduling, from the STRUCTURED `proposed_reminder_at`.
 */
export async function confirmTaskFromProposal(opts: {
  caller: z.infer<typeof Caller>;
  taskId: string;
  email: string;
  /** Optional spoken/typed correction, appended to the SERVER's proposal. Never a replacement. */
  additions?: string;
}): Promise<ButtonResult & { taskId?: string; title?: string; definitionOfDone?: string }> {
  const { caller, taskId, email } = opts;
  try {
    const { getOwnedTaskForConfirmAsk, confirmTaskIntent } = await import("./tasks.server");
    const task = await getOwnedTaskForConfirmAsk(taskId, email);
    // Deliberately the SAME error for "doesn't exist" and "not yours" — see getOwnedTaskForConfirmAsk.
    if (!task) return { ok: false, error: "Task not found." };
    if (task.confirm_status === "confirmed") return { ok: true, alreadyDone: true, taskId, title: task.title };
    // Read the proposed DoD from the SERVER's own record, never from whatever text the client echoes
    // back — the client's copy could be stale if the task moved on via a different reach-out/session.
    if (!task.proposed_dod) {
      return { ok: false, error: "No proposed plan found for this reach-out — it may be stale." };
    }
    const additions = (opts.additions ?? "").trim();
    const dod = additions
      ? `${task.proposed_dod}\n\nAdded when the user confirmed: ${additions.slice(0, 500)}`
      : task.proposed_dod;
    await confirmTaskIntent(taskId, email, dod);

    // REMIND mode: confirming IS the scheduling. This has to happen HERE, in the shared core, not in
    // any one caller — this path is deliberately model-free (see the header), so wiring the reminder
    // into only one surface would make a Confirm look successful while scheduling nothing, and the
    // task would drop back to the backlog silently. That is precisely the leak the reminder flow
    // exists to close, and it is why the voice path calls this function instead of its own copy.
    //
    // Scheduled from the STRUCTURED proposed_reminder_at, never by parsing a date out of the DoD text.
    // Non-fatal by design: the confirmation above is already durable, so a reminder failure degrades
    // to "confirmed but not scheduled" (reported back) rather than losing the user's confirmation.
    let reminderNote: string | undefined;
    const isRemind = (task.tags ?? []).some((t) => String(t).toLowerCase() === "reminder");
    if (isRemind && task.proposed_reminder_at) {
      const dueMs = Date.parse(task.proposed_reminder_at);
      if (Number.isFinite(dueMs) && dueMs > Date.now()) {
        try {
          const { createReminder } = await import("./turns.server");
          await createReminder({
            // Deterministic id keyed on the task + instant, so a double-tap or a retry can never
            // schedule the same nudge twice (the insert simply conflicts).
            id: `taskremind-${taskId}-${Math.floor(dueMs / 1000)}`,
            userEmail: email,
            huddleId: task.assigned_agent ? `dm-${task.assigned_agent}` : "all-members",
            agentId: task.assigned_agent,
            text: task.title.slice(0, 300),
            kind: "reminder",
            dueAtMs: dueMs,
            taskId,
          });
        } catch {
          reminderNote = "Confirmed, but the reminder couldn't be scheduled — ask me to set it again.";
        }
      } else {
        reminderNote = "Confirmed, but that reminder time has already passed — tell me a new one.";
      }
    }

    const { invokeJourneyTool } = await import("../journey/proxy.functions");
    const r = await invokeJourneyTool({
      toolName: "update_task",
      args: {
        task_id: taskId,
        definition_of_done: dod,
        // A confirmed reminder task goes back to BACKLOG: the agent isn't working it, so it must not
        // sit in UP_NEXT holding a WIP slot. The reminder window keeps it out of automation until the
        // nudge fires (taskIdsInReminderWindow), so "back to backlog" is a rest state, not a demotion.
        ...(isRemind && !reminderNote ? { status: "BACKLOG" } : {}),
      },
      caller: caller ?? {},
      context: { source: "huddle" },
    });
    if (reminderNote) return { ok: true, error: reminderNote, taskId, title: task.title, definitionOfDone: dod };
    // Huddle's own confirm_status is already durable even if the journey mirror write fails — same
    // non-fatal posture as the model's confirm_task_intent tool handler.
    return {
      ok: true,
      error: r.ok ? undefined : `Confirmed, but journey write failed: ${r.error ?? ""}`,
      taskId,
      title: task.title,
      definitionOfDone: dod,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const confirmTaskFromButtonFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, taskId: z.string().min(1) }).parse(raw),
  )
  .handler(async ({ data }): Promise<ButtonResult> => {
    const email = await resolveCallerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    // The whole body of this handler now lives in confirmTaskFromProposal above, shared with the
    // voice executor. Behaviour is unchanged: the button passes no `additions`.
    const r = await confirmTaskFromProposal({ caller: data.caller, taskId: data.taskId, email });
    return { ok: r.ok, error: r.error, alreadyDone: r.alreadyDone };
  });

export const backlogTaskFromButtonFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, taskId: z.string().min(1) }).parse(raw),
  )
  .handler(async ({ data }): Promise<ButtonResult> => {
    const email = await resolveCallerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    try {
      const { getOwnedTaskForConfirmAsk } = await import("./tasks.server");
      const task = await getOwnedTaskForConfirmAsk(data.taskId, email);
      if (!task) return { ok: false, error: "Task not found." };
      if (task.status === "BACKLOG") return { ok: true, alreadyDone: true };
      const { invokeJourneyTool } = await import("../journey/proxy.functions");
      const r = await invokeJourneyTool({
        toolName: "update_task",
        args: { task_id: data.taskId, status: "BACKLOG" },
        caller: data.caller ?? {},
        context: { source: "huddle" },
      });
      return { ok: r.ok, error: r.error ?? undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const parkTaskFromButtonFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, taskId: z.string().min(1) }).parse(raw),
  )
  .handler(async ({ data }): Promise<ButtonResult> => {
    const email = await resolveCallerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    try {
      const { getOwnedTaskForConfirmAsk } = await import("./tasks.server");
      const task = await getOwnedTaskForConfirmAsk(data.taskId, email);
      if (!task) return { ok: false, error: "Task not found." };
      const existingTags = task.tags ?? [];
      const alreadyParked = task.status === "BACKLOG" && existingTags.includes("parking-lot");
      if (alreadyParked) return { ok: true, alreadyDone: true };
      // update_task REPLACES the tags array (board.functions.ts's updateBoardTask comment), so this must
      // send the FULL desired set (existing + parking-lot), never just the one tag being added.
      const tags = existingTags.includes("parking-lot")
        ? existingTags
        : [...existingTags, "parking-lot"];
      const { invokeJourneyTool } = await import("../journey/proxy.functions");
      const r = await invokeJourneyTool({
        toolName: "update_task",
        args: { task_id: data.taskId, status: "BACKLOG", tags },
        caller: data.caller ?? {},
        context: { source: "huddle" },
      });
      return { ok: r.ok, error: r.error ?? undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
