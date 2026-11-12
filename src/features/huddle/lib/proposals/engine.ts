// WHAT:       The TASK-PROPOSAL engine with every I/O dependency injected: the ledger processor that turns one
//             email / Teams item into proposals, the Fireflies transcript pass, Approve / Edit / Mark done /
//             Dismiss, the build_checklist "proposals" result, and the evening delivery into Iris's 1:1.
// WHY:        AC docs/ac/AC-correspondence-checklist.md section 5. Pure so the offline suite runs it against an
//             in-memory store, a stub model and a stub journey (Tier 1: the model is never trusted, and the
//             task writer is the EXISTING create path, screened by create-task-core).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/task-proposals.test.ts sections F-K; docs/qc-evidence/IMPL-task-proposals.md.
//
// LOGS ARE PUBLIC-SAFE: counts, states and error CATEGORIES only. No title, evidence, subject or id is logged.

import type { ItemProcessor, LedgerStore, ProcessOutcome, SourceItem } from "../correspondence/source-item";
import { stableHash } from "../correspondence/source-item";
import { normalizeTaskTitle, screenCapabilityMetaTask, screenRawJourneyCreate, type CapabilityDeferral } from "../tasks/create-task-core";
import {
  EXTRACTION_INSTRUCTIONS,
  PROPOSALS_AGENT,
  PROPOSALS_TITLE,
  TASK_MAX,
  canonicalSpan,
  eveningDeliveryDirective,
  eveningDeliveryDue,
  eveningDeliveryTurnId,
  extractionInput,
  proposalChecklistRow,
  proposalId,
  proposalSourceFromItem,
  similarTitleKeys,
  titleKey,
  validateCandidates,
  type ProposalRow,
  type ProposalSource,
  type ProposalStore,
  type RejectReason,
} from "./proposals";

/** The model call: instructions + input -> parsed JSON (whatever shape it returned). Throws on failure. */
export type ExtractFn = (instructions: string, input: string) => Promise<unknown>;

export interface ProposeDeps {
  store: ProposalStore;
  extract: ExtractFn;
  /** The owner's OPEN board titles, normalized; null when the read failed (then nothing is skipped). */
  openTitles(): Promise<Set<string> | null>;
  tz: string;
}

export interface ProposeResult {
  ids: string[];
  created: number;
  attached: number;
  seen: number;
  onBoard: number;
  /** Not proposed again: a reworded re-extraction of the same item (F14) or a to-do dismissed elsewhere (F15). */
  suppressed: number;
  /** Candidates whose store write failed (the item is retried; the others were still stored). */
  failed: number;
  rejected: Partial<Record<RejectReason, number>>;
}

/** Errors that reach the ledger must be short codes (errorCategory keeps only code-shaped messages). */
const code = (c: string) => new Error(c);

/** One source -> extraction -> validation -> store (AC-5.18 .. 5.21). */
export async function proposeFromSource(owner: string, src: ProposalSource, deps: ProposeDeps): Promise<ProposeResult> {
  const out: ProposeResult = { ids: [], created: 0, attached: 0, seen: 0, onBoard: 0, suppressed: 0, failed: 0, rejected: {} };
  let raw: unknown;
  try {
    raw = await deps.extract(EXTRACTION_INSTRUCTIONS, extractionInput(src));
  } catch {
    // AC-3.3: a failed extraction is NOT processed; the ledger retries it with backoff.
    throw code("proposals:extract_failed");
  }
  const { accepted, rejected } = validateCandidates(raw, src.text, { atIso: src.at, tz: deps.tz });
  out.rejected = rejected;
  if (!accepted.length) return out;
  const openRaw = await deps.openTitles();
  // Red-team F13: board titles go through the same key as proposals (invisible / look-alike chars folded).
  const open = openRaw ? new Set([...openRaw].map(titleKey)) : null;
  for (const c of accepted) {
    // AC-5.21: a to-do already open on the board is not proposed at all.
    if (open?.has(titleKey(c.normTitle))) {
      out.onBoard++;
      continue;
    }
    // Red-team F3: one candidate's failed write must not lose the others. Each write is isolated; a failure
    // is counted and the item is retried after the loop (the refs make the stored ones "seen" on retry).
    try {
      const prior = await deps.store.priorRelated([owner], src, c.normTitle);
      // Red-team F14: the same source item re-extracted (an edited message, a re-processed transcript) and
      // the model words the to-do slightly differently -> the same to-do, whatever its state.
      const reworded = prior.find((p) => p.sameItem && p.normTitle !== c.normTitle && similarTitleKeys(p.normTitle, c.normTitle));
      // Red-team F15 (decision, reversible): a dismissal suppresses the same to-do from ANY source.
      const dismissed = prior.find((p) => p.state === "dismissed" && p.normTitle === c.normTitle && !p.sameItem);
      if (reworded || dismissed) {
        out.suppressed++;
        continue;
      }
      const r = await deps.store.upsert({
        id: proposalId(owner, src, c.normTitle),
        owner,
        title: c.title,
        normTitle: c.normTitle,
        evidence: c.evidence,
        assignee: c.assignee,
        dueText: c.dueText,
        dueDate: c.dueDate,
        ref: { source: src.source, sourceItemId: src.sourceItemId, at: src.at, context: src.context ?? null },
      });
      out[r.kind === "created" ? "created" : r.kind === "attached" ? "attached" : "seen"]++;
      if (!out.ids.includes(r.id)) out.ids.push(r.id);
    } catch {
      out.failed++;
    }
  }
  if (out.failed) throw code("proposals:store_failed");
  return out;
}

