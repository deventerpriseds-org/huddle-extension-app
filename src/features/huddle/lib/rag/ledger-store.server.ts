// A2 — the user's "story-bible" ledger: a compact, authoritative record of the durable facts and LISTS
// the user is actively tracking (budgets, dates, vendor/attendee/item lists, decisions, statuses). It is
// USER-scoped (not per-huddle) so it bridges conversations exactly like shared RAG — a vendor list stated
// in the group is current in any 1:1. It exists because triples supersede cleanly for SCALAR facts that
// get restated, but a LIST edited by deltas ("drop Cobalt, add Delta") never produces a superseding
// same-key triple, so the stale list survives. The ledger models lists as first-class mutable state:
// add/remove/set ops applied to a JSON doc, then injected as "currently tracked (authoritative latest)".
//
// "researched" memory mode only. EVERYTHING here is best-effort and fails to a no-op — a DB/LLM error
// never blocks or breaks a turn (the reply has already returned when the update runs).

import { Pool } from "pg";

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
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.user_ledger (
  user_email TEXT PRIMARY KEY,
  ledger     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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

/** One tracked entry: a scalar fact ("offsite budget" → "$10,000") or a list ("offsite vendors" → [...]). */
export interface LedgerEntry {
  type: "scalar" | "list";
  value: string | string[];
}
export type Ledger = Record<string, LedgerEntry>;

export interface LedgerOp {
  op: "set" | "add" | "remove" | "clear";
  key: string;
  value?: string; // for set
  item?: string; // for add/remove
}

const norm = (s: string) => s.trim().toLowerCase();

/** Apply a batch of ops to a ledger, returning a NEW ledger (pure). Unknown/blank ops are ignored. */
export function applyLedgerOps(ledger: Ledger, ops: LedgerOp[]): Ledger {
  const next: Ledger = { ...ledger };
  for (const o of ops) {
    if (!o || !o.key) continue;
    const key = norm(o.key);
    if (!key) continue;
    if (o.op === "set" && typeof o.value === "string" && o.value.trim()) {
      next[key] = { type: "scalar", value: o.value.trim() };
    } else if (o.op === "add" && typeof o.item === "string" && o.item.trim()) {
      const item = o.item.trim();
      const cur = next[key];
      const list = cur && cur.type === "list" ? [...(cur.value as string[])] : [];
      if (!list.some((x) => norm(x) === norm(item))) list.push(item);
      next[key] = { type: "list", value: list };
    } else if (o.op === "remove" && typeof o.item === "string" && o.item.trim()) {
      const cur = next[key];
      if (cur && cur.type === "list") {
        const list = (cur.value as string[]).filter((x) => norm(x) !== norm(o.item!.trim()));
        next[key] = { type: "list", value: list };
      }
    } else if (o.op === "clear") {
      delete next[key];
    }
  }
  return next;
}

export async function getLedger(userEmail: string | null): Promise<Ledger> {
  const email = userEmail?.trim();
  if (!email) return {};
  try {
    await ensureBootstrapped();
    const { rows } = await getPool().query<{ ledger: Ledger }>(
      `SELECT ledger FROM chat.user_ledger WHERE user_email = $1`,
      [email],
    );
    return rows[0]?.ledger ?? {};
  } catch {
    return {};
  }
}

/** Render the ledger as a compact, injectable block (empty string when nothing is tracked). */
export function renderLedger(ledger: Ledger): string {
  const keys = Object.keys(ledger || {});
  if (!keys.length) return "";
  const lines: string[] = [];
  for (const k of keys) {
    const e = ledger[k];
    if (!e) continue;
    if (e.type === "list") {
      const items = (e.value as string[]).filter(Boolean);
      lines.push(`- ${k}: ${items.length ? items.join(", ") : "(none)"}`);
    } else if (typeof e.value === "string" && e.value.trim()) {
      lines.push(`- ${k}: ${e.value}`);
    }
  }
  if (!lines.length) return "";
  return (
    "\n\nCurrently tracked for the user (authoritative, latest — trust this over any older text; " +
    "lists here are the complete current set):\n" +
    lines.join("\n")
  );
}

const OP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ops: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["set", "add", "remove", "clear"] },
          key: { type: "string" },
          value: { type: "string" },
          item: { type: "string" },
        },
        required: ["op", "key"],
      },
    },
  },
  required: ["ops"],
} as const;

const SYSTEM =
  "You maintain a compact ledger of the USER's durable, in-play facts and lists — things they are " +
  "actively tracking: budgets, dates, counts, vendor/attendee/guest/item lists, decisions, statuses. " +
  "You are given the CURRENT ledger (JSON) and the user's new message. Output ONLY the operations to " +
  "apply so the ledger reflects the LATEST truth. Ops: 'set' (a scalar fact; replaces the key's value), " +
  "'add' (append one item to a list), 'remove' (drop one item from a list), 'clear' (delete a key). " +
  "REUSE an existing key VERBATIM when the message refers to the same thing (do not invent a near-duplicate " +
  "key). Keys are short lowercase noun phrases like 'offsite budget', 'offsite vendors', 'recital date'. " +
  "For a change like 'drop Cobalt and add Delta' emit remove+add on the same list key. Return {\"ops\": []} " +
  "if nothing durable changed (ephemeral chit-chat, questions, acknowledgements).";

/** LLM-derive the ledger ops for this turn from the user's message. Best-effort → [] on any failure. */
async function deriveOps(currentLedger: Ledger, userText: string): Promise<LedgerOp[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  try {
    const body = {
      model: "gpt-5.5",
      input: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `CURRENT LEDGER:\n${JSON.stringify(currentLedger)}\n\nNEW USER MESSAGE:\n${userText}`,
        },
      ],
      text: { format: { type: "json_schema", name: "ledger_ops", schema: OP_SCHEMA, strict: true } },
    };
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
    };
    const raw =
      json.output_text ??
      json.output?.flatMap((o) => o.content ?? []).find((c) => c?.type === "output_text" || c?.text)
        ?.text ??
      "";
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { ops?: LedgerOp[] };
    return Array.isArray(parsed.ops) ? parsed.ops : [];
  } catch {
    return [];
  }
}

/**
 * Update the user's ledger from this turn's user message: read → derive ops (LLM) → apply → persist.
 * Fire-and-forget from the caller; returns the new ledger (or the old one unchanged on any failure).
 */
export async function updateLedgerFromTurn(args: {
  userEmail: string | null;
  userText: string;
}): Promise<Ledger> {
  const email = args.userEmail?.trim();
  if (!email || !args.userText?.trim()) return {};
  try {
    await ensureBootstrapped();
    const current = await getLedger(email);
    const ops = await deriveOps(current, args.userText);
    if (!ops.length) return current;
    const next = applyLedgerOps(current, ops);
    await getPool().query(
      `INSERT INTO chat.user_ledger (user_email, ledger, updated_at)
         VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_email) DO UPDATE SET ledger = EXCLUDED.ledger, updated_at = now()`,
      [email, JSON.stringify(next)],
    );
    return next;
  } catch {
    return {};
  }
}
