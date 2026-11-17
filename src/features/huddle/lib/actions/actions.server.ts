// WHAT:          Server side of the Actions view: binds the pure pipeline (pipeline.ts) and selection (actions.ts) to the
//                stored ledger (chat.correspondence_ledger), the proposal store (chat.task_proposals), the bell / reply
//                rows (chat.email_replies) and the per-owner settings row (chat.attention_settings.actions_settings).
//                The heartbeat classify step, the page read, Wrong? / Undo, the settings read/write and the bell settle.
// WHY:           Owner-approved Actions view (2026-11-16). NO new table: every write EXTENDS an existing store.
// SUPERSEDES:    nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/actions-view.test.ts; docs/qc-evidence/BUILD-actions-view.md.
//
// THIS REPO'S LOGS ARE PUBLIC: one line per classify pass with COUNTS only. No title, quote, subject, sender, chat
// name or id is ever logged; errors are logged by category name only.

import { getSharedPool } from "../db/shared-pool.server";
import { ACTION_SCHEMA, type ActionVerdict } from "../correspondence/action-classify";
import { assembleLedgerPlan, type MeetingItems } from "../correspondence/report-from-ledger";
import { isFeedId, type OneDriveFeedsConfig } from "../external-feeds/onedrive-feed";
import { getFeedsConfig } from "../external-feeds/onedrive-feed.server";
import type { ProposalSourceRef } from "../proposals/proposals";
import {
  bellTargetsFor,
  capNotice,
  classifyEnabled,
  resolveActionsSettings,
  withItemCorrection,
  withItemUndo,
  selectActionItems,
  sinceMondayMs,
  localMidnightMs,
  type ActionsSelection,
  type ActionsSettings,
  type OwnerCorrection,
} from "./actions";
import { buildCandidates, classifyCallsLeft, runClassify, type ClassifyResult, type MeetingProposalLite, type ProposalLite, type ThreadUnit } from "./pipeline";

/** The feed config when the correspondence ingest is on (the Actions view reads what the ingest stored). */
export function actionsConfig(): (OneDriveFeedsConfig & { owner: string }) | null {
  const cfg = getFeedsConfig();
  if (!cfg || cfg.correspondence.ingest !== true) return null;
  const owner = cfg.ownerLogins[0];
  return owner ? { ...cfg, owner: owner.toLowerCase() } : null;
}

async function settingsFor(owner: string): Promise<ActionsSettings> {
  const { getActionsSettingsRaw } = await import("../email/email-replies.server");
  return resolveActionsSettings(await getActionsSettingsRaw(owner).catch(() => null));
}

const lower = (xs: readonly string[]) => [...new Set(xs.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean))];

// ── stored verdicts ──────────────────────────────────────────────────────────────────────────────────

async function loadVerdicts(owners: readonly string[]): Promise<Map<string, ActionVerdict>> {
  const r = await getSharedPool().query<{ source: string; source_item_id: string; action: ActionVerdict }>(
    `SELECT source, source_item_id, result_ids->'action' AS action FROM chat.correspondence_ledger
      WHERE owner_email = ANY($1::text[]) AND result_ids ? 'action'`,
    [lower(owners)],
  );
  const m = new Map<string, ActionVerdict>();
  for (const x of r.rows) if (x.action && typeof x.action === "object") m.set(`${x.source}\u0000${x.source_item_id}`, x.action);
  return m;
}

async function storeVerdict(owners: readonly string[], at: ThreadUnit["storeAt"], v: ActionVerdict): Promise<void> {
  await getSharedPool().query(
    `UPDATE chat.correspondence_ledger SET result_ids = result_ids || jsonb_build_object('action', $3::jsonb)
      WHERE source = $1 AND source_item_id = $2 AND owner_email = ANY($4::text[])`,
    [at.source, at.sourceItemId, JSON.stringify(v), lower(owners)],
  );
}

/** Attempts older than this are pruned from a row's list when a new one is added (only today's count). */
const ACTION_CALLS_KEEP_MS = 48 * 3600_000;

