// WHAT:       Server side of the background-AI-job quota alert: a per-request "which background job is this?" context
//             (AsyncLocalStorage), and the two hooks the shared model-call helpers call -- noteAiFailure / noteAiSuccess
//             -- which feed the pure monitor in ai-quota.ts with the REAL bell store (chat.email_replies kind
//             'ai_quota') and Iris's fixed-text notice turn (durable turn + the existing phone push, no model call).
// WHY:        Owner 2026-11-17: OpenAI ran out of quota and no alert reached him; only chat turns knew. Reporting from
//             the shared helpers (callOpenAIRouter / callOpenAIResponses and the raw-fetch sites background jobs use)
//             covers every background job, including ones added later, without a call-site list to keep in sync.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/ai-quota-alert.test.ts; scripts/ai-quota-alert-sql.test.ts;
//             docs/qc-evidence/BUILD-quota-alert-background.md.
//
// OUTSIDE a job context (an interactive chat turn) both hooks are no-ops: the chat turn keeps its existing toast.
// Both hooks are fire-and-forget and never throw, so a model call's own behaviour is unchanged.
import { AsyncLocalStorage } from "node:async_hooks";
import { createAiQuotaMonitor, systemNoticePayload, systemNoticeTurnId, type AiQuotaNotifier } from "./ai-quota";
import { AI_QUOTA_HOOKS_KEY, type AiQuotaHooks } from "./hooks";

export interface AiJobContext {
  /** Owner-readable job name ("Grooming", "Actions classifier", ...). Shown on the bell. */
  job: string;
  /** The caller's email as the job received it; resolved to the bell owner (resolveTaskEmail) at raise time. */
  ownerEmail?: string | null;
}

const als = new AsyncLocalStorage<AiJobContext>();

/** Run `fn` as background job `job`: every model call inside it (however deep, across awaits) reports here. */
export function runAsAiJob<T>(job: string, ownerEmail: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return als.run({ job, ownerEmail: ownerEmail ?? null }, fn);
}

export const currentAiJob = (): AiJobContext | undefined => als.getStore();

/** The bell owner for a job: the same resolution the bell reads with (attention.functions resolveOwner); with no
 *  caller (a heartbeat job), the feed config's owner login -- the owner the heartbeat jobs already act for. */
const ownerCache = new Map<string, string>();
async function resolveBellOwner(raw: string | null | undefined): Promise<string | null> {
  try {
    if (raw) {
      const hit = ownerCache.get(raw);
      if (hit) return hit;
      const { resolveTaskEmail } = await import("../journey/identity");
      const owner = (await resolveTaskEmail({ entra_email: raw })) ?? raw;
      ownerCache.set(raw, owner);
      return owner;
    }
    const { getFeedsConfig } = await import("../external-feeds/onedrive-feed.server");
    return getFeedsConfig()?.ownerLogins[0] ?? null;
  } catch {
    return raw ?? null;
  }
}

/** Iris's notice: a durable turn whose reply is fixed text (systemNotice), run through the EXISTING runner so it
 *  persists and fires the existing away-push. executeClaimedTurn short-circuits it before any model call. */
export const postIrisNotice: AiQuotaNotifier = async (r) => {
  const turnId = systemNoticeTurnId(r.id, r.kind, r.nowMs);
  const { enqueueTurn } = await import("../tasks/turns.server");
  const { AI_QUOTA_HUDDLE } = await import("./ai-quota");
  if (!(await enqueueTurn(turnId, AI_QUOTA_HUDDLE, r.ownerEmail, systemNoticePayload(r.ownerEmail, r.text)))) return false;
  const { runTurnById } = await import("../huddle.functions");
  await runTurnById(turnId);
  return true;
};

let monitor: ReturnType<typeof createAiQuotaMonitor> | null = null;
function getMonitor() {
  if (monitor) return monitor;
  monitor = createAiQuotaMonitor({
    store: {
      raise: async (r) => (await import("../email/email-replies.server")).raiseAiQuotaAttention(r),
      clear: async (id, owner) => (await import("../email/email-replies.server")).clearAiQuotaAttention(id, owner),
    },
    notify: postIrisNotice,
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
  return monitor;
}

/** A model call inside a background job failed. Logs its KIND; a quota error raises the one alert. Never throws. */
export function noteAiFailure(err: unknown): void {
  const ctx = als.getStore();
  if (!ctx) return; // interactive chat turn: unchanged (it has its own toast)
  void (async () => {
    try {
      const m = getMonitor();
      // Resolve the owner only when it matters (a quota error); the kind is logged either way.
      const { isQuotaError } = await import("../fallbacks");
      const quota = isQuotaError(String((err as { message?: unknown })?.message ?? err ?? ""));
      await m.onFailure(ctx.job, quota ? await resolveBellOwner(ctx.ownerEmail) : null, err);
    } catch {
      /* never fail the job on its alert */
    }
  })();
}

/** A model call inside a background job succeeded: ends an open outage (throttled per instance). Never throws. */
export function noteAiSuccess(): void {
  const ctx = als.getStore();
  if (!ctx) return;
  void (async () => {
    try {
      await getMonitor().onSuccess(ctx.job, await resolveBellOwner(ctx.ownerEmail));
    } catch {
      /* never fail the job on its alert */
    }
  })();
}

/** Raw-fetch sites (via hooks.ts reportAiResponse): report an OpenAI HTTP response's outcome. Reads the body only on failure, from a CLONE, so the
 *  caller's own read is untouched; only the kind (status + known code) is ever logged. */
export function noteAiResponse(res: Response): void {
  if (!als.getStore()) return;
  if (res.ok) return noteAiSuccess();
  void (async () => {
    let body = "";
    try {
      body = (await res.clone().text()).slice(0, 400);
    } catch {
      body = "";
    }
    noteAiFailure(new Error(`OpenAI ${res.status}: ${body}`));
  })();
}

// Register the hooks for hooks.ts (the client-safe entry the shared model helpers import). Loading this module is
// what starts any background job (runAsAiJob), so the registry always exists before a job's first model call.
(globalThis as Record<string, unknown>)[AI_QUOTA_HOOKS_KEY] = { noteAiFailure, noteAiSuccess, noteAiResponse } satisfies AiQuotaHooks;
