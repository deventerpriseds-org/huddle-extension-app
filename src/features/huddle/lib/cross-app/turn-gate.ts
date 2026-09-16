// WHAT:       The authorisation gate and request adapter for POST /api/public/run-agent-turn --
//             the authenticated, app-agnostic HTTP door onto ONE Huddle agent turn. Pure functions,
//             no I/O, so every guard here is unit-testable and mutation-provable offline.
// WHY:        Huddle's existing turn entrypoint, the `sendHuddleMessage` server function, accepts an
//             ANONYMOUS POST and takes the acting user's identity from an unverified request body
//             field (`caller.entra_email`). Measured 2026-09-07 in BATCH-5-RESULTS.md test 5.2:
//             HTTP 200 x6 from an external host with NO credential sent. So anyone who can reach the
//             site and knows the current build content-hash can drive a turn AS ANY USER. This module
//             is the fix: the caller is authenticated by the shared secret, and the acting subject is
//             a pure function of SERVER-HELD configuration that no byte of the request can influence.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   nexus-hub docs/cross-app-agent/AC-run-agent-turn.md (independent AC pass, 46 criteria)
//             and docs/cross-app-agent/FIX-run-agent-turn.md (design + mutation outcomes).
//
// THE TWO QUESTIONS, kept apart on purpose -- conflating them is the whole defect being fixed:
//
//   Q1 WHO IS CALLING?      -> `x-webhook-secret` == JOURNEY_PROXY_TOKEN. Proves "a trusted
//                              integrating app". Proves NOTHING about which human it acts for.
//   Q2 ON WHOSE BEHALF?     -> CROSS_APP_TURN_SUBJECT, a server-held app setting. The request has
//                              NO input to this answer -- not a header, not a body field, not a
//                              query string.
//
// The estate-wide pattern (ARCH-bridge.md 7.2) answers Q2 from the body, and that is safe for the
// sibling routes because each runs a FIXED, pre-scoped operation (mirror a task row, run a ceremony,
// send a push). This route takes FREE TEXT and hands it to an agent holding the user's board, memory,
// mailbox and 40+ tools, so "whose data does this act on" is the entire security question. Keeping
// the body field here would have moved the defect to a new URL instead of closing it.

import { createHash } from "node:crypto";
import { AGENTS } from "@/features/huddle/data/agents";
import assistantIds from "@/features/huddle/data/assistant-ids.json";

/** The env var naming the acting subject. NOT A CREDENTIAL -- it is an identifier, and it is safe
 *  in plaintext config. It must never be rotated as though it were a secret, and a new SECRET must
 *  never be minted for this route (standing rule: reuse JOURNEY_PROXY_TOKEN). */
export const SUBJECT_ENV = "CROSS_APP_TURN_SUBJECT";

/** Body cap. Sized for a 4000-char `text` plus a modest `history`; same shape as every sibling. */
export const MAX_BODY_BYTES = 64_000;

/** Stable defaults for the turn fields an external caller has no concept of. `huddleId` is a
 *  CONSTANT, not a per-call value: two calls from the same app must land in the same conversation,
 *  or every turn starts an undiscoverable new one. */
export const DEFAULT_HUDDLE_ID = "all-members";
export const DEFAULT_SCOPE = "group" as const;

/** Built from the roster, never from literals, so renaming or removing an agent cannot leave a
 *  stale id here that `Input`'s `z.enum(AgentIds)` would reject at runtime. */
export function defaultMembers(): string[] {
  return AGENTS.map((a) => a.id);
}