/**
 * Loop-2 D2: record ONE model call attempt on the thread's latest ledger row (`result_ids.action_calls`, a list of
 * ISO instants), BEFORE the call. Atomic append in one UPDATE, so concurrent passes never lose a count. Throws when
 * the row is not there (then the caller makes no call). Exported for the real-PostgreSQL test.
 */
export async function recordActionCall(owners: readonly string[], at: ThreadUnit["storeAt"], nowIso: string): Promise<void> {
  const keepFrom = new Date(Date.parse(nowIso) - ACTION_CALLS_KEEP_MS).toISOString();
  const r = await getSharedPool().query(
    `UPDATE chat.correspondence_ledger
        SET result_ids = jsonb_set(result_ids, '{action_calls}',
              COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(
                          CASE WHEN jsonb_typeof(result_ids->'action_calls') = 'array' THEN result_ids->'action_calls' ELSE '[]'::jsonb END) x
                         WHERE x >= $5), '[]'::jsonb) || to_jsonb($3::text))
      WHERE source = $1 AND source_item_id = $2 AND owner_email = ANY($4::text[])`,
    [at.source, at.sourceItemId, nowIso, lower(owners), keepFrom],
  );
  if ((r.rowCount ?? 0) !== 1) throw new Error("action_call_not_recorded");
}

/**
 * Model calls spent today (AC-H-3): every recorded ATTEMPT since the owner's local midnight (D2), and never fewer
 * than the verdicts stored today (verdicts stored before attempts were recorded, i.e. the deploy day). Exported for
 * the real-PostgreSQL test.
 */
export async function actionCallsToday(owners: readonly string[], dayStartIso: string): Promise<number> {
  const r = await getSharedPool().query<{ calls: number; verdicts: number }>(
    `SELECT
       (SELECT count(*)::int FROM chat.correspondence_ledger l
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(l.result_ids->'action_calls') = 'array' THEN l.result_ids->'action_calls' ELSE '[]'::jsonb END) a(at)
         WHERE l.owner_email = ANY($1::text[]) AND l.result_ids ? 'action_calls' AND a.at >= $2) AS calls,
       (SELECT count(*)::int FROM chat.correspondence_ledger
         WHERE owner_email = ANY($1::text[]) AND result_ids ? 'action' AND (result_ids->'action'->>'at') >= $2) AS verdicts`,
    [lower(owners), dayStartIso],
  );
  return Math.max(Number(r.rows[0]?.calls ?? 0) || 0, Number(r.rows[0]?.verdicts ?? 0) || 0);
}

/** THE "used today" both the heartbeat cap and the page's cap notice read (owner 2026-11-17): the same owners and
 *  the same day boundary (the owner's local midnight), so the notice and the cap can never disagree. */
export function usedTodayFor(ownerLogins: readonly string[], nowMs: number, timeZone: string): Promise<number> {
  return actionCallsToday(lower(ownerLogins), new Date(localMidnightMs(nowMs, timeZone)).toISOString());
}

// ── the model ────────────────────────────────────────────────────────────────────────────────────────

