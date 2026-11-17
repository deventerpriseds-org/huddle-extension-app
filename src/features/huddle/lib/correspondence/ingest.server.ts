// WHAT:       Server entry for the correspondence ingest: binds the pure pass (ingest-pass.ts) to the real
//             config, the existing OneDrive feed readers and the Azure PG ledger. Called once per heartbeat
//             from lib/tasks/scheduler.server.ts runDueScheduledJobs, started alongside the other jobs.
// WHY:        AC docs/ac/AC-correspondence-checklist.md AC-3.10 / AC-6.7: no new cron, workflow or public
//             route (G7); the existing once-a-minute heartbeat drives it, the Fireflies way.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/correspondence-ingest.test.ts; docs/qc-evidence/IMPL-correspondence-ingest.md.
//
// OFF unless HUDDLE_ONEDRIVE_FEEDS.correspondence.ingest is literally true: then this returns before any
// database or Graph call (AC-6.1). Processors: `bell` (AC section 4, lib/correspondence/bell.ts) runs only
// when correspondence.bell is true; `proposals` (section 5) is built on branch claude_task-proposals and
// plugs into processorsForPass. With no processor switched on, ingest only records items as `pending`.
import { getFeedsConfig, readFeed, readTeamsLogFile, recordTeamsFeedStatus } from "../external-feeds/onedrive-feed.server";
import { makeBellProcessor } from "./bell";
import { runContentPurge, runIngestPass, type EmailFileRead, type PassResult } from "./ingest-pass";
import { CONTENT_RETENTION_DAYS_DEFAULT } from "../external-feeds/onedrive-feed";
import type { ItemProcessor } from "./source-item";

/** Every processor that exists, built fresh per pass (the bell decides each chat once per pass). The pass
 *  runs only those the config switches on (activeProcessors). */
async function processorsForPass(): Promise<ItemProcessor[]> {
  const replies = await import("../email/email-replies.server");
  const out: ItemProcessor[] = [makeBellProcessor({ upsert: replies.upsertChatAttention, settle: replies.settleChatAttention })];
  // Task proposals (AC section 5, lib/proposals). null unless correspondence.proposals is literally true.
  const proposals = await (await import("../proposals/proposals.server")).makeProposalsProcessor();
  if (proposals) out.push(proposals);
  return out;
}

let running: Promise<PassResult | null> | null = null;

/** One heartbeat's correspondence pass. Never throws. Overlapping ticks on one instance share a pass;
 *  across instances the ledger's claim/lease makes concurrent passes safe (AC-3.9). */
export function runCorrespondenceIngest(): Promise<PassResult | null> {
  const cfg = getFeedsConfig();
  const pass = withActionsClassify(cfg, withContentPurge(cfg, runIngestOnly(cfg)));
  // File-staleness alert (2026-11-13): rides this heartbeat hook, independent of `ingest`. Flag OFF => exactly
  // the previous behaviour (not even the import). ON => the returned promise also waits for the check (the
  // heartbeat awaits it at the end of the tick), which never throws.
  if (cfg?.correspondence.staleAlerts !== true) return pass;
  const stale = import("./feed-staleness.server").then((m) => m.runFeedStaleness(cfg)).catch(() => null);
  return Promise.all([pass, stale]).then(([r]) => r);
}

/** Actions view classify step (2026-11-16): AFTER the pass (it reads what the pass stored), throttled to once per
 *  10 minutes per process inside lib/actions, and only when the ingest is on (zero work otherwise, not even the
 *  import). Never throws; the pass result comes back unchanged. */
function withActionsClassify(cfg: ReturnType<typeof getFeedsConfig>, pass: Promise<PassResult | null>): Promise<PassResult | null> {
  if (cfg?.correspondence.ingest !== true || !process.env.AZURE_PG_URL) return pass;
  return pass.then(async (r) => {
    await import("../actions/actions.server").then((m) => m.runActionsClassify()).catch(() => null);
    return r;
  });
}

/** Stored-content purge (2026-11-16), at most once a day per process, alongside the pass. Runs only where content
 *  can have been stored: the correspondence ingest is on, or Fireflies is configured (the minutes flow stores
 *  transcripts). Otherwise zero work, exactly as before. Never throws; the pass result comes back unchanged. */
let lastPurgeMs: number | null = null;
function withContentPurge(cfg: ReturnType<typeof getFeedsConfig>, pass: Promise<PassResult | null>): Promise<PassResult | null> {
  const storing = cfg?.correspondence.ingest === true || !!String(process.env.FIREFLIES_API_KEY ?? "").trim();
  if (!storing || !process.env.AZURE_PG_URL) return pass;
  const purge = import("./ledger.server")
    .then(({ pgLedger }) =>
      runContentPurge(cfg?.correspondence.contentRetentionDays ?? CONTENT_RETENTION_DAYS_DEFAULT, {
        store: pgLedger,
        lastRunMs: lastPurgeMs,
        now: () => Date.now(),
        markRun: (ms) => (lastPurgeMs = ms),
        log: (l) => console.log(l),
      }),
    )
    .catch(() => null);
  return Promise.all([pass, purge]).then(([r]) => r);
}

function runIngestOnly(cfg: ReturnType<typeof getFeedsConfig>): Promise<PassResult | null> {
  if (!cfg || !cfg.correspondence.ingest) return Promise.resolve(null); // AC-6.1: zero work
  if (running) return running;
  running = (async () => {
    try {
      const { pgLedger, pgCursor } = await import("./ledger.server");
      return await runIngestPass(cfg, {
        ledger: pgLedger,
        cursor: pgCursor,
        readTeams: readTeamsLogFile,
        recordTeamsStatus: recordTeamsFeedStatus,
        // AC-2.1: the SAME reader, feed_key and eTag state the inbox watch uses -- no second reader.
        readEmail: async (c): Promise<EmailFileRead> => {
          const r = await readFeed(c, "email");
          return r.ok ? { ok: true, etag: r.etag ?? "", path: c.email.path, records: r.snapshot.records } : { ok: false, reason: r.reason };
        },
        // 2026-11-16: Sent Items stored in Azure (store-only) through the SAME reader reply settling uses.
        readSent: async (c): Promise<EmailFileRead> => {
          const r = await readFeed(c, "sent");
          return r.ok ? { ok: true, etag: r.etag ?? "", path: c.sent.path, records: r.snapshot.records } : { ok: false, reason: r.reason };
        },
        processors: cfg.correspondence.bell || cfg.correspondence.proposals ? await processorsForPass() : [],
        now: () => Date.now(),
        log: (line) => console.log(line),
      });
    } catch (e) {
      console.error("[correspondence] pass failed", e instanceof Error ? e.name : "error");
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}