/**
 * THE PER-AGENT BACKEND CONFIG THE FORWARDED TURN CARRIES -- and the fix for the defect that
 * actually explains "the Huddle agent was unaware of the Nexus conversation".
 *
 * `runHuddleTurn` gates BOTH halves of memory on per-agent RAG configuration read from
 * `data.agents`, and this adapter never set it:
 *
 *   WRITE      huddle.functions.ts  `const ragAgents = data.members.map(id => agentsCfg[id]?.rag)
 *                                    .filter(x => x && x.store === "azure" && x.cfg.chunks)`
 *                                   -- empty, so the `if (... anyShared || privateAgents.length)`
 *                                   block never runs and NOTHING is written to rag_chunks.
 *   RETRIEVAL  huddle.functions.ts  `const ragCfg = agentBackend.rag;
 *                                    if (!isCeremonyTrigger && ragCfg && ragCfg.store === "azure"
 *                                        && ragCfg.chunks && openaiKey)`
 *                                   -- `ragCfg` is undefined, so auto-retrieval never runs and no
 *                                   memoryBlock reaches the prompt.
 *
 * So a forwarded turn that ran PERFECTLY wrote nothing and recalled nothing: memory-blind in both
 * directions. `data.agents` being `.optional()` in the schema is why this parsed cleanly and failed
 * silently. Two independent `if` statements on the same missing config -- which is why C1 (write)
 * and C2 (read) are separate criteria and why the guard below asserts the SHAPE, not the symptom.
 *
 * WHY THIS IS BUILT HERE AND NOT IMPORTED FROM `agent-backends.ts`: that module's `defaultAgents()`
 * is not exported, and the module itself instantiates a zustand store with the `persist` middleware
 * at import time -- a browser-storage-backed singleton that a server route has no business pulling
 * in. `assistant-ids.json` is the same JSON `agent-backends.ts` reads, imported directly, so the
 * assistant ids cannot drift between the two.
 *
 * DELIBERATELY NARROWER THAN THE CLIENT'S DEFAULT, and this is a scope decision, not an oversight:
 * `defaultAgents()` also sets `journey: { enabled: true }` and `webSearch: true`. Turning those on
 * here would widen what an unattended, machine-driven turn can DO (journey task/email/push tools,
 * paid web search) beyond anything the criteria ask for. No criterion in AC-turn-is-real needs
 * them; C1/C2/C3/D1 need `rag`. They are one line away if the owner wants full parity.
 */
export function crossAppAgentBackends(members: string[]): Record<string, CrossAppAgentBackend> {
  const ids = assistantIds as Record<string, string | undefined>;
  const out: Record<string, CrossAppAgentBackend> = {};
  for (const id of members) {
    const assistantId = ids[id];
    out[id] = {
      // Mirrors defaultAgents(): an agent WITH a platform assistant runs the OpenAI path so it
      // answers as itself from its snapshot persona; one without falls back exactly as the client's
      // default does. Previously `agents` was absent entirely, so every cross-app responder took
      // `?? { backend: "lovable" }` at huddle.functions.ts -- the fallback, never a chosen path.
      backend: assistantId ? ("openai" as const) : ("lovable" as const),
      ...(assistantId ? { assistantId } : {}),
      // THE FIELD THE WHOLE MEMORY DEFECT TURNS ON. Same values as the client's `defaultRag`.
      rag: {
        store: "azure" as const,
        chunks: true,
        triples: true,
        fileSearch: true,
        sharing: "shared" as const,
      },
      // THE SAME DEFECT, ONE FIELD OVER, found by the 2026-09-08 status audit. `rag` was absent and
      // made the forward memory-blind; `journey` was absent and made it TOOL-blind. Neither omission
      // was deliberate -- there was never a comment claiming otherwise, only silence, which is how
      // an omission survives a review that reads what IS there.
      //
      // Consequence measured across the 77-row ledger: 13 Part B scenarios were NOT BUILT for this
      // reason alone, because `ensureJourneyTools()` filters members on `agents[id].journey.enabled`
      // and no member had the key at all -- so a forwarded turn saw NONE of journey's catalogue.
      //
      // Worse than absent, and the reason this is not a nice-to-have: `create_huddle_task` skipped
      // its journey write, fell to the Huddle-only card path, returned ok:true -- and
      // `projectTurnResult` then dropped `suggestedTasks` before the reply left Huddle. The user was
      // told the task was added and NO ROW EXISTED ANYWHERE. That path is closed by opening this one.
      //
      // No new exposure: journey tools act as the server-held CROSS_APP_TURN_SUBJECT, the same
      // identity the memory writes above already use, and the route still refuses any caller-supplied
      // identity at any depth. Mirrors `defaultAgents()`, which is the contract this function exists
      // to reproduce.
      journey: { enabled: true },
    };
  }
  return out;
}

