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
};

/** Read the config for an email. Returns the default (all discretionary) when nothing is set. */
export async function getAgentWorkflowConfig(email: string): Promise<AgentWorkflowConfig> {
  await ensureBootstrapped();
  const r = await getPool().query<{
    default_required: boolean;
    agent_overrides: Record<string, boolean>;
    default_caps: Partial<WorkflowCaps>;
    agent_cap_overrides: Record<string, Partial<WorkflowCaps>>;
  }>(
    `SELECT default_required, agent_overrides, default_caps, agent_cap_overrides
       FROM identity.agent_workflow_config WHERE lower(email) = lower($1)`,
    [email],
  );
  if (r.rowCount === 0) return DEFAULT_CONFIG;
  return {
    default_required: r.rows[0].default_required,
    agent_overrides: r.rows[0].agent_overrides ?? {},
    default_caps: { ...DEFAULT_CAPS, ...(r.rows[0].default_caps ?? {}) },
    agent_cap_overrides: r.rows[0].agent_cap_overrides ?? {},
  };
}

/** Whole-object upsert, same pattern as artifacts.mirror_config / setMirrorConfigFn. */
export async function setAgentWorkflowConfig(
  email: string,
  patch: Partial<AgentWorkflowConfig>,
): Promise<AgentWorkflowConfig> {
  await ensureBootstrapped();
  const current = await getAgentWorkflowConfig(email);
  const next: AgentWorkflowConfig = {
    default_required: patch.default_required ?? current.default_required,
    agent_overrides: patch.agent_overrides ?? current.agent_overrides,
    default_caps: patch.default_caps ?? current.default_caps,
    agent_cap_overrides: patch.agent_cap_overrides ?? current.agent_cap_overrides,
  };
  await getPool().query(
    `INSERT INTO identity.agent_workflow_config
       (email, default_required, agent_overrides, default_caps, agent_cap_overrides, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (email) DO UPDATE SET
       default_required=EXCLUDED.default_required, agent_overrides=EXCLUDED.agent_overrides,
       default_caps=EXCLUDED.default_caps, agent_cap_overrides=EXCLUDED.agent_cap_overrides, updated_at=now()`,
    [
      email,
      next.default_required,
      JSON.stringify(next.agent_overrides),
      JSON.stringify(next.default_caps),
      JSON.stringify(next.agent_cap_overrides),
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

/** Agent ids in roster order, for building the Settings panel's per-agent override list. */
export function agentWorkflowRosterIds(): AgentId[] {
  return AGENTS.map((a) => a.id);
}
