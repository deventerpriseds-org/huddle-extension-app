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

import { AGENTS } from "@/features/huddle/data/agents";

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
};

export type TurnInput = {
  text: string;
  huddleId: string;
  scope: "group" | "one-to-one";
  members: string[];
  history: unknown[];
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
    // THE LINE THE WHOLE ROUTE EXISTS FOR. Server-held, never caller-supplied.
    caller: { entra_email: subject.entra_email },
  };
  if (typeof body.timeZone === "string" && body.timeZone) input.timeZone = body.timeZone;
  return { ok: true, value: input };
}

/**
 * Project the turn result down to what an external caller needs. Deliberately NARROW.
 *
 * `replies` is the answer. `toolUses` is projected to `{agentId, tool, ok}` -- names and outcomes,
 * never the free-text `summary` -- and `prompts`/`reasoning`/`suggestedTasks` are dropped entirely,
 * because they carry model-authored prose that can quote the resolved subject's email or other
 * account detail back to a caller that must not learn it.
 */
export function projectTurnResult(result: unknown): {
  replies: unknown[];
  toolUses: { agentId: unknown; tool: unknown; ok: unknown }[];
} {
  const r = (result ?? {}) as { replies?: unknown; toolUses?: unknown };
  const replies = Array.isArray(r.replies) ? r.replies : [];
  const toolUses = Array.isArray(r.toolUses)
    ? r.toolUses.map((t) => {
        const u = (t ?? {}) as Record<string, unknown>;
        return { agentId: u.agentId, tool: u.tool, ok: u.ok };
      })
    : [];
  return { replies, toolUses };
}