export type CrossAppAgentBackend = {
  backend: "openai" | "lovable";
  assistantId?: string;
  rag: {
    store: "azure";
    chunks: boolean;
    triples: boolean;
    fileSearch: boolean;
    sharing: "shared";
  };
  /**
   * REQUIRED, not optional, and that is the point.
   *
   * Both cross-app defects so far were a MISSING FIELD on this object -- `rag` (memory-blind) and
   * then `journey` (tool-blind, and the cause of a create that reported success and stored nothing).
   * An optional field cannot fail a typecheck when it is left out, so the type was silent on exactly
   * the mistake being made twice. Declaring it required means the compiler now refuses the third
   * instance of this shape rather than shipping it.
   *
   * Add any FUTURE per-agent capability flag here as required too, and let `crossAppAgentBackends`
   * decide its value deliberately -- an omission should be a build error, never a runtime surprise.
   */
  journey: { enabled: boolean };
};

/** Idempotency-key prefix for a forwarded turn. Visible in `chat.pending_turns.id`, so a row's
 *  origin is readable at a glance without a join.
 *
 *  RE-EXPORTED, not redefined. It also decides whether the Huddle UI renders the user's half of a
 *  forwarded turn (`lib/turn-identity.ts`), and two of those callers are browser components that
 *  cannot import this file -- it pulls in `node:crypto`. Two spellings of the prefix would mean the
 *  UI silently stops recognising forwarded turns the day either one changes. */
export { CROSS_APP_TURN_ID_PREFIX } from "../turn-identity";
import { CROSS_APP_TURN_ID_PREFIX } from "../turn-identity";

/**
 * The DURABLE TURN ID for one forwarded turn -- deterministic, so a caller retry is idempotent
 * rather than a second billed run of the same message (AC B5).
 *
 * `enqueueTurn` is `INSERT ... ON CONFLICT DO NOTHING` and execution is claim-locked, so two
 * requests carrying the same id can only ever produce ONE row and ONE execution. That guarantee is
 * worth nothing if the id is freshly minted per attempt, which is the trap B5 names.
 *
 * The id is a hash of (subject, huddleId, text, window) where `window` is the 15-minute UTC bucket
 * the request lands in. The bucket is the deliberate compromise between the two failure modes:
 *   * a PURE content hash makes an identical question asked again next week replay the OLD answer
 *     forever -- an agent that looks broken;
 *   * NO hash at all double-runs every retry, which is today's behaviour and what B5 forbids.
 * A real retry follows within seconds, so it lands in the same bucket; a genuine repeat of the same
 * sentence in a later bucket runs fresh. A caller that wants the guarantee to be exact should send
 * its own `idempotencyKey` (below), which removes the time component entirely.
 *
 * `idempotencyKey` is NOT identity-shaped (`findCallerAssertedIdentity` does not list it, and it
 * cannot: it names a REQUEST, not a person) so it passes the identity refusal untouched.
 */
export function crossAppTurnId(args: {
  subject: string;
  huddleId: string;
  text: string;
  idempotencyKey?: string;
  now?: number;
}): string {
  const bucket = args.idempotencyKey
    ? `key:${args.idempotencyKey}`
    : `t:${Math.floor((args.now ?? Date.now()) / 900_000)}`;
  const digest = createHash("sha256")
    .update([args.subject, args.huddleId, args.text, bucket].join("\u001f"))
    .digest("hex")
    .slice(0, 40);
  return `${CROSS_APP_TURN_ID_PREFIX}${digest}`;
}

export type GateFailure = { ok: false; status: number; error: string };
export type GateOk<T> = { ok: true; value: T };
export type GateResult<T> = GateOk<T> | GateFailure;

/**
 * Q1 -- authenticate the CALLING APPLICATION. Byte-identical in behaviour to the nine sibling
 * routes: unset secret is 503 (never "no auth required"), mismatch is 401, and the comparison is
 * the same `!==` primitive they use. No novel comparator is introduced here on purpose -- a
 * bespoke one in one route out of ten is a divergence to maintain, not a security improvement.
 */
export function authenticateCaller(headers: {
  get(name: string): string | null;
}): GateResult<true> {
  const secret = process.env.JOURNEY_PROXY_TOKEN;
  if (!secret) return { ok: false, status: 503, error: "not_configured" };
  if (headers.get("x-webhook-secret") !== secret) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true, value: true };
}

/**
 * Q2 -- resolve the ACTING SUBJECT from server-held configuration only.
 *
 * FAILS CLOSED. An unset or blank subject returns 503 and the caller gets no turn. It must never
 * fall back to a body value, to "anonymous", or to a guess: a turn with no established subject
 * would run an agent's tools against whatever the downstream lookups happen to resolve, which is
 * the misattribution this route exists to prevent.
 */
