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

const DEFAULT_CONFIG: AgentWorkflowConfig = {
  default_required: false,
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
 * Never throws — a config-read failure resolves to `false` (today's existing, more autonomous
 * behavior) rather than silently blocking work.
 */
export async function isStructuredWorkflowRequired(email: string, agentId: string): Promise<boolean> {
  try {
    const cfg = await getAgentWorkflowConfig(email);
    const override = cfg.agent_overrides[agentId];
    return typeof override === "boolean" ? override : cfg.default_required;
  } catch {
    return false;
  }
}

/** Agent ids in roster order, for building the Settings panel's per-agent override list. */
export function agentWorkflowRosterIds(): AgentId[] {
  return AGENTS.map((a) => a.id);
}
