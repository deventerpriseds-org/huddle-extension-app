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

// ---- OWNER OVERRIDE of an escalated approach gate ------------------------------------------------

export type OverrideSource =
  /** A click in the app. No quote: the click IS the user act, and no model was involved in it. */
  | { via: "button" }
  /** A model relayed the owner's words. The server must LOCATE them before honouring anything. */
  | { via: "quote"; quote: string };

export type OverrideResult = ButtonResult & {
  taskId?: string;
  title?: string;
  /** true when the refusal was specifically "that quote isn't the owner's" — the caller (an agent)
   *  should ask the user to click the button rather than retry with a different guess. */
  quoteRejected?: boolean;
};

/**
 * THE ONE PLACE an escalated approach gate is overridden, shared by the button and the tool exactly
 * the way `confirmTaskFromProposal` is shared by the button and the voice executor — for the same
 * reason: a safety gate with two implementations is a safety gate that leaks through the one nobody
 * re-read (memory.md 2026-08-05, the gate was ON and 8 unconfirmed tasks still reached review).
 *
 * Everything that makes it safe lives here, so it is identical on every surface:
 *  - OWNERSHIP: `getOwnedTaskForConfirmAsk` — a task that doesn't exist and a task that isn't yours
 *    return the SAME error, so a guessed id cannot probe.
 *  - ESCALATED ONLY: it refuses on any other status. Approving a `pending` task would skip the grader
 *    entirely, which is not "unstick a dead end", it is "bypass the whole approach gate".
 *  - THE OWNER'S WORDS ARE VERIFIED, NOT TRUSTED: for `via:'quote'` the quote must be found in a real,
 *    recent user turn. This is the owner's own anti-self-override condition and the whole reason a
 *    model may call this at all.
 *  - IDEMPOTENT FROM PERSISTED STATE, not from the turn ledger: `turnActionLedger` is per-turn and
 *    in-memory, so it cannot dedupe two clicks seconds apart in different turns. The status read (and
 *    the `WHERE approach_status='escalated'` on the write) is what does.
 *  - ATTRIBUTED TO THE USER: the actor recorded is the resolved caller email. Never an agentId.
 *  - NEVER SWALLOWED: a DB failure returns `{ok:false}`. Reporting "unstuck" about a task that is
 *    still stuck is worse than reporting the error.
 */