export function resolveActingSubject(): GateResult<{ entra_email: string }> {
  const subject = process.env[SUBJECT_ENV]?.trim();
  if (!subject) return { ok: false, status: 503, error: "subject_not_configured" };
  return { ok: true, value: { entra_email: subject } };
}

/**
 * Identity keys, NORMALISED (lowercased, non-alphanumerics stripped) so that `entra_email`,
 * `Entra-Email` and `ENTRAEMAIL` are one and the same entry. Uniform handling regardless of casing
 * or nesting is a requirement in its own right: a block-list that refuses `caller` at the top level
 * but accepts `context.Caller` is worse than no block-list, because the gap is invisible.
 */
const IDENTITY_KEYS = new Set([
  "caller",
  "callers",
  "entraemail",
  "entraobjectid",
  "useremail",
  "email",
  "emails",
  "subject",
  "sub",
  "uid",
  "userid",
  "user",
  "username",
  "as",
  "runas",
  "actas",
  "actingas",
  "onbehalf",
  "onbehalfof",
  "impersonate",
  "impersonateas",
  "actor",
  "principal",
  "identity",
  "account",
  "upn",
  "oid",
  "objectid",
]);

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_NODES = 5_000;

/**
 * Return the first identity-shaped key found anywhere in the parsed body, at any depth and in any
 * casing, or null.
 *
 * This is BELT AND BRACES, not the actual defence. The actual defence is structural: `buildTurnInput`
 * constructs `caller` from the environment, so no body value can reach it however it is spelled.
 * This scan exists so a caller that BELIEVES it is choosing an identity is told plainly that it is
 * not -- silently ignoring the field is safe today and becomes a vulnerability the moment someone
 * later "helpfully" wires it through.
 */
export function findCallerAssertedIdentity(body: unknown): string | null {
  let nodes = 0;
  const walk = (node: unknown, depth: number, path: string): string | null => {
    if (node === null || typeof node !== "object") return null;
    if (depth > MAX_SCAN_DEPTH) return null;
    if (++nodes > MAX_SCAN_NODES) return null;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const hit = walk(node[i], depth + 1, `${path}[${i}]`);
        if (hit) return hit;
      }
      return null;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (IDENTITY_KEYS.has(normalizeKey(key))) return here;
      const hit = walk(value, depth + 1, here);
      if (hit) return hit;
    }
    return null;
  };
  return walk(body, 0, "");
}

export type CrossAppTurnBody = {
  text?: unknown;
  huddleId?: unknown;
  scope?: unknown;
  members?: unknown;
  history?: unknown;
  timeZone?: unknown;
  /** Optional caller-supplied idempotency key. Names a REQUEST, never a person, so it is not an
   *  identity-shaped field and is not refused by findCallerAssertedIdentity. When present it makes
   *  the durable turn id exact (see crossAppTurnId). */
  idempotencyKey?: unknown;
};

export type TurnInput = {
  text: string;
  huddleId: string;
  scope: "group" | "one-to-one";
  members: string[];
  history: unknown[];
  /** Per-agent backend + RAG configuration. ABSENT on this path until 2026-09-08, which is what
   *  made a forwarded turn memory-blind in both directions -- see crossAppAgentBackends. */
  agents: Record<string, CrossAppAgentBackend>;
  caller: { entra_email: string };
  timeZone?: string;
};

/** `Input.text` is `z.string().min(1).max(4000)` (huddle.functions.ts). Mirrored here so an
 *  over-long or empty text is REFUSED with a 400 rather than reaching the schema as a 500 -- and
 *  never silently truncated, which would run a turn on content the caller did not send. */
export const TEXT_MAX = 4000;

/**
 * Adapt a validated external request into the exact `Input` shape `runHuddleTurn` already takes.
 *
 * The `caller` is written HERE, from the resolved subject, and is the ONLY place it is set. Nothing
 * derived from `body` is used for it. `text` is passed through byte-for-byte: no trimming that could
 * change meaning, no truncation, no rewriting -- an adapter that edited the text would be a second
 * decision layer bolted in front of the router.
 */
