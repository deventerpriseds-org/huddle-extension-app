// WHAT:       One correspondence-ingest pass, with every I/O dependency injected: read the Teams log and the
//             email snapshot (only when they changed or work is due), record each item once in the
//             processing ledger, then -- only if a processor is switched on -- claim due items and hand
//             them to the processors (bell / proposals, built in a later pass) under bounded retries.
// WHY:        Owner handoff "Huddle Email and Teams Daily Processing" (2026-11-12) + AC
//             docs/ac/AC-correspondence-checklist.md sections 2, 3, 6: durable, idempotent, OFF unless
//             configured, never delays the other heartbeat jobs. Pure so the offline suite runs the whole
//             pass against the dummy fixtures with an in-memory ledger (AC-7.1).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/correspondence-ingest.test.ts sections F/G; docs/qc-evidence/IMPL-correspondence-ingest.md.
//
// LOGS ARE PUBLIC-SAFE: one line per pass with counts, statuses and reason names (AC-3.8). No id, body,
// subject, sender or chat name is ever logged, and no error message text -- categories only.

import { eligibleFeedMessages, mapFeedMessage, type OneDriveFeedsConfig } from "../external-feeds/onedrive-feed";
import { parseTeamsLog, teamsParseNote, type TeamsFileRead } from "../external-feeds/teams-log";
import {
  combineOutcomes,
  emailSourceItem,
  errorCategory,
  ledgerKey,
  teamsSourceItem,
  type CorrespondenceSource,
  type CursorStore,
  type ItemProcessor,
  type LedgerStore,
  type ProcessOutcome,
  type SourceItem,
} from "./source-item";

export type EmailFileRead =
  | { ok: true; etag: string; path: string; records: Record<string, unknown>[] }
  | { ok: false; reason: string };

export interface PassDeps {
  ledger: LedgerStore;
  cursor: CursorStore;
  readTeams(cfg: OneDriveFeedsConfig, knownEtag: string | null): Promise<TeamsFileRead>;
  recordTeamsStatus(cfg: OneDriveFeedsConfig, status: string, note: string | null, etag?: string): Promise<void>;
  /** MUST be the existing email feed reader (readFeed(cfg,"email")): no second reader of emails.json (AC-2.1). */
  readEmail(cfg: OneDriveFeedsConfig): Promise<EmailFileRead>;
  /** Every processor that exists; the pass runs only those the config switches on. */
  processors: ItemProcessor[];
  now(): number;
  log(line: string): void;
}

export interface SourceReport {
  status: string;
  new?: number;
  changed?: number;
  unchanged?: number;
  skipped?: number;
  reopened?: number;
}

export interface PassResult {
  ran: boolean;
  reason?: string;
  sources: Partial<Record<CorrespondenceSource, SourceReport>>;
  processed: number;
  needsContext: number;
  failed: number;
  yielded: boolean;
}

/** Wall-clock budget for one pass. The AC allows 60s; the heartbeat request runs under a ~45s hosting
 *  ceiling, so a pass yields well before it and resumes from the ledger on the next tick (AC-3.10). */
export const PASS_BUDGET_MS = 30_000;
export const CLAIM_BATCH = 10;

/** Pure (AC-2.4): the ledger, not the inbox watch's lookback window, decides what is new -- so the
 *  existing eligibility rule (notBefore, synthetic prefix, duplicate original id) is reused with NO
 *  lookback. A Monday-morning message after a Friday snapshot is never dropped by a 12h window. */
export function ledgerEmailItems(
  records: Record<string, unknown>[],
  cfg: OneDriveFeedsConfig,
  file: { path: string; etag: string | null },
): { items: SourceItem[]; skipped: number } {
  const pairs = records.map((rec) => ({ rec, mapped: mapFeedMessage(rec, cfg.mailbox) }));
  const eligible = new Set(eligibleFeedMessages(pairs.map((p) => p.mapped), cfg, new Date(0).toISOString()));
  const items: SourceItem[] = [];
  let skipped = 0;
  for (const p of pairs) {
    if (!eligible.has(p.mapped)) {
      skipped++;
      continue;
    }
    const it = emailSourceItem(p.rec, p.mapped, { path: file.path, etag: file.etag }, cfg.mailbox);
    if (it) items.push(it);
    else skipped++;
  }
  return { items, skipped };
}

/** Pure: the processors the config switches on (AC-6.3: bell and proposals independently). */
export function activeProcessors(cfg: OneDriveFeedsConfig, all: ItemProcessor[]): ItemProcessor[] {
  return all.filter((p) => (p.name === "bell" ? cfg.correspondence.bell : p.name === "proposals" ? cfg.correspondence.proposals : false));
}

