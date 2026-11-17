// WHAT:       The background-AI-job quota alert, as pure rules + an injected store: every background model call reports
//             its outcome here; a quota failure (the EXISTING isQuotaError) raises ONE bell item (kind 'ai_quota') and
//             ONE notice in Iris's 1:1, the next success clears it, and every failure's KIND is logged.
// WHY:        Owner 2026-11-17: the OpenAI account ran out of quota (429 insufficient_quota) and no alert reached him.
//             The existing alert (isQuotaError + QUOTA_OUTAGE_INLINE -> the `openai-quota-outage` toast) only fires
//             inside a chat turn the owner is watching; background jobs (Actions classifier, proposals extract/judge,
//             auto-work, grooming, stand-up, digests, meeting triage) only counted their failures.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/ai-quota-alert.test.ts; scripts/ai-quota-alert-sql.test.ts;
//             docs/qc-evidence/BUILD-quota-alert-background.md.
//
// Logs carry the job name, the failure kind and counts only (this repo is public): never a message, body,
// address or token. Raising the alert makes NO model call -- the account is out of quota.
import { shortHash } from "../email/inbound-email";
import { EMAIL_ALERT_HUDDLE } from "../attention/attention";
import { AI_QUOTA_PAUSED_TEXT, AI_QUOTA_RECOVERED_TEXT, aiFailureKind, isQuotaError } from "../fallbacks";

/** The agent whose 1:1 carries the notice (she already owns the bell's alerts; her chat is EMAIL_ALERT_HUDDLE). */
export const AI_QUOTA_AGENT = "iris-chase";
export const AI_QUOTA_HUDDLE = EMAIL_ALERT_HUDDLE;

/** The ONE bell row of the outage alert for one owner: `attn-ai_quota-<hash>`. Cannot equal an email row (bare hash)
 *  or any other `attn-<kind>-` row. */
export const aiQuotaAttentionId = (owner: string) => `attn-ai_quota-${shortHash(owner.trim().toLowerCase())}`;

/** Pure: the bell row's text. Names the job; never any content. */
export function aiQuotaAlertText(job: string): { title: string; detail: string } {
  return { title: `OpenAI is out of credit (hit by ${job})`, detail: AI_QUOTA_PAUSED_TEXT };
}

/** Pure: Iris's notice. Fixed text -- posted verbatim, NOT generated (there is no credit to generate it with). */
export function aiQuotaNoticeText(job: string): string {
  return `${AI_QUOTA_PAUSED_TEXT} (${job} hit it first.) This is also on the bell, and it clears itself on the next successful call.`;
}
export const aiQuotaRecoveredText = (): string => `${AI_QUOTA_RECOVERED_TEXT} The out-of-credit alert has cleared.`;

export interface AiQuotaStore {
  /** Open the owner's ONE row. True ONLY for the call that opened it (no row, or an auto-cleared one); an open or a
   *  dismissed row is the same outage and writes nothing. */
  raise(r: { id: string; ownerEmail: string; job: string; title: string; detail: string; huddleId: string }): Promise<boolean>;
  /** End the outage (open or dismissed row -> auto-cleared). True ONLY for the call that ended it. */
  clear(id: string, ownerEmail: string): Promise<boolean>;
}

/** Post a FIXED notice in Iris's 1:1 (durable turn + the usual phone push). Must make no model call. */
export type AiQuotaNotifier = (r: { ownerEmail: string; id: string; kind: "outage" | "recovered"; text: string; nowMs: number }) => Promise<boolean>;

export interface AiQuotaDeps {
  store: AiQuotaStore;
  notify?: AiQuotaNotifier;
  now(): number;
  log(line: string): void;
  /** Per-instance throttle on store calls (the store itself is what dedupes across instances). Default 60s. */
  throttleMs?: number;
  /** Iris also posts "working again" when the outage ends. Default FALSE (owner 2026-11-17: one message per
   *  outage -- the bell row auto-clears silently). Opt in with true. */
  recoveryNotice?: boolean;
}

export type FailureOutcome = "alerted" | "already_open" | "throttled" | "not_quota" | "no_owner" | "store_failed";
export type SuccessOutcome = "cleared" | "nothing_open" | "throttled" | "no_owner" | "store_failed";

/** Pure: the public-safe failure log line (job + kind only). */
export const aiFailureLogLine = (job: string, kind: string, quota: boolean) =>
  `[ai-job] job=${job.replace(/[^\w:./ -]/g, "").slice(0, 60)} failed kind=${kind}${quota ? " quota=true" : ""}`;