export function buildTurnInput(
  body: CrossAppTurnBody,
  subject: { entra_email: string },
): GateResult<TurnInput> {
  const text = body.text;
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, status: 400, error: "missing_text" };
  }
  if (text.length > TEXT_MAX) {
    return { ok: false, status: 400, error: "text_too_long" };
  }

  const huddleId =
    typeof body.huddleId === "string" && body.huddleId.trim()
      ? body.huddleId.trim()
      : DEFAULT_HUDDLE_ID;
  const scope = body.scope === "one-to-one" ? "one-to-one" : DEFAULT_SCOPE;
  const members =
    Array.isArray(body.members) && body.members.length > 0
      ? (body.members as string[])
      : defaultMembers();
  const history = Array.isArray(body.history) ? body.history : [];

  const input: TurnInput = {
    text,
    huddleId,
    scope,
    members,
    history,
    // Memory ON, for exactly the members that will respond. Without this key `runHuddleTurn`
    // reads `data.agents ?? {}`, every `agentsCfg[id]?.rag` is undefined, and both the write and
    // the auto-retrieval gates evaluate false -- the forwarded turn writes nothing to rag_chunks
    // and gets no memoryBlock. See crossAppAgentBackends for the two gates, quoted.
    agents: crossAppAgentBackends(members),
    // THE LINE THE WHOLE ROUTE EXISTS FOR. Server-held, never caller-supplied.
    caller: { entra_email: subject.entra_email },
  };
  if (typeof body.timeZone === "string" && body.timeZone) input.timeZone = body.timeZone;
  return { ok: true, value: input };
}

/**
 * A TASK CARD as it crosses the cross-app boundary.
 *
 * A DISCRIMINATED UNION ON `persisted`, and that shape is the whole point -- the same reasoning that
 * made `journey` REQUIRED on CrossAppAgentBackend, applied one boundary further out.
 *
 *   * `persisted` is REQUIRED on both arms, so a card cannot be constructed without stating whether
 *     a canonical row exists. There is no "not sure" value and no default.
 *   * `note` is REQUIRED on the `persisted: false` arm ONLY. So it is not merely possible to say
 *     "this was not saved" -- it is impossible to emit an unsaved card WITHOUT saying it. A future
 *     edit that builds a suggestion and forgets the disclaimer is a build error, not a turn that
 *     quietly reads as a saved record on the far side.
 *
 * `persisted` is NOT a new vocabulary. It is the flag `create_huddle_task` already returns to the
 * model on its Huddle-only branch (`{ ok: true, task, boards: ["huddle"], persisted: false, note:
 * "SUGGESTED ONLY -- ..." }`, huddle.functions.ts). The projector cannot read it from there -- the
 * tool RESULT is not on the turn result, only the card it pushed is -- so the same distinction is
 * recovered from WHICH ARRAY the card arrived in. See projectTurnResult for that mapping.
 */
export type ProjectedTask =
  | { persisted: true; title: string; id?: string; lane?: string }
  | { persisted: false; title: string; id?: string; lane?: string; note: string };

/** The disclaimer carried on every non-persisted card. Deliberately the same words the tool result
 *  already hands the model, so the calling app and the agent cannot describe one card two ways. */
export const UNPERSISTED_TASK_NOTE =
  "SUGGESTED ONLY \u2014 no canonical row was written. Present this as a proposal awaiting approval; " +
  "do NOT present it as added, created or saved.";

/** Titles are model- or user-authored and unbounded on the journey side. Capped at the same 160 the
 *  Huddle draft path already applies (`title.slice(0, 160)`) so one arm cannot return more than the
 *  other for the same task. */
const TITLE_MAX = 160;

function readTitle(v: unknown): string | null {
  const t = (v ?? {}) as Record<string, unknown>;
  const title = typeof t.title === "string" ? t.title.trim() : "";
  return title ? title.slice(0, TITLE_MAX) : null;
}

