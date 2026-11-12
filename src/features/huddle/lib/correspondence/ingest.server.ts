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
import { runIngestPass, type EmailFileRead, type PassResult } from "./ingest-pass";
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
