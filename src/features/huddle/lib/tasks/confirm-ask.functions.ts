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

export type OverrideResult = ButtonResult & {
  taskId?: string;
  title?: string;
};

/**
 * What an AGENT gets back when it asks the owner to override. Note what is NOT here: any field that
 * could read as "done". `applied` is always false, by construction — see requestApproachOverride.
 */
export type OverrideRequestResult = {
  ok: boolean;
  error?: string;
  taskId?: string;
  title?: string;
  /** ALWAYS false. The override is not applied by this call and cannot be. */
  applied: false;
  /** true when the owner still has to tap. */
  awaitingUserTap?: boolean;
  /** true when an ask for this task was already pending — no second notice was sent. */
  alreadyRequested?: boolean;
  /** true when the task was not escalated at all: already approved, or never stuck. */
  alreadyDone?: boolean;
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
 *  - THERE IS NO MODEL PATH TO IT AT ALL. This function had a second caller until 2026-09-12: a
 *    `via:'quote'` arm in which a model relayed the owner's words and `verifyOwnerQuote` decided
 *    whether they MEANT consent. Three independent adversarial passes refuted that classifier with
 *    three non-overlapping sets of ordinary English it misread as consent, so the arm is deleted
 *    rather than tightened. An agent may now only REQUEST (requestApproachOverride below); the owner's
 *    tap is the grant. See .claude/BUILD-override-request-then-tap.md.
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
}): Promise<OverrideResult> {
  const { taskId, email } = opts;
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

    const applied = await overrideApproachGate({ taskId, userEmail: email });
    // Not applied = the row stopped being 'escalated' between the read above and this write (a second
    // click, or the grader landing a pass). Nothing is stuck either way, so report it as already done
    // rather than as a failure the user has to act on.
    if (!applied) return { ok: true, alreadyDone: true, taskId, title: task.title };
    return { ok: true, taskId, title: task.title };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * AN AGENT ASKS THE OWNER TO OVERRIDE. This is the ONLY override-related function a model can reach,
 * and it CANNOT APPLY AN OVERRIDE — not "will not", cannot: it never calls `overrideApproachGate`, and
 * the statement it does call (`recordApproachOverrideRequest`) has no `approach_status` in its SET
 * clause, so the row stays `escalated` no matter what any caller passes.
 *
 * WHY IT IS SHAPED THIS WAY. Until 2026-09-12 a model could pass `owner_quote` and the server tried to
 * decide, from that free text, whether the owner's words MEANT consent to override THIS task. Three
 * independent adversarial passes refuted it with three NON-OVERLAPPING sets of ordinary English —
 * an unrelated go-ahead binding because the agent had exactly one escalated task, "Never approve that
 * particular approach without more testing", "not now", the owner quoting an agent's own proposal back
 * with a hedge attached, and an authorisation about the weekly NEWSLETTER unblocking a task titled
 * "Send the weekly report". All 13 suites were green through all of it. The lesson recorded here so it
 * is not re-learned: the fix for a leaky classifier over natural language is to STOP CLASSIFYING, not
 * to add words to its lists. (.claude/VERIFY-override-gate-1.md, -2.md, -2-attacks.md.)
 *
 * So: no text is an input to the decision. `reason` is shown to the owner and stored; nothing branches
 * on it. The owner's tap — `overrideApproachFromButtonFn`, a `createServerFn` reachable only from an
 * authenticated browser session — is the grant.
 *
 * The checks below are the SAME ones the tap path runs, for the same reasons (ownership via
 * `getOwnedTaskForConfirmAsk`, which returns the byte-identical error for "doesn't exist" and "isn't
 * yours"; DONE and non-escalated refused). An agent must not be able to use this to probe for task ids
 * it does not own, or to raise the owner's attention about a task that is not stuck.
 *
 * @returns `fresh:true` on the ONE call per escalation episode that actually stamped the ask — the
 *          caller notifies only then. Everything else is `alreadyRequested` or `alreadyDone`.
 */
export async function requestApproachOverride(opts: {
  taskId: string;
  email: string;
  /** The requesting agent's id, for the audit record and the owner-facing message. */
  requestedByAgent: string | null;
  /** The agent's own stated reason. Shown to the owner; never read to decide anything. */
  reason?: string;
}): Promise<OverrideRequestResult & { fresh?: boolean }> {
  const { taskId, email } = opts;
  try {
    const { getOwnedTaskForConfirmAsk, getTaskEngagementState, recordApproachOverrideRequest } =
      await import("./tasks.server");
    const task = await getOwnedTaskForConfirmAsk(taskId, email);
    if (!task) return { ok: false, applied: false, error: "Task not found." };
    if ((task.status ?? "").toUpperCase() === "DONE") {
      return {
        ok: false,
        applied: false,
        error: "That task is already done — there's nothing to unstick.",
        taskId,
        title: task.title,
      };
    }

    const state = await getTaskEngagementState(taskId).catch(() => null);
    const status = state?.approach_status ?? "pending";
    if (status === "approved") {
      return { ok: true, applied: false, alreadyDone: true, taskId, title: task.title };
    }
    if (status !== "escalated") {
      // Same refusal, and the same reasoning, as the tap path: `resetEngagementOnReassignment` puts a
      // reassigned task back to 'pending' because the new assignee never proposed the approach that
      // was escalated. There is nothing for the owner to approve, so there is nothing to ask them.
      return {
        ok: false,
        applied: false,
        error:
          "That task isn't waiting on the user's approval — its approach gate is at \u201cpending\u201d. If it " +
          "changed hands, the new assignee starts the approach fresh.",
        taskId,
        title: task.title,
      };
    }

    // The guarded UPDATE is the rate limiter. true only for the first ask of this escalation episode;
    // a repeat writes nothing, returns false, and therefore sends no second notification.
    const fresh = await recordApproachOverrideRequest({
      taskId,
      requestedBy: opts.requestedByAgent ?? null,
      reason: (opts.reason ?? "").trim() || null,
    });
    return {
      ok: true,
      applied: false,
      awaitingUserTap: true,
      alreadyRequested: !fresh,
      fresh,
      taskId,
      title: task.title,
    };
  } catch (err) {
    // Never swallowed into a false "asked": an agent that believes the owner was notified will stop
    // mentioning it, and the task goes quiet while still stuck.
    return { ok: false, applied: false, error: err instanceof Error ? err.message : String(err) };
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
    return overrideEscalatedApproach({ taskId: data.taskId, email });
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
