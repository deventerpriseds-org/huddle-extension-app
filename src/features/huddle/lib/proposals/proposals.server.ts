// WHAT:       Server binding for TASK PROPOSALS: wires the pure engine (engine.ts) to the real config switch,
//             the Azure PG stores (proposal store + the data layer's correspondence ledger), the existing
//             model-call path, the existing journey create, Fireflies (read-only) and the durable-turn queue.
//             Exposes: the ledger processor, the heartbeat pass (transcripts + evening delivery), the
//             build_checklist proposals mode, and the owner actions behind proposals.functions.ts.
// WHY:        AC docs/ac/AC-correspondence-checklist.md section 5 + owner decisions (Iris's 1:1 after the 6pm
//             pass and on request; no bell item for proposals).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/task-proposals.test.ts (engine, offline); scripts/task-proposals-sql.test.ts (store SQL);
//             docs/qc-evidence/IMPL-task-proposals.md.
//
// OFF unless HUDDLE_ONEDRIVE_FEEDS.correspondence.proposals is literally true (the data layer's flag): every
// entry point returns before any database, model, Graph, Fireflies or journey call (AC-6.1/6.3).
// Logs carry counts and codes only (AC-3.8).
import { getFeedsConfig } from "../external-feeds/onedrive-feed.server";
import type { OneDriveFeedsConfig } from "../external-feeds/onedrive-feed";
import type { ItemProcessor } from "../correspondence/source-item";
import {
  approveProposal,
  decideProposal,
  deliverEveningProposals,
  editProposal,
  conversationProposalsProcessor,
  proposalChecklistResult,
  proposalsProcessor,
  runTranscriptProposals,
  type ActionResult,
  type ExtractFn,
  type MeetingRef,
} from "./engine";
import { EXTRACTION_SCHEMA, EXTRACTION_SCHEMA_NAME, PROPOSALS_AGENT, PROPOSALS_HUDDLE, transcriptProposalText, type ProposalRow } from "./proposals";

/** The cheap tier the minutes flow already uses for its Luna summaries. */
export const EXTRACT_MODEL = "gpt-5.6-luna";
const EXTRACT_TIMEOUT_MS = 20_000;
const TRANSCRIPT_BUDGET_MS = 25_000;
const TRANSCRIPT_LOOKBACK_DAYS = 7;

/** The config, only when proposals are switched on (literal true) and an owner is bound. */
export function proposalsConfig(): (OneDriveFeedsConfig & { owner: string }) | null {
  const cfg = getFeedsConfig();
  if (!cfg || cfg.correspondence.proposals !== true) return null;
  const owner = cfg.ownerLogins[0];
  return owner ? { ...cfg, owner: owner.toLowerCase() } : null;
}