/**
 * The ledger processor (the data layer's ItemProcessor seam, name "proposals"). Idempotent per item: a
 * re-run (crash before `processed`, or an edited message) re-extracts, and the refs table makes every
 * already-seen (item, to-do) a no-op, so nothing duplicates and nothing decided reopens (AC-3.4).
 */
export function proposalsProcessor(deps: ProposeDeps & { owner(): string; mailbox(): string; log?: (l: string) => void }): ItemProcessor {
  return {
    name: "proposals",
    async process(item: SourceItem): Promise<ProcessOutcome> {
      const src = proposalSourceFromItem(item, deps.mailbox());
      if ("skip" in src) return { status: "processed", resultIds: {} };
      const r = await proposeFromSource(deps.owner(), src, deps);
      if (deps.log && (r.created || r.attached || r.suppressed || Object.keys(r.rejected).length)) {
        const rej = Object.entries(r.rejected).map(([k, n]) => `${k}=${n}`).join(",");
        deps.log(`[proposals] ${item.source} created=${r.created} attached=${r.attached} seen=${r.seen} on_board=${r.onBoard} suppressed=${r.suppressed}${rej ? ` rejected=${rej}` : ""}`);
      }
      return { status: "processed", resultIds: r.ids.length ? { proposals: r.ids } : {} };
    },
  };
}

// ── Fireflies transcripts (AC-5.22): read-only, through the same ledger ─────────────────────────────

export interface MeetingRef {
  meetingId: string;
  title: string | null;
  meetingAt: string | null;
  /** The minutes flow's own content hash; a re-processed meeting re-extracts (AC-3.4). */
  contentHash: string | null;
}

export interface TranscriptDeps extends ProposeDeps {
  ledger: LedgerStore;
  /** Meetings the minutes flow has FINISHED (nothing pending), newest first. Read-only. */
  listFinishedMeetings(): Promise<MeetingRef[]>;
  /** The Fireflies summary text proposals read (action items + overview), or null when unavailable. */
  fetchSummaryText(meetingId: string): Promise<string | null>;
  maxAttempts: number;
  now(): number;
  budgetMs: number;
}

export function transcriptSourceItem(m: MeetingRef): SourceItem {
  return {
    source: "transcript",
    sourceItemId: m.meetingId,
    identityBasis: "meeting_id",
    threadId: null,
    at: m.meetingAt,
    contentHash: stableHash([m.meetingId, m.contentHash ?? "", m.title ?? ""]),
    drivePath: null,
    driveItemId: null,
    fileEtag: null,
    internetMessageId: null,
  };
}

export async function runTranscriptProposals(owner: string, deps: TranscriptDeps): Promise<{ observed: number; processed: number; failed: number; needsContext: number }> {
  const res = { observed: 0, processed: 0, failed: 0, needsContext: 0 };
  const start = deps.now();
  const meetings = await deps.listFinishedMeetings();
  if (meetings.length) {
    const o = await deps.ledger.observe(owner, meetings.map(transcriptSourceItem));
    res.observed = o.inserted + o.changed;
  }
  const byId = new Map(meetings.map((m) => [m.meetingId, m]));
  while (deps.now() - start < deps.budgetMs) {
    const claimed = await deps.ledger.claimDue(owner, ["transcript"], 3, deps.maxAttempts);
    if (!claimed.length) break;
    for (const c of claimed) {
      const m = byId.get(c.sourceItemId);
      try {
        const text = m ? await deps.fetchSummaryText(m.meetingId) : null;
        if (!m || text === null) {
          if (await deps.ledger.markNeedsContext(c, m ? "transcript_summary" : "source_payload")) res.needsContext++;
          continue;
        }
        const r = text.trim()
          ? await proposeFromSource(owner, { source: "transcript", sourceItemId: m.meetingId, at: m.meetingAt, context: m.title, text }, deps)
          : null;
        if (await deps.ledger.markProcessed(c, r?.ids.length ? { proposals: r.ids } : {})) res.processed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        await deps.ledger.markFailed(c, /^[a-z][a-z0-9_:.-]{0,59}$/.test(msg) ? msg : "processor_error", deps.maxAttempts);
        res.failed++;
      }
    }
  }
  return res;
}