export async function runIngestPass(
  cfg: OneDriveFeedsConfig | null,
  deps: PassDeps,
  opts: { budgetMs?: number; batch?: number } = {},
): Promise<PassResult> {
  const result: PassResult = { ran: false, sources: {}, processed: 0, needsContext: 0, failed: 0, yielded: false };
  // AC-6.1: absent / invalid / disabled config, or ingest off => ZERO calls of any kind.
  if (!cfg) return { ...result, reason: "not_configured" };
  const cc = cfg.correspondence;
  if (!cc.ingest) return { ...result, reason: "ingest_off" };
  const owner = cfg.ownerLogins[0];
  if (!owner) return { ...result, reason: "no_owner" };
  const enabled = cc.sources.filter((s) => (s === "teams" ? cfg.teams.enabled : cfg.email.enabled));
  if (!enabled.length) return { ...result, reason: "no_source_enabled" };
  result.ran = true;
  const start = deps.now();
  const budget = opts.budgetMs ?? PASS_BUDGET_MS;
  const processors = activeProcessors(cfg, deps.processors);
  const minIntervalMs = cc.minIntervalMinutes * 60_000;
  const payload = new Map<string, SourceItem>();
  const withPayload: CorrespondenceSource[] = [];

  const ingest = async (source: CorrespondenceSource, items: SourceItem[], etag: string, prevEtag: string | null) => {
    const rep: SourceReport = { status: "ok", new: 0, changed: 0, unchanged: 0 };
    if (etag !== prevEtag) {
      const o = await deps.ledger.observe(owner, items);
      rep.new = o.inserted;
      rep.changed = o.changed;
      rep.unchanged = o.unchanged;
      // A newly published file may carry the context a needs_context item was waiting for (AC-3.7).
      rep.reopened = await deps.ledger.reopenNeedsContext(owner, source);
      await deps.cursor.set(owner, source, etag);
    } else {
      rep.status = "unchanged";
      await deps.cursor.set(owner, source);
    }
    for (const it of items) payload.set(ledgerKey(it), it);
    withPayload.push(source);
    return rep;
  };

  for (const source of enabled) {
    try {
      const cur = await deps.cursor.get(owner, source);
      // Download the content only when the file changed OR due work needs the item text (the ledger never
      // stores text). Otherwise honour the read throttle: the flow writes once a weekday evening.
      const needPayload = processors.length > 0 && (await deps.ledger.hasDue(owner, [source], cc.maxAttempts));
      if (!needPayload && cur?.checkedAtMs != null && start - cur.checkedAtMs < minIntervalMs) {
        result.sources[source] = { status: "throttled" };
        continue;
      }
      if (source === "teams") {
        const r = await deps.readTeams(cfg, needPayload ? null : (cur?.etag ?? null));
        if (!r.ok) {
          result.sources.teams = { status: r.reason };
          await deps.cursor.set(owner, "teams");
          continue;
        }
        if (!r.changed) {
          result.sources.teams = { status: "unchanged" };
          await deps.cursor.set(owner, "teams");
          continue;
        }
        const parsed = parseTeamsLog(r.text, cfg);
        if (parsed.rejected) {
          // S-8: a whole-file JSON array is refused by name, never half-ingested; the cursor's eTag is not
          // advanced, so a corrected file is read as new.
          await deps.recordTeamsStatus(cfg, `rejected:${parsed.rejected}`, null);
          await deps.cursor.set(owner, "teams");
          result.sources.teams = { status: `rejected:${parsed.rejected}` };
          continue;
        }
        const items = parsed.messages.map((m) => teamsSourceItem(m, { path: r.path, itemId: r.itemId, etag: r.etag }));
        const rep = await ingest("teams", items, r.etag, cur?.etag ?? null);
        rep.skipped = parsed.skippedLines + parsed.skippedMessages;
        await deps.recordTeamsStatus(cfg, "ok", teamsParseNote(parsed), r.etag);
        result.sources.teams = rep;
      } else {
        const r = await deps.readEmail(cfg);
        if (!r.ok) {
          result.sources.email = { status: r.reason };
          await deps.cursor.set(owner, "email");
          continue;
        }
        const { items, skipped } = ledgerEmailItems(r.records, cfg, { path: r.path, etag: r.etag || null });
        const rep = await ingest("email", items, r.etag, cur?.etag ?? null);
        rep.skipped = skipped;
        result.sources.email = rep;
      }
    } catch (e) {
      // The ledger or cursor write failed: the cursor did not advance, so the same file is ingested again
      // next tick. Category only.
      result.sources[source] = { status: `error:${errorCategory(e)}` };
    }
  }

  // No processor switched on: items stay `pending` in the ledger, ready for when one is (AC-6.3).
  if (processors.length && withPayload.length) {
    const nowMs = () => deps.now();
    while (true) {
      if (nowMs() - start >= budget) {
        result.yielded = true; // AC-3.10: resume from the ledger next tick
        break;
      }
      const claimed = await deps.ledger.claimDue(owner, withPayload, opts.batch ?? CLAIM_BATCH, cc.maxAttempts);
      if (!claimed.length) break;
      for (const c of claimed) {
        const item = payload.get(ledgerKey(c));
        if (!item) {
          // In the ledger but not in the current file (e.g. rolled out of a bounded snapshot, AC-2.5): its
          // text is not available, which is not a failure and not a resolution.
          if (await deps.ledger.markNeedsContext(c, "source_payload")) result.needsContext++;
          continue;
        }
        try {
          const outcomes: ProcessOutcome[] = [];
          for (const p of processors) outcomes.push(await p.process(item, { owner, nowMs: nowMs() }));
          const o = combineOutcomes(outcomes);
          if (o.status === "processed") {
            if (await deps.ledger.markProcessed(c, o.resultIds ?? {})) result.processed++;
          } else if (await deps.ledger.markNeedsContext(c, o.missingField)) result.needsContext++;
        } catch (e) {
          // AC-3.3: a failed bell/proposal write is NEVER `processed`; retried with backoff, then terminal.
          await deps.ledger.markFailed(c, errorCategory(e), cc.maxAttempts);
          result.failed++;
        }
      }
    }
  }

  const parts = Object.entries(result.sources).map(([s, r]) =>
    [`${s}=${r.status}`, ...(["new", "changed", "unchanged", "skipped", "reopened"] as const).filter((k) => r[k]).map((k) => `${k}=${r[k]}`)].join(" "),
  );
  if (result.processed || result.needsContext || result.failed) parts.push(`processed=${result.processed} needs_context=${result.needsContext} failed=${result.failed}`);
  if (result.yielded) parts.push("yielded");
  if (parts.some((p) => !/=(throttled|unchanged)$/.test(p))) deps.log(`[correspondence] ${parts.join(" | ")}`);
  return result;
}
