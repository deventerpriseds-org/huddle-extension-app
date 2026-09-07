// Per-agent-or-global "required vs discretionary" toggle for the WIP confirm-intent + review gate
// (docs/plan-wip-confirm-review-gate.md, Part 0). Mirrors user-context.server.ts's pool/bootstrap
// pattern exactly. Email-scoped, whole-object upsert (same shape as artifacts.mirror_config).
import { Pool } from "pg";
import { AGENTS, type AgentId } from "../../data/agents";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new Error("AZURE_PG_URL not configured");
  _pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  return _pool;
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS identity;
CREATE TABLE IF NOT EXISTS identity.agent_workflow_config (
  email            TEXT PRIMARY KEY,
  default_required BOOLEAN NOT NULL DEFAULT false,
  agent_overrides  JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Configurable caps for the approach gate / review gate / clarifying-question loops — how many
-- bounded auto-revisions/questions happen before the agent escalates to the user instead of looping
-- forever or silently proceeding. default_caps applies to every agent; agent_cap_overrides carries
-- a partial {approach?,review?,question?} per agent id, same default+override shape as agent_overrides.
ALTER TABLE identity.agent_workflow_config ADD COLUMN IF NOT EXISTS default_caps JSONB NOT NULL DEFAULT '{"approach":3,"review":3,"question":2}'::jsonb;
ALTER TABLE identity.agent_workflow_config ADD COLUMN IF NOT EXISTS agent_cap_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Identity unification: key on the stable user_id (entra_object_id) with email retained as a fallback +
-- display. Resolved in-store from the passed email via resolveScopeByEmail, so both of a user's emails
-- converge to one config row regardless of which email a caller presents.
ALTER TABLE identity.agent_workflow_config ADD COLUMN IF NOT EXISTS user_id TEXT;
-- Agent email SEND gate (2026-09-07, owner: "d4 is drafts only for now but be able to quickly set it
-- to send by design once I'm comfortable enough"). FALSE = agents may only create drafts; the
-- send_email tool is not offered to the model at all and sendGraphEmail refuses. Flipping this one
-- boolean to true re-enables sending on the very next turn — no code change, no redeploy (nothing
-- caches it; getAgentWorkflowConfig queries on every call). email_send_agent_overrides is the same
-- per-agent partial-override shape as agent_cap_overrides: {"<agentId>": true|false}. It is a
-- SEPARATE column from agent_overrides on purpose — that one's booleans already mean "structured
-- workflow required", so reusing it would give one value two contradictory meanings.
ALTER TABLE identity.agent_workflow_config ADD COLUMN IF NOT EXISTS email_send_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE identity.agent_workflow_config ADD COLUMN IF NOT EXISTS email_send_agent_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS agent_workflow_config_userid_idx ON identity.agent_workflow_config(user_id);
`;

let bootstrapped: Promise<void> | null = null;
async function ensureBootstrapped() {
  if (bootstrapped) return bootstrapped;
  bootstrapped = (async () => {
    await getPool().query(BOOTSTRAP_SQL);
  })();
  try {
    await bootstrapped;
  } catch (e) {
    bootstrapped = null;
    throw e;
  }
}

export interface WorkflowCaps {
  /** Max bounded auto-revisions on the pre-work approach gate before escalating to the user. */
  approach: number;
  /** Max bounded auto-revisions on the post-work review gate before escalating to the user. */
  review: number;
  /** Max clarifying questions an agent may ask on one task before it must flag_blocker or proceed. */
  question: number;
}

const DEFAULT_CAPS: WorkflowCaps = { approach: 3, review: 3, question: 2 };

export interface AgentWorkflowConfig {
  default_required: boolean;
  agent_overrides: Record<string, boolean>;
  default_caps: WorkflowCaps;
  agent_cap_overrides: Record<string, Partial<WorkflowCaps>>;
  /** Agents may SEND email (not just draft it). Defaults to false — drafts only. */
  email_send_enabled: boolean;
  /** Per-agent override of email_send_enabled, same shape as agent_cap_overrides. */
  email_send_agent_overrides: Record<string, boolean>;
}

// Gate is ON by default (2026-08-05): the confirm-intent/DoD gate is a SAFETY gate, so a user (or an
// email-scoping miss) with no explicit config row must land on "required", never "autonomous". This also
// makes the gate immune to the caller→email resolution being fragile (resolveTaskEmail falls back to the
// raw login email when journey `whoami` transiently fails, so the same user can be scoped under two
// emails — dev@ vs von.ellis@): with default ON, ANY resolved email with no explicit off yields gate-on.
// A user who genuinely wants autonomous agents sets default_required=false explicitly.
const DEFAULT_CONFIG: AgentWorkflowConfig = {
  default_required: true,
  agent_overrides: {},
  default_caps: DEFAULT_CAPS,
  agent_cap_overrides: {},
  // Drafts only until the owner flips it. This default is the whole point of the setting: a user with
  // no config row, or an email-scoping miss, must land on "cannot send", never on "can send".
  email_send_enabled: false,
  email_send_agent_overrides: {},
};

/** Read the config for an email. Returns the default (all discretionary) when nothing is set.
 *  Dual-read: prefers the row keyed on the resolved user_id, falling back to any email alias for an
 *  un-migrated (user_id NULL) row — so both of a user's emails resolve to the SAME config. */
export async function getAgentWorkflowConfig(email: string): Promise<AgentWorkflowConfig> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("./identity.server");
  const { userId, emails } = await resolveScopeByEmail(email);
  const r = await getPool().query<{
    default_required: boolean;
    agent_overrides: Record<string, boolean>;
    default_caps: Partial<WorkflowCaps>;
    agent_cap_overrides: Record<string, Partial<WorkflowCaps>>;
    email_send_enabled: boolean;
    email_send_agent_overrides: Record<string, boolean>;
  }>(
    userId
      ? `SELECT default_required, agent_overrides, default_caps, agent_cap_overrides,
                 email_send_enabled, email_send_agent_overrides
           FROM identity.agent_workflow_config
          WHERE user_id = $1 OR (user_id IS NULL AND lower(email) = ANY($2))
          ORDER BY (user_id IS NOT NULL) DESC, updated_at DESC
          LIMIT 1`
      : `SELECT default_required, agent_overrides, default_caps, agent_cap_overrides,
                 email_send_enabled, email_send_agent_overrides
           FROM identity.agent_workflow_config WHERE lower(email) = lower($1) LIMIT 1`,
    userId ? [userId, emails] : [email],
  );
  if (r.rowCount === 0) return DEFAULT_CONFIG;
  return {
    default_required: r.rows[0].default_required,
    agent_overrides: r.rows[0].agent_overrides ?? {},
    default_caps: { ...DEFAULT_CAPS, ...(r.rows[0].default_caps ?? {}) },
    agent_cap_overrides: r.rows[0].agent_cap_overrides ?? {},
    email_send_enabled: r.rows[0].email_send_enabled === true,
    email_send_agent_overrides: r.rows[0].email_send_agent_overrides ?? {},
  };
}

/** Whole-object upsert, same pattern as artifacts.mirror_config / setMirrorConfigFn. */
export async function setAgentWorkflowConfig(
  email: string,
  patch: Partial<AgentWorkflowConfig>,
): Promise<AgentWorkflowConfig> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("./identity.server");
  const { userId } = await resolveScopeByEmail(email);
  const current = await getAgentWorkflowConfig(email);
  const next: AgentWorkflowConfig = {
    default_required: patch.default_required ?? current.default_required,
    agent_overrides: patch.agent_overrides ?? current.agent_overrides,
    default_caps: patch.default_caps ?? current.default_caps,
    agent_cap_overrides: patch.agent_cap_overrides ?? current.agent_cap_overrides,
    email_send_enabled: patch.email_send_enabled ?? current.email_send_enabled,
    email_send_agent_overrides:
      patch.email_send_agent_overrides ?? current.email_send_agent_overrides,
  };
  // Dual-write: user_id (primary going forward) + email (retained for display/fallback). Upsert stays on
  // the email PK (the canonical email is stable per user); user_id is set/refreshed when resolvable.
  await getPool().query(
    `INSERT INTO identity.agent_workflow_config
       (email, default_required, agent_overrides, default_caps, agent_cap_overrides, user_id,
        email_send_enabled, email_send_agent_overrides, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (email) DO UPDATE SET
       default_required=EXCLUDED.default_required, agent_overrides=EXCLUDED.agent_overrides,
       default_caps=EXCLUDED.default_caps, agent_cap_overrides=EXCLUDED.agent_cap_overrides,
       email_send_enabled=EXCLUDED.email_send_enabled,
       email_send_agent_overrides=EXCLUDED.email_send_agent_overrides,
       user_id=COALESCE(EXCLUDED.user_id, identity.agent_workflow_config.user_id), updated_at=now()`,
    [
      email,
      next.default_required,
      JSON.stringify(next.agent_overrides),
      JSON.stringify(next.default_caps),
      JSON.stringify(next.agent_cap_overrides),
      userId,
      next.email_send_enabled,
      JSON.stringify(next.email_send_agent_overrides),
    ],
  );
  return next;
}

/**
 * Resolve the bounded-loop caps for this agent, right now, for this email. Per-agent override wins
 * per-field; falls back to the global default. Never throws — a config-read failure resolves to the
 * hardcoded defaults rather than blocking the gates entirely.
 */
export async function getWorkflowCaps(email: string, agentId: string): Promise<WorkflowCaps> {
  try {
    const cfg = await getAgentWorkflowConfig(email);
    return { ...cfg.default_caps, ...(cfg.agent_cap_overrides[agentId] ?? {}) };
  } catch {
    return DEFAULT_CAPS;
  }
}

/**
 * Resolve whether the confirm-intent/DoD gate + hardened review gate are REQUIRED for this
 * agent, right now, for this email. Per-agent override wins; falls back to the global default.
 * Never throws — but on a config-read failure it FAILS CLOSED (returns `true`, i.e. require
 * confirmation). Rationale (2026-08-05 incident): the old fail-OPEN (`return false`) silently
 * disabled BOTH gates during a transient config-pool error, letting 8 unconfirmed tasks reach
 * IN_REVIEW. Holding a task out of review is recoverable (retried next pass); wrongly flipping
 * unconfirmed work into review is not — so when in doubt, require the confirm. The error is logged
 * (previously swallowed), so a recurring config failure is visible instead of silently permissive.
 */
export async function isStructuredWorkflowRequired(email: string, agentId: string): Promise<boolean> {
  try {
    const cfg = await getAgentWorkflowConfig(email);
    const override = cfg.agent_overrides[agentId];
    return typeof override === "boolean" ? override : cfg.default_required;
  } catch (err) {
    console.error(
      `[isStructuredWorkflowRequired] config read failed for ${email}/${agentId}; failing CLOSED (required=true):`,
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

/**
 * User-level requirement when the agent is unknown (e.g. an artifact save with no bound persona).
 * Same fail-closed contract as `isStructuredWorkflowRequired` — a config-read failure returns `true`.
 */
export async function isStructuredWorkflowRequiredForUser(email: string): Promise<boolean> {
  try {
    return (await getAgentWorkflowConfig(email)).default_required;
  } catch (err) {
    console.error(
      `[isStructuredWorkflowRequiredForUser] config read failed for ${email}; failing CLOSED (required=true):`,
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

/**
 * Resolve whether agents may actually SEND email (as opposed to only creating drafts) for this user,
 * right now. Per-agent override wins; falls back to the global default; the global default is FALSE.
 *
 * FAILS CLOSED, and "closed" here means `false` — DRAFTS ONLY. This is the mirror image of
 * isStructuredWorkflowRequired's `catch { return true }`, not a contradiction of it: both return the
 * value that cannot cause an irreversible action. A sent email cannot be unsent; a missing send is
 * recoverable (the user opens the draft and clicks send). So EVERY failure path — no email resolved,
 * config pool throw, missing column, transient network — must land on `false`.
 *
 * DO NOT "simplify" this to `catch { return true }` or to a truthy default. The 2026-08-05 incident
 * (8 unconfirmed tasks reached IN_REVIEW because a single transient pool throw hit a fail-OPEN catch)
 * is the same failure mode with a different blast radius; here the blast radius is real mail leaving
 * the tenant.
 *
 * Owner's decision, 2026-09-07: "d4 is drafts only for now but be able to quickly set it to send by
 * design once I'm comfortable enough." The flip is:
 *   UPDATE identity.agent_workflow_config SET email_send_enabled = true, updated_at = now()
 *    WHERE lower(email) = lower('<the owner email>');
 * Nothing caches the result — getAgentWorkflowConfig queries on every call — so it takes effect on
 * the next turn / next voice mint with no redeploy.
 */
export async function isEmailSendEnabled(
  email: string | null | undefined,
  agentId?: string,
): Promise<boolean> {
  if (!email || !email.trim()) {
    // No resolved identity means no config row can be read, so there is no affirmative permission to
    // send. Closed by definition, not by error.
    console.warn("[isEmailSendEnabled] no caller email resolved; failing CLOSED (drafts only)");
    return false;
  }
  try {
    const cfg = await getAgentWorkflowConfig(email);
    const override = agentId ? cfg.email_send_agent_overrides[agentId] : undefined;
    return typeof override === "boolean" ? override : cfg.email_send_enabled === true;
  } catch (err) {
    console.error(
      `[isEmailSendEnabled] config read failed for ${email}/${agentId ?? "-"}; failing CLOSED (drafts only):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Agent ids in roster order, for building the Settings panel's per-agent override list. */
export function agentWorkflowRosterIds(): AgentId[] {
  return AGENTS.map((a) => a.id);
}