// ── Owner actions (AC-5.3, 5.7-5.13) ────────────────────────────────────────────────────────────────

export type ActionResult =
  | { ok: true; row: ProposalRow; alreadyDone?: boolean; alreadyOnBoard?: boolean; note?: string }
  | { ok: false; error: string; row?: ProposalRow | null };

export interface ApproveDeps {
  store: ProposalStore;
  /** The owner's open board tasks (not DONE, BLOCKED included -- the create-dedup rule). Throws on failure. */
  openTasks(): Promise<Array<{ id: string; title: string }>>;
  /** The EXISTING journey create (quick_create_task through invokeJourneyTool). */
  createTask(title: string, dueDate: string | null): Promise<{ ok: true; taskId: string | null } | { ok: false; error: string }>;
  metaGuard?(title: string): CapabilityDeferral | null;
  leaseSeconds?: number;
}

/**
 * Approve: claim (CAS lease) -> the create-task-core screens (meta-task guard, then the ONE raw-create
 * dedup interception against the owner's open titles) -> journey's own create -> record the task id.
 * A duplicate of an open board task links to it instead of creating a second (AC-5.10). Any failure
 * releases the lease and leaves the row `proposed` (AC-5.3). Tapped twice: the loser gets alreadyDone.
 */
export async function approveProposal(owners: string[], id: string, deps: ApproveDeps): Promise<ActionResult> {
  const claim = await deps.store.claimApprove(owners, id, deps.leaseSeconds ?? 90);
  if (!claim.row) return { ok: false, error: "That proposal isn't in your list." };
  if (!claim.claimed) {
    if (claim.row.state !== "proposed") return { ok: true, row: claim.row, alreadyDone: true };
    return { ok: false, error: "That proposal is already being approved.", row: claim.row };
  }
  const row = claim.row;
  const release = async (error: string): Promise<ActionResult> => {
    await deps.store.releaseApprove(id).catch(() => {});
    return { ok: false, error, row };
  };
  const guard = (deps.metaGuard ?? ((t: string) => screenCapabilityMetaTask(t, PROPOSALS_AGENT)))(row.title);
  if (guard) return release(`Not added: ${guard.reason}. Dismiss it, or ask that agent.`);

  let open: Array<{ id: string; title: string }> = [];
  let unavailable: string | null = null;
  try {
    open = await deps.openTasks();
  } catch {
    unavailable = "open-task read failed"; // fail OPEN but loud, the create-task-core rule (AC-64)
  }
  // Red-team F13: both sides through titleKey (sanitizeTitle + normalizeTaskTitle), so a zero-width or
  // look-alike character in either title cannot defeat the duplicate screen.
  const decision = await screenRawJourneyCreate(
    "quick_create_task",
    // The screen re-normalizes with normalizeTaskTitle, which leaves a titleKey unchanged (idempotent).
    { title: titleKey(row.title) },
    { ledger: new Set<string>(), loadTitles: async () => ({ titles: new Set(open.map((t) => titleKey(t.title))), unavailable }) },
  );
  if (decision.action === "skip") {
    const key = titleKey(row.title);
    const existing = open.find((t) => titleKey(t.title) === key);
    const done = await deps.store.finishApprove(id, existing?.id ?? null);
    if (!done) return release("Couldn't record that approval.");
    return { ok: true, row: done, alreadyOnBoard: true, note: "It was already on your board." };
  }
  let created: Awaited<ReturnType<ApproveDeps["createTask"]>>;
  try {
    created = await deps.createTask(row.title, row.dueDate);
  } catch {
    return release("Couldn't add that task to your board.");
  }
  if (!created.ok) return release(created.error || "Couldn't add that task to your board.");
  // Red-team S4: the task now exists. Record it (one retry), and if that still fails RELEASE the lease at
  // once: an immediate retry by the owner re-reads the board, finds the task just created and links it
  // (alreadyOnBoard), instead of the row sitting leased until a later retry that may hit a failed board read.
  let done: ProposalRow | null = null;
  for (let i = 0; i < 2 && !done; i++) done = await deps.store.finishApprove(id, created.taskId).catch(() => null);
  if (!done) {
    await deps.store.releaseApprove(id).catch(() => {});
    return { ok: false, error: "The task was added, but the proposal could not be marked approved.", row };
  }
  return { ok: true, row: done, ...(unavailable ? { note: "Added (the duplicate check could not run)." } : {}) };
}

