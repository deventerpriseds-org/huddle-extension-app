// WHAT:       Delivers one edition of the schedule brief as a proactive push in Iris's 1:1.
// WHY:        The owner asked for the brief to be IRIS's job ("iris should have a task of reminding
//             me 60 minutes before any as well", 2026-10-01), and the schedule/priorities widgets
//             are already docked in her DM — so her thread is where "what's on today" already
//             lives. Splitting build from deliver keeps buildScheduleBrief pure and testable: this
//             file is the only part that writes anything.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:schedule-brief.
//
// EXTENDS THE STANDUP'S DELIVERY PATH, byte for byte where it matters. `standup.server.ts` already
// proved the shape: build a directive, enqueue a DURABLE TURN in the owner agent's DM with
// `notify:"push"` and `internal:true`, then run it. Riding that path means the EXISTING
// away-notification fires (send_push -> Android bridge) with no new sender and no new secret --
// the standing rule in this repo's CLAUDE.md ("piggyback journey, don't build a parallel push").

import type { AgentId } from "../../data/agents";
import { DEFAULT_TZ } from "../identity/scheduling-config.server";
import { buildScheduleBrief, type BriefEdition, type ScheduleBrief } from "./schedule-brief.server";

/** Iris Chase owns this brief — the owner named her, and her DM already carries the docked
 *  schedule + priorities widgets, so "what's on today" is already her thread. */
const BRIEF_OWNER: AgentId = "iris-chase";

export interface ScheduleBriefResult {
  ok: boolean;
  edition?: BriefEdition;
  forDate?: string;
  /** How many items the edition carried. 0 with ok:true is a legitimate "nothing on". */
  count?: number;
  delivered?: boolean;
  /** Which message shape was (or on a dryRun, would be) sent — see briefDeliveryPlan. */
  kind?: BriefDeliveryKind;
  /** On a dryRun, the exact directive Iris would be handed. */
  directive?: string;
  /** Present on a dryRun, so a verification pass can read exactly what WOULD have been sent. */
  brief?: ScheduleBrief;
  error?: string;
  errors?: string[];
}

/** `"7:00PM"` in the brief's zone. Returns null for an all-day item rather than inventing midnight. */
function clock(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .format(d)
      .replace(/\s?(AM|PM)$/i, (_m, p: string) => p.toUpperCase());
  } catch {
    return null;
  }
}

/**
 * The lines Iris is handed. FACTS ONLY — the model writes the prose around them, but every time,
 * title and location here came from the source, so it has nothing to invent. An item with no start
 * time is labelled "all day" rather than being given a guessed one.
 */
export function briefLines(brief: ScheduleBrief, tz: string): string[] {
  return brief.items.map((i) => {
    const t = clock(i.startIso, tz);
    const end = clock(i.endIso, tz);
    const when = t ? (end ? `${t}–${end}` : t) : "all day";
    const where = i.location ? ` · ${i.location}` : "";
    return `${when} — ${i.title} (${i.kind})${where}`;
  });
}

export type BriefDeliveryKind = "items" | "read-error" | "nothing-scheduled";

/**
 * Decide WHAT Iris is told for an edition. PURE, so the three outcomes are unit-testable.
 *
 * EVERY EDITION NOW SENDS SOMETHING (owner-directed 2026-10-15). It used to be "nothing on = nothing
 * sent", and the same `!items.length` return also swallowed an edition whose sources FAILED — so a
 * broken calendar read (wrong mailbox, see meetingsForDate) was indistinguishable from an empty day
 * and the brief was silent for ten days with nobody able to tell why. Now:
 *   items              -> the normal brief (with an "incomplete" note if one source failed)
 *   no items + errors  -> a short notice that the calendar could NOT be read, with the error text
 *   no items, no errors-> a short "nothing on your calendar" message — the owner wants one every
 *                         morning and evening so silence never has to be interpreted.
 */