export async function overrideEscalatedApproach(opts: {
  taskId: string;
  email: string;
  source: OverrideSource;
}): Promise<OverrideResult> {
  const { taskId, email, source } = opts;
  try {
    const { getOwnedTaskForConfirmAsk, getTaskEngagementState, overrideApproachGate } =
      await import("./tasks.server");
    const task = await getOwnedTaskForConfirmAsk(taskId, email);
    if (!task) return { ok: false, error: "Task not found." };
    if ((task.status ?? "").toUpperCase() === "DONE") {
      return { ok: false, error: "That task is already done — there's nothing to unstick.", taskId, title: task.title };
    }

    const state = await getTaskEngagementState(taskId).catch(() => null);
    const status = state?.approach_status ?? "pending";
    if (status === "approved") {
      // Covers BOTH "already overridden" (a second click) and "the grader passed it in between".
      // Either way the task is not stuck, nothing is written, and no second audit record is appended.
      return { ok: true, alreadyDone: true, taskId, title: task.title };
    }
    if (status !== "escalated") {
      // Includes the reassignment case, which is CORRECT and must not be "fixed" by loosening this:
      // `resetEngagementOnReassignment` puts the row back to 'pending' because the new assignee never
      // proposed the approach the owner was overriding. Approving on their behalf recreates the exact
      // inheritance bug that reset exists to prevent — so say what happened instead.
      return {
        ok: false,
        error:
          "That task isn't waiting on your approval — its approach gate is at “pending”. If it changed " +
          "hands, the new assignee starts the approach fresh and will come back to you.",
        taskId,
        title: task.title,
      };
    }

    let quote: string | null = null;
    let sourceTurnId: string | null = null;
    if (source.via === "quote") {
      const { verifyOwnerQuote, QUOTE_MAX_AGE_MS, QUOTE_MIN_WORDS } = await import("./approach-override");
      const { getRecentUserUtterances } = await import("./turns.server");
      const now = Date.now();

      // WHEN this task escalated. The words that authorise an override have to come AFTER it — a
      // sentence typed before the gate ever escalated cannot be consenting to an override of it, and
      // that one rule kills most of the "any long fragment of anything they said" attack class.
      // `approach_escalated_at` is stamped by escalateApproach; a row that escalated before that
      // column existed falls back to its own updated_at, which is later (stricter), never earlier.
      const escalatedAtMs = Date.parse(state?.approach_escalated_at ?? state?.updated_at ?? "");
      if (!Number.isFinite(escalatedAtMs)) {
        // FAIL CLOSED: with no floor there is nothing to order the authorisation against. The button
        // still works — a click is the user act and needs no quote at all.
        return {
          ok: false,
          quoteRejected: true,
          error:
            "I can't tell when this task's approach gate escalated, so I can't verify the user's words " +
            "authorise overriding it. They can approve it with the Approve anyway button.",
          taskId,
          title: task.title,
        };
      }

      // The weakest of the three bindings — "they said it in this agent's DM" — is only unambiguous
      // while that agent has exactly ONE escalated task. Any doubt, INCLUDING a failed read, disables
      // it (the other two bindings, task id and task title, are unaffected).
      let assigneeBindingUnambiguous = false;
      const assignedAgent = task.assigned_agent ?? null;
      if (assignedAgent) {
        try {
          const { getEscalatedTaskIdsForAgent } = await import("./tasks.server");
          const escalatedForAgent = await getEscalatedTaskIdsForAgent(email, assignedAgent);
          assigneeBindingUnambiguous =
            escalatedForAgent.length === 1 && escalatedForAgent[0] === taskId;
        } catch {
          assigneeBindingUnambiguous = false;
        }
      }

      const utterances = await getRecentUserUtterances(email, now - QUOTE_MAX_AGE_MS);
      const verdict = verifyOwnerQuote(source.quote ?? "", utterances, now, {
        taskId,
        taskTitle: task.title ?? "",
        assignedAgent,
        escalatedAtMs,
        assigneeBindingUnambiguous,
      });
      if (!verdict.ok) {
        const REASONS: Record<string, string> = {
          "too-short": `Quote too short to authorise an override — it needs to be at least ${QUOTE_MIN_WORDS} words of what the user actually said.`,
          "not-found":
            "I couldn't find those words in anything the user said recently, so I can't treat that as their authorisation. Ask them to say it here, or to use the Approve anyway button.",
          "predates-escalation":
            "The user did say that, but before this task's approach gate escalated — so it wasn't about this. Ask them now, or they can use the Approve anyway button.",
          "not-consent":
            "The user did say those words, but read in full the sentence isn't them telling you to proceed. Ask them plainly, or they can use the Approve anyway button.",
          "not-this-task":
            "I can't tell that the user was authorising THIS task — ask them to name it, or they can use the Approve anyway button on the task itself.",
        };
        return {
          ok: false,
          quoteRejected: true,
          error: REASONS[verdict.reason] ?? REASONS["not-found"],
          taskId,
          title: task.title,
        };
      }
      quote = source.quote;
      sourceTurnId = verdict.turnId;
    }

    const applied = await overrideApproachGate({ taskId, userEmail: email, via: source.via, quote, sourceTurnId });
    // Not applied = the row stopped being 'escalated' between the read above and this write (a second
    // click, or the grader landing a pass). Nothing is stuck either way, so report it as already done
    // rather than as a failure the user has to act on.
    if (!applied) return { ok: true, alreadyDone: true, taskId, title: task.title };
    return { ok: true, taskId, title: task.title };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The in-thread / board "Approve anyway" button. Model-free, like its three neighbours: the click is
 *  the user act, so there is no quote to verify and nothing for a model to forge. */
export const overrideApproachFromButtonFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, taskId: z.string().min(1) }).parse(raw),
  )
  .handler(async ({ data }): Promise<OverrideResult> => {
    const email = await resolveCallerEmail(data.caller);
    if (!email) return { ok: false, error: "Sign-in required." };
    return overrideEscalatedApproach({ taskId: data.taskId, email, source: { via: "button" } });
  });

/** The board's "what is stuck waiting on me?" read, so an escalation that happened during an autowork
 *  run the owner never opened is still discoverable. Returns ids only; the board already has titles. */
export const getEscalatedApproachTasksFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<{ taskIds: string[] }> => {
    const email = await resolveCallerEmail(data.caller);
    if (!email) return { taskIds: [] };
    try {
      const { getEscalatedApproachTaskIds } = await import("./tasks.server");
      return { taskIds: [...(await getEscalatedApproachTaskIds(email))] };
    } catch {
      // A board that can't read engagement state still renders every card — it just shows no chips.
      return { taskIds: [] };
    }
  });

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