/** The monitor. One per process (the server module holds it); tests make their own with fakes. Never throws. */
export function createAiQuotaMonitor(deps: AiQuotaDeps) {
  const throttle = deps.throttleMs ?? 60_000;
  const lastRaise = new Map<string, number>();
  const lastClear = new Map<string, number>();
  const due = (m: Map<string, number>, k: string, now: number) => !(now - (m.get(k) ?? -Infinity) < throttle);

  async function onFailure(job: string, owner: string | null | undefined, err: unknown): Promise<FailureOutcome> {
    const kind = aiFailureKind(err);
    const msg = String((err as { message?: unknown })?.message ?? err ?? "");
    const quota = isQuotaError(msg); // THE existing detector -- no parallel one
    deps.log(aiFailureLogLine(job, kind, quota));
    if (!quota) return "not_quota";
    const o = owner?.trim().toLowerCase();
    if (!o) return "no_owner";
    const now = deps.now();
    if (!due(lastRaise, o, now)) return "throttled";
    lastRaise.set(o, now);
    lastClear.delete(o); // a success right after a quota error must re-check the store
    const id = aiQuotaAttentionId(o);
    const { title, detail } = aiQuotaAlertText(job);
    let opened = false;
    try {
      opened = await deps.store.raise({ id, ownerEmail: o, job, title, detail, huddleId: AI_QUOTA_HUDDLE });
    } catch (e) {
      deps.log(`[ai-quota] raise failed ${e instanceof Error ? e.name : "error"}`);
      lastRaise.delete(o);
      return "store_failed";
    }
    if (!opened) return "already_open";
    deps.log(`[ai-quota] alert raised job=${job}`);
    if (deps.notify) {
      try {
        await deps.notify({ ownerEmail: o, id, kind: "outage", text: aiQuotaNoticeText(job), nowMs: now });
      } catch (e) {
        deps.log(`[ai-quota] notice failed ${e instanceof Error ? e.name : "error"}`);
      }
    }
    return "alerted";
  }

  async function onSuccess(job: string, owner: string | null | undefined): Promise<SuccessOutcome> {
    const o = owner?.trim().toLowerCase();
    if (!o) return "no_owner";
    const now = deps.now();
    if (!due(lastClear, o, now)) return "throttled";
    lastClear.set(o, now);
    let cleared = false;
    try {
      cleared = await deps.store.clear(aiQuotaAttentionId(o), o);
    } catch (e) {
      deps.log(`[ai-quota] clear failed ${e instanceof Error ? e.name : "error"}`);
      lastClear.delete(o);
      return "store_failed";
    }
    if (!cleared) return "nothing_open";
    lastRaise.delete(o); // the outage ended: the next quota error must reach the store at once
    deps.log(`[ai-quota] alert cleared job=${job}`);
    if (deps.notify && deps.recoveryNotice === true) {
      try {
        await deps.notify({ ownerEmail: o, id: aiQuotaAttentionId(o), kind: "recovered", text: aiQuotaRecoveredText(), nowMs: now });
      } catch (e) {
        deps.log(`[ai-quota] notice failed ${e instanceof Error ? e.name : "error"}`);
      }
    }
    return "cleared";
  }

  return { onFailure, onSuccess };
}

// ---------------------------------------------------------------------------------------------
// The system-notice turn: a durable turn whose reply is FIXED text, so running it makes no model call.
// ---------------------------------------------------------------------------------------------

export interface SystemNoticePayload {
  systemNotice: { agentId: string; text: string };
  huddleId: string;
}

/** Pure: a stored turn payload -> its finished result, or null when it is not a system notice (then the turn runs
 *  exactly as before). executeClaimedTurn checks this BEFORE anything that could call a model. */
export function systemNoticeResult(payload: unknown): { replies: { agentId: string; text: string }[]; suggestedTasks: []; journeyTaskUpdates: [] } | null {
  const n = (payload as { systemNotice?: { agentId?: unknown; text?: unknown } } | null)?.systemNotice;
  if (!n || typeof n.agentId !== "string" || typeof n.text !== "string" || !n.agentId || !n.text.trim()) return null;
  return { replies: [{ agentId: n.agentId, text: n.text.slice(0, 2000) }], suggestedTasks: [], journeyTaskUpdates: [] };
}

/** Pure: the payload for Iris's notice turn (the push path reads huddleId / notify / caller like any turn). */
export function systemNoticePayload(ownerEmail: string, text: string): SystemNoticePayload & Record<string, unknown> {
  return {
    systemNotice: { agentId: AI_QUOTA_AGENT, text },
    huddleId: AI_QUOTA_HUDDLE,
    scope: "one-to-one",
    members: [AI_QUOTA_AGENT],
    targetAgentId: AI_QUOTA_AGENT,
    caller: { entra_email: ownerEmail },
    notify: "push",
    internal: true,
  };
}

/** The notice turn id: `aiquota-<outage|recovered>-<hash>-<minute>` -- never a user-turn shape (`u-`/`xapp-`), so
 *  the client never renders a "You" line for it. */
export const systemNoticeTurnId = (id: string, kind: "outage" | "recovered", nowMs: number) =>
  `aiquota-${kind}-${id.slice(-16)}-${Math.floor(nowMs / 60_000)}`;

/** Pure: the bell's name for an agent-initiated durable turn, from its id's semantic prefix
 *  (`autowork-...` -> "Agent turn (autowork)"). */
export function agentTurnJob(turnId: string): string {
  const seg = (turnId.match(/^[a-z]+/i)?.[0] ?? "").toLowerCase();
  return seg ? `Agent turn (${seg})` : "Agent turn";
}