/**
 * Project a turn's TASK CARDS for the calling app -- what the turn created, and what it merely
 * proposed, kept apart.
 *
 * THE TWO SOURCES ARE NOT TWO VIEWS OF ONE THING (huddle.functions.ts):
 *
 *   journeyTaskUpdates[]  pushed ONLY from `if (r.ok && r.tasks?.length) push(...r.tasks)` after an
 *                         `invokeJourneyTool` call -- i.e. a row journey ECHOED BACK out of its
 *                         canonical `public.tasks`, carrying journey's own uuid. A row here is
 *                         proof of a write.
 *   suggestedTasks[]      a Huddle-side `SuggestedTaskDraft` built in-process. Three push sites:
 *                         journey succeeded but echoed no row; the Huddle-only branch (journey
 *                         disabled or no caller -- the branch that returns `persisted: false`); and
 *                         the batch fallback. NONE of them is proof of a write, and only the first
 *                         is one in fact.
 *
 * SO THE MAPPING IS DELIBERATELY ASYMMETRIC AND FAILS TOWARD "SUGGESTED":
 *   - a `journeyTaskUpdates` entry becomes `persisted: true` ONLY when it carries BOTH a non-empty
 *     string `id` (journey's uuid -- the thing that makes it a row rather than a draft) and a title.
 *     Anything short of that is demoted to a suggestion rather than dropped or asserted as saved.
 *   - EVERY `suggestedTasks` entry becomes `persisted: false`, including the one case that really
 *     was written (journey ok, no echo). Under-claiming a real write costs the caller a redundant
 *     confirmation; over-claiming a write that never happened is the defect `5aaef9e` just closed
 *     and the one this projection must not reopen.
 *
 * A journey write that FAILED reaches neither array -- that handler returns `ok: false` and pushes
 * nothing -- so a failure can never appear here in any state. Checked in source, not assumed.
 *
 * ON `title` CROSSING THE BOUNDARY, since the sibling projection below drops model prose on purpose:
 * a title is not a debug channel, it is the PRODUCT of the turn -- a card with no title renders
 * nothing and the caller may as well have been sent an empty array. It carries the same exposure
 * `replies` already carries and is bounded the same way the Huddle board bounds it. The fields that
 * exist only to explain the model to itself -- `prompts`, `reasoning`, a tool use's free-text
 * `summary` -- are still dropped entirely.
 */
export function projectTurnTasks(result: unknown): ProjectedTask[] {
  const r = (result ?? {}) as { journeyTaskUpdates?: unknown; suggestedTasks?: unknown };
  const out: ProjectedTask[] = [];

  if (Array.isArray(r.journeyTaskUpdates)) {
    for (const row of r.journeyTaskUpdates) {
      const title = readTitle(row);
      if (!title) continue;
      const t = row as Record<string, unknown>;
      const id = typeof t.id === "string" && t.id.trim() ? t.id.trim() : null;
      const lane = typeof t.status === "string" && t.status ? t.status : undefined;
      if (!id) {
        // No journey uuid -> no evidence of a canonical row. Demote, never promote.
        out.push({ persisted: false, title, ...(lane ? { lane } : {}), note: UNPERSISTED_TASK_NOTE });
        continue;
      }
      out.push({ persisted: true, title, id, ...(lane ? { lane } : {}) });
    }
  }

  if (Array.isArray(r.suggestedTasks)) {
    for (const card of r.suggestedTasks) {
      const title = readTitle(card);
      if (!title) continue;
      const c = card as Record<string, unknown>;
      const id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : undefined;
      const lane = typeof c.lane === "string" && c.lane ? c.lane : undefined;
      out.push({
        persisted: false,
        title,
        ...(id ? { id } : {}),
        ...(lane ? { lane } : {}),
        note: UNPERSISTED_TASK_NOTE,
      });
    }
  }

  return out;
}

/**
 * Project the turn result down to what an external caller needs. Deliberately NARROW.
 *
 * `replies` is the answer. `toolUses` is projected to `{agentId, tool, ok}` -- names and outcomes,
 * never the free-text `summary` -- and `prompts`/`reasoning` are dropped entirely, because they
 * carry model-authored prose that can quote the resolved subject's email or other account detail
 * back to a caller that must not learn it.
 *
 * `tasks` (added 2026-09-08) is the one thing that was dropped and should not have been. A forwarded
 * turn can create a task; before this, the caller got reply prose and tool NAMES and no structured
 * view of what was created or proposed, so nothing downstream could render the card or tell a saved
 * row from a suggestion. See projectTurnTasks for the mapping and why it fails toward "suggested".
 */
export function projectTurnResult(result: unknown): {
  replies: unknown[];
  toolUses: { agentId: unknown; tool: unknown; ok: unknown }[];
  tasks: ProjectedTask[];
} {
  const r = (result ?? {}) as { replies?: unknown; toolUses?: unknown };
  const replies = Array.isArray(r.replies) ? r.replies : [];
  const toolUses = Array.isArray(r.toolUses)
    ? r.toolUses.map((t) => {
        const u = (t ?? {}) as Record<string, unknown>;
        return { agentId: u.agentId, tool: u.tool, ok: u.ok };
      })
    : [];
  return { replies, toolUses, tasks: projectTurnTasks(result) };
}
