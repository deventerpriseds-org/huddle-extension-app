// WHAT:       Server entry for the correspondence ingest: binds the pure pass (ingest-pass.ts) to the real
//             config, the existing OneDrive feed readers and the Azure PG ledger. Called once per heartbeat
//             from lib/tasks/scheduler.server.ts runDueScheduledJobs, started alongside the other jobs.
// WHY:        AC docs/ac/AC-correspondence-checklist.md AC-3.10 / AC-6.7: no new cron, workflow or public
//             route (G7); the existing once-a-minute heartbeat drives it, the Fireflies way.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/correspondence-ingest.test.ts; docs/qc-evidence/IMPL-correspondence-ingest.md.
//
// OFF unless HUDDLE_ONEDRIVE_FEEDS.correspondence.ingest is literally true: then this returns before any
// database or Graph call (AC-6.1). No processors exist yet (bell = AC section 4, proposals = section 5);
// until they do, ingest only records items in the ledger as `pending`.
import { getFeedsConfig, readFeed, readTeamsLogFile, recordTeamsFeedStatus } from "../external-feeds/onedrive-feed.server";
import { runIngestPass, type EmailFileRead, type PassResult } from "./ingest-pass";
import type { ItemProcessor } from "./source-item";

/** Processors plug in here when sections 4/5 are built. Empty on purpose. */
const PROCESSORS: ItemProcessor[] = [];

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
        processors: PROCESSORS,
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