const MODEL_TIMEOUT_MS = 15_000;
/** No model call starts after this much of the pass (worst case ~20s + one 15s call, under the ~45s ceiling). */
const CLASSIFY_BUDGET_MS = 20_000;
async function model(system: string, input: string, schemaName: string): Promise<unknown> {
  const { callOpenAIRouter } = await import("../openai-responses.server");
  const { EXTRACT_MODEL } = await import("../proposals/proposals.server");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      callOpenAIRouter<unknown>({ model: EXTRACT_MODEL, system, prompt: input, schema: ACTION_SCHEMA as unknown as Record<string, unknown>, schemaName }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("classify_timeout")), MODEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── HEARTBEAT: the classify step ─────────────────────────────────────────────────────────────────────

/** One pass per interval (the per-pass call limit, CLASSIFY_PER_PASS, lives with the pure cap rule in pipeline.ts). */
export { CLASSIFY_PER_PASS } from "./pipeline";
export const CLASSIFY_EVERY_MS = 10 * 60_000;
let lastClassifyMs = 0;
let classifying: Promise<ClassifyResult | null> | null = null;

/** Pure: is a classify pass due (AC-H-2)? */
export const classifyDue = (lastMs: number, nowMs: number) => nowMs - lastMs >= CLASSIFY_EVERY_MS;

/** One heartbeat classify pass. Never throws. Zero work unless the ingest is on, the owner's setting resolves ON and
 *  the interval has passed. */
export function runActionsClassify(): Promise<ClassifyResult | null> {
  if (classifying) return classifying;
  const now = Date.now();
  if (!classifyDue(lastClassifyMs, now) || !process.env.AZURE_PG_URL) return Promise.resolve(null);
  lastClassifyMs = now;
  classifying = (async () => {
    try {
      const cfg = actionsConfig();
      if (!cfg) return null;
      const s = await settingsFor(cfg.owner);
      if (!classifyEnabled(s, true)) return null;
      const owners = lower(cfg.ownerLogins);
      const { loadLedgerReportData } = await import("../correspondence/report-from-ledger.server");
      const data = await loadLedgerReportData(cfg.ownerLogins);
      const assembled = assembleLedgerPlan(data, cfg, sinceMondayMs(now, s.timeZone));
      const verdicts = await loadVerdicts(owners);
      const judged = new Set([...verdicts.values()].map((v) => v.key));
      const used = await usedTodayFor(cfg.ownerLogins, now, s.timeZone);
      const left = classifyCallsLeft(used, s.dailyCap);
      const { proposeFromSource } = await import("../proposals/engine");
      const { deps } = await import("../proposals/proposals.server");
      const pd = await deps(cfg.owner);
      const res = await runClassify(assembled, s, judged, left, {
        recordCall: (at) => recordActionCall(owners, at, new Date().toISOString()),
        model,
        nowMs: () => Date.now(),
        deadlineMs: now + CLASSIFY_BUDGET_MS,
        nowIso: () => new Date().toISOString(),
        storeVerdict: (at, v) => storeVerdict(owners, at, v),
        propose: async (u, v, text) => {
          const src = { source: u.source, sourceItemId: u.refItemId, at: u.at, context: (u.email?.latestOther?.subject ?? u.teams?.chatName ?? "").slice(0, 160) || null, text };
          // The admitted to-do through the EXISTING validators; when its wording is not grounded in the quote (a
          // "reply to ..." title), the quote itself is the title (always grounded). Nothing else is invented.
          const titles = [v.todo, v.quote].filter((t): t is string => !!t);
          for (const title of titles) {
            const r = await proposeFromSource(cfg.owner, src, { ...pd, extract: async () => ({ tasks: [{ task: title.slice(0, 200), evidence: v.quote, assignee: null, due_text: v.due }] }) });
            if (r.ids.length) return { id: r.ids[0], onBoard: false };
            if (r.onBoard || r.suppressed) return { id: null, onBoard: true };
          }
          return { id: null, onBoard: false };
        },
        addMeetingRows: (m, items) => addMeetingRows(cfg.owner, m, items),
      });
      if (res.calls || res.meetingRows || res.failures)
        console.log(
          `[actions] classify calls=${res.calls} open=${res.open} none=${res.none} not_checked=${res.notChecked} failures=${res.failures} over_cap=${res.overCap} already=${res.alreadyJudged} meeting_rows=${res.meetingRows} uninvolved_skipped=${res.uninvolvedSkipped} used_today=${used + res.calls}/${s.dailyCap}`,
        );
      return res;
    } catch (e) {
      console.error("[actions] classify failed", e instanceof Error ? e.name : "error");
      return null;
    } finally {
      classifying = null;
    }
  })();
  return classifying;
}

/** Meeting items -> the EXISTING untriaged triage rows (refs make a repeat a no-op). Only items not seen before. */
async function addMeetingRows(owner: string, m: MeetingItems, items: string[]): Promise<number> {
  const { triageRowsFor } = await import("../proposals/meeting-triage");
  const { pgProposalStore } = await import("../proposals/proposals-store.server");
  const rows = triageRowsFor(owner, { meetingId: m.meetingId, title: m.title, meetingAt: m.meetingAt }, items);
  let seen = new Set<string>();
  try {
    const r = await getSharedPool().query<{ norm_title: string }>(
      `SELECT norm_title FROM chat.task_proposal_refs WHERE owner_email = $1 AND source = 'transcript' AND source_item_id = $2`,
      [owner, m.meetingId],
    );
    seen = new Set(r.rows.map((x) => x.norm_title));
  } catch {
    /* table not created yet: addTriageRows bootstraps it */
  }
  const fresh = rows.filter((r) => !seen.has(r.normTitle));
  if (!fresh.length) return 0;
  return (await pgProposalStore.addTriageRows(fresh)).created.length;
}

// ── PAGE READ ────────────────────────────────────────────────────────────────────────────────────────

export type ActionsPage =
  | { status: "signed_out" | "off" | "error"; error?: string }
  | ({
      status: "ok";
      sinceIso: string;
      settings: ActionsSettings;
      classifyOn: boolean;
      neverClassified: boolean;
      meetingOthersHidden: number;
      /** AI checks used today: the SAME count the heartbeat caps on (actionCallsToday); null when it could not be read. */
      capUsedToday: number | null;
      /** The "Daily AI check limit reached ..." notice (capNotice), or null. */
      capNotice: string | null;
    } & ActionsSelection);

const proposalCols = `id, state, title, assignee, owner_correction`;

async function loadProposalsById(owners: string[], ids: string[]): Promise<Map<string, ProposalLite>> {
  const m = new Map<string, ProposalLite>();
  if (!ids.length) return m;
  try {
    const r = await getSharedPool().query<{ id: string; state: string; title: string; assignee: string | null; owner_correction: OwnerCorrection | null }>(
      `SELECT ${proposalCols} FROM chat.task_proposals WHERE owner_email = ANY($1::text[]) AND id = ANY($2::text[])`,
      [owners, ids],
    );
    for (const x of r.rows) m.set(x.id, { id: x.id, state: x.state, title: x.title, assignee: x.assignee, correction: x.owner_correction ?? null });
  } catch {
    /* chat.task_proposals not created yet: nothing is backed, so nothing is listed (counted not checked) */
  }
  return m;
}

async function loadMeetingProposals(owners: string[], meetingIds: string[]): Promise<MeetingProposalLite[]> {
  if (!meetingIds.length) return [];
  try {
    const r = await getSharedPool().query<{ id: string; state: string; title: string; assignee: string | null; owner_correction: OwnerCorrection | null; meeting_id: string; norm_title: string }>(
      `SELECT p.id, p.state, p.title, p.assignee, p.owner_correction, rf.source_item_id AS meeting_id, rf.norm_title
         FROM chat.task_proposal_refs rf JOIN chat.task_proposals p ON p.id = rf.proposal_id
        WHERE rf.owner_email = ANY($1::text[]) AND p.owner_email = ANY($1::text[]) AND rf.source = 'transcript'
          AND rf.source_item_id = ANY($2::text[]) AND p.state IN ('untriaged','proposed')
        LIMIT 2000`,
      [owners, meetingIds],
    );
    return r.rows.map((x) => ({ id: x.id, state: x.state, title: x.title, assignee: x.assignee, correction: x.owner_correction ?? null, meetingId: x.meeting_id, normTitle: x.norm_title }));
  } catch {
    return [];
  }
}

/** Is the caller the configured owner (the only owner whose correspondence is stored in this deployment)? */
async function ownedScope(caller: { entra_object_id?: string; entra_email?: string } | undefined, cfg: { ownerLogins: string[] }): Promise<string[] | null> {
  const { callerOwners } = await import("../proposals/proposals.server");
  const owners = await callerOwners(caller);
  if (!owners) return null;
  const logins = lower(cfg.ownerLogins);
  return owners.some((o) => logins.includes(o)) ? owners : [];
}

export async function getActionsPage(caller: { entra_object_id?: string; entra_email?: string } | undefined): Promise<ActionsPage> {
  if (!caller?.entra_email) return { status: "signed_out" };
  const cfg = actionsConfig();
  if (!cfg) return { status: "off" };
  const owners = await ownedScope(caller, cfg);
  if (!owners) return { status: "signed_out" };
  if (!owners.length) return { status: "off" };
  const now = Date.now();
  const s = await settingsFor(cfg.owner);
  const sinceMs = sinceMondayMs(now, s.timeZone);
  const { loadLedgerReportData } = await import("../correspondence/report-from-ledger.server");
  const data = await loadLedgerReportData(cfg.ownerLogins);
  const assembled = assembleLedgerPlan(data, cfg, sinceMs);
  const verdicts = await loadVerdicts(lower(cfg.ownerLogins));
  const proposalIds = [...new Set([...verdicts.values()].map((v) => v.proposalId).filter((x): x is string => !!x))];
  const proposals = await loadProposalsById(owners, proposalIds);
  const meetingProposals = s.sources.meeting ? await loadMeetingProposals(owners, assembled.plan.meetings.inWindow.map((m) => m.meetingId)) : [];
  const emailFacts = assembled.plan.email.scan;
  const { listEmailRepliesFor } = await import("../email/email-replies.server");
  const replies = await listEmailRepliesFor(
    owners,
    emailFacts.flatMap((f) => f.messages.map((m) => m.id)),
    emailFacts.map((f) => f.conversationId).filter((x): x is string => !!x),
  ).catch(() => []);
  const { candidates, uninvolvedHidden, meetingOthersHidden } = buildCandidates({ assembled, rows: data.rows, settings: s, verdicts, proposals, meetingProposals, replies, isDraftable: (id) => !isFeedId(id) });
  const sel = selectActionItems(candidates, s);
  sel.hidden.uninvolved += uninvolvedHidden;
  sel.hidden.total += uninvolvedHidden;
  const classifyOn = classifyEnabled(s, true);
  // The heartbeat's own count and day boundary (usedTodayFor, also used by runActionsClassify).
  const capUsedToday = await usedTodayFor(cfg.ownerLogins, now, s.timeZone).catch(() => null);
  return {
    status: "ok",
    sinceIso: new Date(sinceMs).toISOString(),
    settings: s,
    classifyOn,
    neverClassified: verdicts.size === 0,
    meetingOthersHidden,
    capUsedToday,
    capNotice: capNotice(capUsedToday, s.dailyCap, classifyOn),
    ...sel,
  };
}

// ── WRITES ───────────────────────────────────────────────────────────────────────────────────────────

export async function saveActionsSettings(caller: { entra_object_id?: string; entra_email?: string } | undefined, raw: unknown): Promise<{ ok: boolean; error?: string; settings?: ActionsSettings }> {
  const cfg = actionsConfig();
  if (!cfg) return { ok: false, error: "Actions is not switched on." };
  const owners = await ownedScope(caller, cfg);
  if (!owners?.length) return { ok: false, error: "Sign-in required." };
  const s = resolveActionsSettings(raw);
  const { setActionsSettingsRaw } = await import("../email/email-replies.server");
  await setActionsSettingsRaw(cfg.owner, s);
  return { ok: true, settings: s };
}

/** Wrong? (AC-C-17): write the correction on the backing proposal (owner-scoped), mirror it on the thread's latest
 *  ledger row, never delete or alter the stored content. "Stop flagging this list" also adds the sender to
 *  What shows' hidden senders. Undo (`undo: true`) marks it withdrawn and keeps the record. */
export async function correctActionItem(
  caller: { entra_object_id?: string; entra_email?: string } | undefined,
  input: { proposalId: string; reason?: unknown; text?: unknown; itemKey?: unknown; undo?: boolean; listSender?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const cfg = actionsConfig();
  if (!cfg) return { ok: false, error: "Actions is not switched on." };
  const owners = await ownedScope(caller, cfg);
  if (!owners?.length) return { ok: false, error: "Sign-in required." };
  const r = await correctItemFor(owners, lower(cfg.ownerLogins), input, new Date().toISOString());
  if (!r.ok) return r;
  const next = r.correction;
  if (next && next.reason === "stop_list" && input.listSender) {
    const s = await settingsFor(cfg.owner);
    const sender = input.listSender.trim().toLowerCase();
    const hiddenSenders = input.undo ? s.hiddenSenders.filter((x) => x !== sender) : [...new Set([...s.hiddenSenders, sender])];
    const { setActionsSettingsRaw } = await import("../email/email-replies.server");
    await setActionsSettingsRaw(cfg.owner, { ...s, hiddenSenders });
  }
  return { ok: true };
}

/**
 * The owner-scoped core of Wrong? / Undo (exported for the real-PostgreSQL test, scripts/actions-view-server.test.ts).
 * Loop-2 D4 (2026-11-17): the correction is written for ONE item version (`itemKey`) inside the proposal's per-item
 * map, under a row lock, so Wrong? / Undo on one thread never changes another thread that shares the proposal, and
 * two concurrent corrections on two threads both survive.
 */
export async function correctItemFor(
  owners: string[],
  ledgerOwners: string[],
  input: { proposalId: string; reason?: unknown; text?: unknown; itemKey?: unknown; undo?: boolean },
  nowIso: string,
): Promise<{ ok: true; correction: OwnerCorrection | null } | { ok: false; error: string }> {
  const notListed = { ok: false as const, error: "That item isn't in your list." };
  if (typeof input.itemKey !== "string" || !input.itemKey || input.itemKey.length > 600) return notListed;
  const itemKey = input.itemKey;
  // D6: the item must back THIS proposal on the server's own records, and the ledger row comes from that record,
  // never from the client's string.
  const backing = await itemBacking(owners, ledgerOwners, input.proposalId, itemKey);
  if (!backing) return notListed;
  const client = await getSharedPool().connect();
  let correction: OwnerCorrection | null = null;
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ owner_correction: unknown }>(
      `SELECT owner_correction FROM chat.task_proposals WHERE id = $2 AND owner_email = ANY($1::text[]) FOR UPDATE`,
      [owners, input.proposalId],
    );
    if (!cur.rows[0]) {
      await client.query("ROLLBACK");
      return notListed;
    }
    const prev = cur.rows[0].owner_correction ?? null;
    let stored: unknown;
    if (input.undo) {
      const u = withItemUndo(prev, itemKey, nowIso);
      if (!u.changed) {
        await client.query("ROLLBACK");
        return { ok: true, correction: null };
      }
      stored = u.stored;
      correction = u.correction;
    } else {
      const w = withItemCorrection(prev, { reason: input.reason, text: input.text, itemKey }, nowIso);
      if (!w.ok) {
        await client.query("ROLLBACK");
        return w;
      }
      stored = w.stored;
      correction = w.correction;
    }
    await client.query(`UPDATE chat.task_proposals SET owner_correction = $3::jsonb, updated_at = now() WHERE id = $2 AND owner_email = ANY($1::text[])`, [owners, input.proposalId, JSON.stringify(stored)]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
  // The classifier's record: this version's correction on the row its verdict is stored on (best-effort). The ledger
  // row is per version already, so it holds a single correction. Meeting items have no ledger verdict row.
  if (backing.ledger && correction)
    await getSharedPool()
      .query(`UPDATE chat.correspondence_ledger SET owner_correction = $4::jsonb WHERE source = $2 AND source_item_id = $3 AND owner_email = ANY($1::text[])`, [ledgerOwners, backing.ledger.source, backing.ledger.sourceItemId, JSON.stringify(correction)])
      .catch(() => null);
  return { ok: true, correction };
}

/**
 * Loop-2 D6: does `itemKey` back `proposalId`, by the server's own records? A thread item: the stored verdict
 * (result_ids.action) whose key IS `itemKey` and whose proposalId IS this proposal; its row is returned as the ledger
 * row to mirror onto. A meeting item: a transcript ref of THIS proposal whose meeting id + item make `itemKey`.
 * null = not backed (or the read failed): the caller refuses. Exported for the real-PostgreSQL test.
 */
export async function itemBacking(
  owners: string[],
  ledgerOwners: string[],
  proposalId: string,
  itemKey: string,
): Promise<{ ledger: { source: "email" | "teams"; sourceItemId: string } | null } | null> {
  try {
    const pool = getSharedPool();
    if (itemKey.startsWith("meeting:")) {
      const r = await pool.query(
        `SELECT 1 FROM chat.task_proposal_refs rf JOIN chat.task_proposals p ON p.id = rf.proposal_id
          WHERE rf.proposal_id = $1 AND p.owner_email = ANY($2::text[]) AND rf.owner_email = ANY($2::text[])
            AND rf.source = 'transcript' AND ('meeting:' || rf.source_item_id || '|' || rf.norm_title) = $3
          LIMIT 1`,
        [proposalId, owners, itemKey],
      );
      return r.rows.length ? { ledger: null } : null;
    }
    const r = await pool.query<{ source: "email" | "teams"; source_item_id: string }>(
      `SELECT source, source_item_id FROM chat.correspondence_ledger
        WHERE owner_email = ANY($1::text[]) AND source IN ('email','teams') AND result_ids ? 'action'
          AND result_ids->'action'->>'key' = $2 AND result_ids->'action'->>'proposalId' = $3
        LIMIT 1`,
      [ledgerOwners, itemKey, proposalId],
    );
    return r.rows[0] ? { ledger: { source: r.rows[0].source, sourceItemId: r.rows[0].source_item_id } } : null;
  } catch {
    return null; // fail closed: an unverifiable item is not written
  }
}

/**
 * Loop-2 D5: does this proposal back a row the Actions view lists? Yes when one of the owner's stored thread verdicts
 * is `open` and points at it, or when it is a meeting triage row (a transcript ref of its own). Only then does the
 * proposals endpoint honour the client's `from:"actions"` (flag bypass, triage without meetingTriage, bell settle).
 * Owner-scoped; a read error answers false (fail closed). Exported for the real-PostgreSQL test.
 */
export async function proposalBacksActionsRow(owners: string[], ledgerOwners: string[], proposalId: string): Promise<boolean> {
  try {
    const r = await getSharedPool().query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM chat.task_proposals WHERE id = $3 AND owner_email = ANY($1::text[]))
          AND (EXISTS (SELECT 1 FROM chat.correspondence_ledger
                        WHERE owner_email = ANY($2::text[]) AND source IN ('email','teams') AND result_ids ? 'action'
                          AND result_ids->'action'->>'proposalId' = $3 AND result_ids->'action'->>'status' = 'open')
               OR EXISTS (SELECT 1 FROM chat.task_proposal_refs
                           WHERE proposal_id = $3 AND owner_email = ANY($1::text[]) AND source = 'transcript')) AS ok`,
      [owners.map((o) => o.toLowerCase()), lower(ledgerOwners), proposalId],
    );
    return r.rows[0]?.ok === true;
  } catch {
    return false;
  }
}

/** X-6: the bell rows behind a decided proposal's refs. */
export async function settleBellForProposal(owners: string[], refs: readonly ProposalSourceRef[]): Promise<number> {
  const t = bellTargetsFor(refs);
  const { settleBellRows } = await import("../email/email-replies.server");
  return settleBellRows(owners, t.emailGraphIds, t.chatIds);
}
