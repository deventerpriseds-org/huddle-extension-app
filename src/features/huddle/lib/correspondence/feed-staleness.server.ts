// WHAT:       Server entry for the feed file-staleness alert: for each configured feed file (work email
//             snapshot, Sent Items snapshot, Teams log) read ONLY its drive metadata (lastModifiedDateTime),
//             decide staleness (feed-staleness.ts) and keep ONE row per file in the existing bell.
// WHY:        Owner decision 2026-11-13: emails.json stopped updating 2026-11-11 14:02 UTC and nobody noticed
//             for two days. Called from the existing correspondence heartbeat hook (ingest.server.ts) -- no
//             new cron, workflow or route.
//             Owner 2026-11-13 (later): a file the flow marked complete:false is URGENT -- besides the bell row, a NEW
//             incomplete episode is announced in Iris's chat (durable turn + push) and by email (announceUrgentFeed).
//             The file itself is still refused exactly as before; the incomplete status is read from
//             chat.external_feed_state (written by the existing reader), never by downloading the file here.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/feed-staleness.test.ts; docs/qc-evidence/IMPL-feed-staleness.md.
//
// OFF unless HUDDLE_ONEDRIVE_FEEDS.correspondence.staleAlerts is literally true: then this returns before any
// Graph or database call. Throttled per instance to one check per CHECK_INTERVAL_MS. Never throws. Logs carry
// file names, states and counts only (this repo is public).
import type { OneDriveFeedsConfig } from "../external-feeds/onedrive-feed";
import { EMAIL_ALERT_HUDDLE } from "../attention/attention";
import {
  applyFeedStaleness,
  stalenessLogLine,
  type FeedAlertStore,
  type FeedFile,
  type FeedMeta,
  type FeedReadStatus,
  type FeedUrgentNotifier,
  type StalenessReport,
} from "./feed-staleness";

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
  /** The existing reader's last status for email / sent (incomplete check). Absent = no incomplete check. */
  readStatus?(cfg: OneDriveFeedsConfig, file: "email" | "sent"): Promise<FeedReadStatus | null>;
  /** Iris chat + email for a NEW incomplete episode (owner 2026-11-13: incomplete is urgent). */
  notifyUrgent?: FeedUrgentNotifier;
}

/** One check, every dependency injected (the offline suite runs it with fakes). Returns null when OFF. */
export async function runFeedStalenessCheck(cfg: OneDriveFeedsConfig | null, deps: StalenessDeps): Promise<StalenessReport | null> {
  if (!cfg || cfg.correspondence.staleAlerts !== true) return null; // OFF: zero calls, zero writes
  const owner = cfg.ownerLogins[0];
  if (!owner) return null;
  const files = feedFilesToCheck(cfg);
  if (!files.length) return null;
  const checked: { file: FeedFile; meta: FeedMeta; read: FeedReadStatus | null }[] = [];
  for (const f of files) {
    const meta = await deps.readMeta(cfg, f.path);
    const read = f.file !== "teams" && deps.readStatus ? await deps.readStatus(cfg, f.file).catch(() => null) : null;
    checked.push({ file: f.file, meta, read });
  }
  const rep = await applyFeedStaleness(owner, checked, deps.now(), cfg.correspondence.staleHours, deps.store, deps.notifyUrgent);
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
      const { readFeedFileMeta, readFeedStatus } = await import("../external-feeds/onedrive-feed.server");
      const ledger = await import("../email/email-replies.server");
      return await runFeedStalenessCheck(cfg, {
        readMeta: readFeedFileMeta,
        store: { raise: ledger.raiseFeedAttention, clear: ledger.clearFeedAttention, notePending: ledger.notePendingFeedAttention },
        now: () => Date.now(),
        log: (line) => console.log(line),
        readStatus: readFeedStatus,
        notifyUrgent: announceUrgentFeed,
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

/** The agent who already owns the bell's email alerts (its chat is EMAIL_ALERT_HUDDLE, `dm-iris-chase`). */
const URGENT_AGENT = "iris-chase";

/** Pure: the chat directive for an urgent file problem. Names the file and the fix; never any file content. */
export function urgentFeedDirective(title: string, detail: string): string {
  return (
    `[System alert -- urgent; this is not a message from the user.] ${title}. ${detail} ` +
    `Tell the user this now in two or three short sentences: which file, that Huddle is not reading it until a complete ` +
    `file is published, and that they should check that Power Automate flow. Do not call any tools and do not create tasks.`
  );
}

/** Pure: the email body for an urgent file problem (plain text; names the file, never any content). */
export function urgentFeedEmailBody(title: string, detail: string): string {
  return `${title}.\n\n${detail}\n\nThis is also on the Huddle bell and in Iris's chat. It clears itself once a complete file is published.\n\n-- Huddle`;
}

/**
 * Iris's chat (a durable turn, with the usual phone push) AND an email to the owner, for a NEW incomplete episode.
 * The two channels are independent: one failing never stops the other. Never throws. Logs names and outcomes only.
 */
export const announceUrgentFeed: FeedUrgentNotifier = async (r) => {
  let sent = false;
  try {
    const turnId = `${r.id}-urgent-${Math.floor(r.nowMs / 60_000)}`;
    const payload = {
      text: urgentFeedDirective(r.title, r.detail),
      huddleId: EMAIL_ALERT_HUDDLE,
      scope: "one-to-one",
      members: [URGENT_AGENT],
      targetAgentId: URGENT_AGENT,
      history: [],
      router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
      agents: { [URGENT_AGENT]: { backend: "openai", journey: { enabled: false } } },
      caller: { entra_email: r.ownerEmail },
      notify: "push",
      internal: true,
    };
    const { enqueueTurn } = await import("../tasks/turns.server");
    if (await enqueueTurn(turnId, EMAIL_ALERT_HUDDLE, r.ownerEmail, payload)) {
      sent = true;
      const { runTurnById } = await import("../huddle.functions");
      await runTurnById(turnId);
    }
  } catch (e) {
    console.error(`[feed-staleness] urgent chat failed file=${r.file}`, e instanceof Error ? e.name : "error");
  }
  try {
    const { sendGraphEmail } = await import("../email/graph-email.server");
    const out = await sendGraphEmail({ to: r.ownerEmail, subject: r.title, body: urgentFeedEmailBody(r.title, r.detail), callerEmail: r.ownerEmail });
    if (out.ok) sent = true;
    else console.error(`[feed-staleness] urgent email not sent file=${r.file}${out.gateRefused ? " (send gate)" : ""}`);
  } catch (e) {
    console.error(`[feed-staleness] urgent email failed file=${r.file}`, e instanceof Error ? e.name : "error");
  }
  return sent;
};