export async function decideProposal(owners: string[], id: string, state: "completed" | "dismissed", store: ProposalStore): Promise<ActionResult> {
  const r = await store.decide(owners, id, state);
  if (!r.row) return { ok: false, error: "That proposal isn't in your list." };
  if (r.applied) return { ok: true, row: r.row };
  if (r.row.state !== "proposed") return { ok: true, row: r.row, alreadyDone: true };
  return { ok: false, error: "That proposal is being approved right now.", row: r.row };
}

export async function editProposal(owners: string[], id: string, title: string, store: ProposalStore): Promise<ActionResult> {
  const t = canonicalSpan(title);
  if (!t) return { ok: false, error: "A task needs some text." };
  if (t.length > TASK_MAX) return { ok: false, error: `Keep it under ${TASK_MAX} characters.` };
  const r = await store.edit(owners, id, t);
  if (!r.row) return { ok: false, error: "That proposal isn't in your list." };
  if (r.applied) return { ok: true, row: r.row };
  return { ok: false, error: r.row.state === "proposed" ? "That proposal is being approved right now." : "That proposal was already decided.", row: r.row };
}

// ── The EXISTING checklist, proposals mode (build_checklist proposals:true) ─────────────────────────

export function proposalChecklistPayload(rows: ProposalRow[], title = PROPOSALS_TITLE) {
  return { title, rows: rows.map(proposalChecklistRow) };
}

/** The JSON the build_checklist dispatcher returns for proposals mode (same envelope as task mode). */
export function proposalChecklistResult(rows: ProposalRow[]): string {
  if (!rows.length) {
    return JSON.stringify({
      error: "no_proposals",
      message: "There are no proposed tasks waiting for review right now. Say so in one line.",
    });
  }
  const payload = proposalChecklistPayload(rows);
  return JSON.stringify({
    rendered: true,
    dropped: 0,
    checklist: payload,
    message: `Checklist of ${rows.length} PROPOSED task(s) rendered -- these are suggestions found in email/Teams/meetings, NOT tasks on the board yet. Do not repeat them in your reply.`,
  });
}

// ── Evening delivery (OQ-7: Iris's 1:1, after the 6pm pass, every open proposal) ────────────────────

export interface DeliveryDeps {
  store: ProposalStore;
  /** enqueueTurn: false when this id already exists (ON CONFLICT DO NOTHING) -- the idempotency. */
  enqueue(turnId: string, payload: Record<string, unknown>): Promise<boolean>;
  run(turnId: string): Promise<void>;
  now(): number;
  tz: string;
  deliverAt?: string;
  workPending(): Promise<boolean>;
}

export async function deliverEveningProposals(owner: string, owners: string[], deps: DeliveryDeps): Promise<{ delivered: boolean; reason: string; count?: number }> {
  const active = await deps.store.listActive(owners);
  const nowMs = deps.now();
  const pending = active.length ? await deps.workPending() : false;
  if (!eveningDeliveryDue({ nowMs, tz: deps.tz, deliverAt: deps.deliverAt, workPending: pending, activeCount: active.length })) {
    return { delivered: false, reason: active.length ? "not_due" : "none_active" };
  }
  const turnId = eveningDeliveryTurnId(owner, nowMs, deps.tz);
  const payload = {
    text: eveningDeliveryDirective(active.length),
    huddleId: `dm-${PROPOSALS_AGENT}`,
    scope: "one-to-one",
    members: [PROPOSALS_AGENT],
    targetAgentId: PROPOSALS_AGENT,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    // journey disabled: this turn presents proposals; it must never write the board (AC-5.16).
    agents: { [PROPOSALS_AGENT]: { backend: "openai", journey: { enabled: false } } },
    timeZone: deps.tz,
    caller: { entra_email: owner },
    notify: "push",
    internal: true,
    // Attached to Iris's reply from the payload (like navLink), so the checklist is there whatever the
    // model writes. Every open proposal, not only today's (owner decision).
    checklist: proposalChecklistPayload(active),
  };
  const fresh = await deps.enqueue(turnId, payload);
  if (!fresh) return { delivered: false, reason: "already_delivered", count: active.length };
  await deps.run(turnId);
  return { delivered: true, reason: "delivered", count: active.length };
}
