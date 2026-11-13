// WHAT:       Server entry for the feed file-staleness alert: for each configured feed file (work email
//             snapshot, Sent Items snapshot, Teams log) read ONLY its drive metadata (lastModifiedDateTime),
//             decide staleness (feed-staleness.ts) and keep ONE row per file in the existing bell.
// WHY:        Owner decision 2026-11-13: emails.json stopped updating 2026-11-11 14:02 UTC and nobody noticed
//             for two days. Called from the existing correspondence heartbeat hook (ingest.server.ts) -- no
//             new cron, workflow or route.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/feed-staleness.test.ts; docs/qc-evidence/IMPL-feed-staleness.md.
//
// OFF unless HUDDLE_ONEDRIVE_FEEDS.correspondence.staleAlerts is literally true: then this returns before any
// Graph or database call. Throttled per instance to one check per CHECK_INTERVAL_MS. Never throws. Logs carry
// file names, states and counts only (this repo is public).
import type { OneDriveFeedsConfig } from "../external-feeds/onedrive-feed";
import { applyFeedStaleness, stalenessLogLine, type FeedAlertStore, type FeedFile, type FeedMeta, type StalenessReport } from "./feed-staleness";

/** The files actually configured (enabled) -- a file the owner never set up is never alerted on. */
export function feedFilesToCheck(cfg: OneDriveFeedsConfig): { file: FeedFile; path: string }[] {
  const out: { file: FeedFile; path: string }[] = [];
  if (cfg.email.enabled) out.push({ file: "email", path: cfg.email.path });
  if (cfg.sent.enabled) out.push({ file: "sent", path: cfg.sent.path });
  if (cfg.teams.enabled) out.push({ file: "teams", path: cfg.teams.path });
  return out;
}

export const CHECK_INTERVAL_MS = 10 * 60_000;

export interface StalenessDeps {
  readMeta(cfg: OneDriveFeedsConfig, path: string): Promise<FeedMeta>;
  store: FeedAlertStore;
  now(): number;
  log(line: string): void;
}

/** One check, every dependency injected (the offline suite runs it with fakes). Returns null when OFF. */
export async function runFeedStalenessCheck(cfg: OneDriveFeedsConfig | null, deps: StalenessDeps): Promise<StalenessReport | null> {
  if (!cfg || cfg.correspondence.staleAlerts !== true) return null; // OFF: zero calls, zero writes
  const owner = cfg.ownerLogins[0];
  if (!owner) return null;
  const files = feedFilesToCheck(cfg);
  if (!files.length) return null;
  const checked: { file: FeedFile; meta: FeedMeta }[] = [];
  for (const f of files) checked.push({ file: f.file, meta: await deps.readMeta(cfg, f.path) });
  const rep = await applyFeedStaleness(owner, checked, deps.now(), cfg.correspondence.staleHours, deps.store);
  if (rep.raised || rep.cleared || rep.failed || Object.values(rep.states).some((s) => s !== "fresh")) deps.log(stalenessLogLine(rep));
  return rep;
}

let lastCheckMs = -Infinity;
let running: Promise<StalenessReport | null> | null = null;

/** The heartbeat's staleness check. Never throws. Zero work when the flag is off or the throttle holds. */
export function runFeedStaleness(cfg: OneDriveFeedsConfig | null): Promise<StalenessReport | null> {
  if (!cfg || cfg.correspondence.staleAlerts !== true) return Promise.resolve(null);
  if (running) return running;
  const now = Date.now();
  if (now - lastCheckMs < CHECK_INTERVAL_MS) return Promise.resolve(null);
  lastCheckMs = now;
  running = (async () => {
    try {
      const { readFeedFileMeta } = await import("../external-feeds/onedrive-feed.server");
      const ledger = await import("../email/email-replies.server");
      return await runFeedStalenessCheck(cfg, {
        readMeta: readFeedFileMeta,
        store: { raise: ledger.raiseFeedAttention, clear: ledger.clearFeedAttention },
        now: () => Date.now(),
        log: (line) => console.log(line),
      });
    } catch (e) {
      console.error("[feed-staleness] check failed", e instanceof Error ? e.name : "error");
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}