/** Every email that is the owner (identity scope + configured logins), lower-cased. */
async function scopeOf(email: string, extra: string[] = []): Promise<string[]> {
  const { resolveScopeByEmail } = await import("../identity/identity.server");
  const { emails } = await resolveScopeByEmail(email).catch(() => ({ emails: [] as string[] }));
  return [...new Set([email, ...emails, ...extra].map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

/** The existing strict-JSON model path (callOpenAIRouter: Responses + json_schema strict), bounded. */
export const extract: ExtractFn = async (instructions, input) => {
  const { callOpenAIRouter } = await import("../openai-responses.server");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      callOpenAIRouter<unknown>({ model: EXTRACT_MODEL, system: instructions, prompt: input, schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>, schemaName: EXTRACTION_SCHEMA_NAME }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("extract_timeout")), EXTRACT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** The owner's open board titles via the create path's own reader (fail-open -> null, never "no dupes"). */
function openTitlesFor(owner: string) {
  let cache: { at: number; v: Set<string> | null } | null = null;
  return async (): Promise<Set<string> | null> => {
    if (cache && Date.now() - cache.at < 60_000) return cache.v;
    const { loadOpenTaskTitles } = await import("../tasks/create-task-core");
    const r = await loadOpenTaskTitles({ entra_email: owner });
    cache = { at: Date.now(), v: r.unavailable ? null : r.titles };
    return cache.v;
  };
}

async function deps(owner: string) {
  const { pgProposalStore } = await import("./proposals-store.server");
  const { DEFAULT_TZ } = await import("../identity/scheduling-config.server");
  return { store: pgProposalStore, extract, openTitles: openTitlesFor(owner), tz: DEFAULT_TZ };
}

/** The ledger processor the correspondence ingest runs when correspondence.proposals is on. */
export async function makeProposalsProcessor(): Promise<ItemProcessor | null> {
  const cfg = proposalsConfig();
  if (!cfg) return null;
  const d = await deps(cfg.owner);
  if (cfg.correspondence.conversations === true) {
    // Needs-you redesign (AC-R6, flag correspondence.conversations): one source per conversation, owner as doer.
    return conversationProposalsProcessor({
      ...d,
      owner: () => cfg.owner,
      mailbox: () => cfg.mailbox,
      log: (l) => console.log(l),
      needsYou: async () => {
        const { ownerAddressSet } = await import("../correspondence/needs-you");
        const { loadFeedSent } = await import("../email/email-replies.server");
        const sent = await loadFeedSent(cfg.owner).catch(() => null);
        return { ownerAddresses: ownerAddressSet(cfg), ownerNames: cfg.correspondence.ownerNames, latestSent: sent ?? new Map(), sentKnown: !!sent && sent.size > 0 };
      },
    });
  }
  return proposalsProcessor({ ...d, owner: () => cfg.owner, mailbox: () => cfg.mailbox, log: (l) => console.log(l) });
}

let running: Promise<void> | null = null;

/**
 * Heartbeat entry (scheduler.server runDueScheduledJobs, started alongside Fireflies and the ingest):
 * Fireflies transcripts -> proposals, then the evening delivery. Never throws; zero work when OFF.
 */
export function runProposalsPass(): Promise<void> {
  const cfg = proposalsConfig();
  if (!cfg) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    try {
      const d = await deps(cfg.owner);
      const { pgLedger } = await import("../correspondence/ledger.server");
      const owners = await scopeOf(cfg.owner, cfg.ownerLogins);
      if (process.env.FIREFLIES_API_KEY) {
        try {
          const ff = await import("../fireflies/fireflies.server");
          const store = await import("../fireflies/minutes-store.server");
          const mOwner = ff.minutesOwner();
          if (mOwner && owners.includes(mOwner)) {
            const r = await runTranscriptProposals(cfg.owner, {
              ...d,
              ledger: pgLedger,
              maxAttempts: cfg.correspondence.maxAttempts,
              now: () => Date.now(),
              budgetMs: TRANSCRIPT_BUDGET_MS,
              // Read-only: meetings the minutes flow has FINISHED; the queue, lease, email and upload are untouched.
              listFinishedMeetings: async (): Promise<MeetingRef[]> => {
                const since = Date.now() - TRANSCRIPT_LOOKBACK_DAYS * 86_400_000;
                return (await store.listRecentMeetings(mOwner, 20))
                  .filter((m) => !m.pending_email && !m.pending_onedrive && Date.parse(m.created_at) >= since)
                  .map((m) => ({ meetingId: m.meeting_id, title: m.title, meetingAt: m.meeting_at, contentHash: m.content_hash }));
              },
              fetchSummaryText: async (id) => {
                try {
                  return transcriptProposalText((await ff.fetchTranscript(id)).transcript.summary);
                } catch {
                  return null; // needs_context: retried when the meeting changes, never a hot loop
                }
              },
            });
            if (r.processed || r.failed || r.needsContext) console.log(`[proposals] transcripts processed=${r.processed} needs_context=${r.needsContext} failed=${r.failed}`);
          }
        } catch (e) {
          console.error("[proposals] transcript pass failed", e instanceof Error ? e.name : "error");
        }
      }
      const out = await deliverEveningProposals(cfg.owner, owners, {
        store: d.store,
        tz: d.tz,
        deliverAt: proposalsDeliverAt(),
        now: () => Date.now(),
        workPending: () => pgLedger.hasDue(cfg.owner, ["email", "teams", "transcript"], cfg.correspondence.maxAttempts),
        enqueue: async (turnId, payload) => {
          const { enqueueTurn } = await import("../tasks/turns.server");
          return enqueueTurn(turnId, PROPOSALS_HUDDLE, cfg.owner, payload);
        },
        run: async (turnId) => {
          const { runTurnById } = await import("../huddle.functions");
          await runTurnById(turnId);
        },
      });
      if (out.delivered) console.log(`[proposals] evening checklist delivered count=${out.count}`);
    } catch (e) {
      console.error("[proposals] pass failed", e instanceof Error ? e.name : "error");
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Optional `correspondence.proposalsDeliverAt` ("HH:MM", owner zone) in the same server-only setting. The
 *  data layer's parser keeps only its own keys, so this one key is read here; anything invalid -> default. */
export function proposalsDeliverAt(raw = process.env.HUDDLE_ONEDRIVE_FEEDS): string | undefined {
  try {
    const v = (JSON.parse(String(raw ?? "")) as { correspondence?: { proposalsDeliverAt?: unknown } })?.correspondence?.proposalsDeliverAt;
    return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// ── On request (build_checklist proposals:true) and the owner's buttons ─────────────────────────────

/** build_checklist proposals mode. `userEmail` is the caller's resolved journey email. */
export async function proposalChecklistForUser(userEmail: string): Promise<string> {
  const cfg = proposalsConfig();
  if (!cfg) {
    return JSON.stringify({ error: "not_enabled", message: "Task proposals are not switched on. Say so in one line." });
  }
  const owners = await scopeOf(userEmail);
  if (!owners.includes(cfg.owner) && !cfg.ownerLogins.some((l) => owners.includes(l.toLowerCase()))) {
    return proposalChecklistResult([]);
  }
  const { pgProposalStore } = await import("./proposals-store.server");
  return proposalChecklistResult(await pgProposalStore.listActive(owners));
}

/** The caller's owner scope, or null when signed out. Ownership is enforced by every store query. */
async function callerOwners(caller: { entra_object_id?: string; entra_email?: string } | undefined): Promise<string[] | null> {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller).catch(() => undefined)) ?? caller.entra_email;
  return scopeOf(email, [caller.entra_email]);
}

export async function getProposalRows(caller: { entra_object_id?: string; entra_email?: string } | undefined, ids: string[]): Promise<ProposalRow[]> {
  if (!proposalsConfig()) return [];
  const owners = await callerOwners(caller);
  if (!owners) return [];
  const { pgProposalStore } = await import("./proposals-store.server");
  return pgProposalStore.getMany(owners, ids.slice(0, 500));
}

export async function actOnProposal(
  caller: { entra_object_id?: string; entra_email?: string } | undefined,
  id: string,
  action: "approve" | "complete" | "dismiss" | "edit",
  title?: string,
): Promise<ActionResult> {
  if (!proposalsConfig()) return { ok: false, error: "Task proposals are not switched on." };
  const owners = await callerOwners(caller);
  if (!owners) return { ok: false, error: "Sign-in required." };
  const { pgProposalStore: store } = await import("./proposals-store.server");
  if (action === "complete") return decideProposal(owners, id, "completed", store);
  if (action === "dismiss") return decideProposal(owners, id, "dismissed", store);
  if (action === "edit") return editProposal(owners, id, title ?? "", store);
  return approveProposal(owners, id, {
    store,
    openTasks: async () => {
      const { resolveTaskEmail } = await import("../journey/identity");
      const resolved = (await resolveTaskEmail(caller ?? {})) ?? caller?.entra_email ?? "";
      const { getTasksForUser } = await import("../tasks/tasks.server");
      return (await getTasksForUser(resolved, undefined, { includeBlocked: true })).map((t) => ({ id: t.id, title: t.title ?? "" }));
    },
    // The EXISTING journey create: quick_create_task through the one journey chokepoint, as the voice and
    // text create paths do. journey owns scheduling and its own dedup; Huddle never inserts a task row.
    createTask: async (title, dueDate) => {
      const { invokeJourneyTool } = await import("../journey/proxy.functions");
      const { normalizeJourneyDate } = await import("../tasks/create-task-core");
      const date = normalizeJourneyDate(dueDate ?? undefined);
      const r = await invokeJourneyTool({
        toolName: "quick_create_task",
        args: date ? { title: title.slice(0, 160), date } : { title: title.slice(0, 160) },
        caller: caller ?? {},
        context: { source: "huddle", huddleId: PROPOSALS_HUDDLE, agentId: PROPOSALS_AGENT },
      });
      if (!r.ok) return { ok: false, error: "Couldn't add that task to your board." };
      try {
        const parsed = JSON.parse(r.output) as { tasks?: Array<{ id?: string }> };
        return { ok: true, taskId: typeof parsed.tasks?.[0]?.id === "string" ? parsed.tasks[0].id : null };
      } catch {
        return { ok: true, taskId: null };
      }
    },
  });
}