export function briefDeliveryPlan(
  brief: ScheduleBrief,
  tz: string,
): { kind: BriefDeliveryKind; directive: string } {
  const day =
    brief.edition === "evening" ? `Tomorrow (${brief.forDate})` : `Today (${brief.forDate})`;
  const reportOnly =
    `This is a REPORT-ONLY turn — everything above is already known, so do NOT call any tool, do not ` +
    `invent anything that is not listed, and do not paste raw JSON. Keep it skimmable.`;

  if (!brief.items.length && brief.errors.length) {
    return {
      kind: "read-error",
      directive:
        `${day} — the schedule brief could NOT read the calendar, so there is no list to give.\n` +
        `Errors: ${brief.errors.join("; ")}\n\n` +
        `Write ONE short message in your own voice telling the user you couldn't pull ` +
        `${brief.edition === "evening" ? "tomorrow's" : "today's"} meetings and classes, quote the error text ` +
        `above briefly so it can be fixed, and do NOT say or imply their calendar is empty — you do not know that. ` +
        reportOnly,
    };
  }

  if (!brief.items.length) {
    return {
      kind: "nothing-scheduled",
      directive:
        `${day} — nothing is on the calendar: no meetings and no classes were found.\n\n` +
        `Write ONE short, warm line in your own voice saying there is nothing scheduled ` +
        `${brief.edition === "evening" ? "tomorrow" : "today"}. ` +
        reportOnly,
    };
  }

  const lines = briefLines(brief, tz);
  return {
    kind: "items",
    directive:
      `${day} — here is what is on:\n${lines.join("\n")}\n\n` +
      `Write ONE short, warm heads-up in your own voice covering exactly these items, earliest first. ` +
      `Lead with the first thing and its time. Mention the location only when one is given. ` +
      `${brief.errors.length ? `Say plainly that one source could not be read (${brief.errors.join("; ")}), so this may be incomplete. ` : ""}` +
      reportOnly,
  };
}

/**
 * Run one edition for one user and deliver it.
 *
 * NEVER THROWS — every failure is a normal `ok:false` return, matching every other scheduled job
 * here. A scheduler that throws loses the whole tick for every other job claimed in it.
 */
export async function runScheduleBrief(
  caller: { entra_email: string },
  opts: {
    timeZone?: string;
    edition?: BriefEdition;
    dryRun?: boolean;
    runId?: string;
    /** Injectable clock, so a test pins the edition instead of waiting for 8pm. */
    nowMs?: number;
  } = {},
): Promise<ScheduleBriefResult> {
  const tz = opts.timeZone?.trim() || DEFAULT_TZ;
  const nowMs = opts.nowMs ?? Date.now();

  // The calendar lives in the OWNER's canonical mailbox, which is not necessarily the login the
  // scheduler posts (the job targets dev@, the meetings live under the resolved identity). Resolve it
  // EXACTLY the way the working `get_external_calendar_events` agent tool does, so the brief and the
  // tool can never read two different calendars again.
  let mailbox = caller.entra_email;
  try {
    const { resolveTaskEmail } = await import("../journey/identity");
    mailbox = (await resolveTaskEmail(caller)) ?? caller.entra_email;
  } catch {
    /* identity lookup is best-effort — fall back to the login rather than to the sending mailbox */
  }

  let brief: ScheduleBrief;
  try {
    brief = await buildScheduleBrief({ nowMs, cadence: { tz }, edition: opts.edition, mailbox });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "brief build failed" };
  }

  const base: ScheduleBriefResult = {
    ok: brief.ok,
    edition: brief.edition,
    forDate: brief.forDate,
    count: brief.items.length,
    ...(brief.errors.length ? { errors: brief.errors } : {}),
  };

  const plan = briefDeliveryPlan(brief, tz);
  if (opts.dryRun)
    return { ...base, delivered: false, kind: plan.kind, directive: plan.directive, brief };
  const directive = plan.directive;

  // The run id is keyed on the EDITION AND THE DATE IT COVERS, not on a timestamp: if the scheduler
  // fires twice in one slot (a retry, an overlapping tick), `enqueueTurn` sees the same id and
  // returns not-fresh, so the owner gets ONE push rather than two. `runId` only disambiguates a
  // deliberate manual re-run.
  const turnId = `schedule-brief-${brief.edition}-${brief.forDate}${opts.runId ? `-${opts.runId}` : ""}`;

  const payload = {
    text: directive,
    huddleId: `dm-${BRIEF_OWNER}`,
    scope: "one-to-one",
    members: [BRIEF_OWNER],
    targetAgentId: BRIEF_OWNER,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { [BRIEF_OWNER]: { backend: "openai", journey: { enabled: false } } },
    timeZone: tz,
    caller,
    notify: "push", // this IS the alert — the whole point is that it reaches the phone
    internal: true, // system-originated digest — never pass along / defer
  };

  try {
    const { enqueueTurn } = await import("./turns.server");
    const fresh = await enqueueTurn(turnId, `dm-${BRIEF_OWNER}`, caller.entra_email, payload);
    if (fresh) {
      const { runTurnById } = await import("../huddle.functions");
      await runTurnById(turnId);
    }
    return { ...base, kind: plan.kind, delivered: !!fresh };
  } catch (err) {
    return {
      ...base,
      ok: false,
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
