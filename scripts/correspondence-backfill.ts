// WHAT:       ONE-TIME back-fill of the Azure correspondence ledger (chat.correspondence_ledger) from every SAVED VERSION
//             of the OneDrive feed files (email, Teams and, since 2026-11-16, Sent Items), oldest first, through the SAME
//             mappers and ledger the live collection pass uses (ledgerEmailItems / parseTeamsLog + teamsSourceItem /
//             sentSourceItems / pgLedger.observe), WITH CONTENT. Then a Fireflies pass: every meeting in
//             chat.fireflies_meetings is fetched (fetchTranscript) and its raw transcript + full summary stored
//             (pgLedger.storeContent, store-only). Each item is stored once (the ledger upserts on source + item id),
//             so overlapping versions are harmless; a row stored before content existed is FILLED (observe fills a
//             NULL content when the hash is unchanged), a purged row is never refilled.
// WHY:        Owner 2026-11-15: "This data should be in azure ... Push everything there and make sure it's used going
//             forward. The files should be for loads only." Owner 2026-11-16: "A (recommended): store message content
//             in Azure, including Sent Items as a fourth kind next to email, Teams and transcripts." and "Make sure both
//             the raw transcript and the summary are being loaded for fireflies". The Power Automate flows REPLACE each
//             file every run (email 127 -> 61 -> 17 records; P-7 probe), so only OneDrive's version history still holds
//             the earlier messages. THIS REPO IS PUBLIC: the log prints COUNTS and version times only -- never an id,
//             subject, address, body, chat name or transcript text.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md 2026-11-15; correspondence-probes.ts P-7; docs/qc-evidence/BUILD-correspondence-content.md.
// Env: TOKEN (app-only Graph), HUDDLE_ONEDRIVE_FEEDS, AZURE_PG_URL, BACKFILL_SINCE (ISO, default Monday 2026-11-09 00:00 ET),
//      FIREFLIES_API_KEY (optional: without it the Fireflies pass is skipped and says so),
//      BACKFILL_APPLY=1 to write (otherwise a DRY RUN that only reads and counts; nothing is written anywhere).
import { ledgerEmailItems } from "../src/features/huddle/lib/correspondence/ingest-pass";
import { firefliesTranscriptItem, sentSourceItems, teamsSourceItem, transcriptContent } from "../src/features/huddle/lib/correspondence/source-item";
import type { ObserveResult, SourceItem } from "../src/features/huddle/lib/correspondence/source-item";
import { parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { parseTeamsLog } from "../src/features/huddle/lib/external-feeds/teams-log";

const token = process.env.TOKEN ?? "";
const base = parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS);
if (!token || !base) {
  console.log("backfill: missing TOKEN or feed config");
  process.exit(1);
}
const since = process.env.BACKFILL_SINCE || "2026-11-09T05:00:00Z";
const apply = process.env.BACKFILL_APPLY === "1";
// The first-enable guard (notBeforeUtc) exists to stop a backlog flood of ALERTS; the back-fill only stores, so it
// reads from Monday regardless. Nothing here announces anything.
const cfg = { ...base, notBeforeUtc: since };
const owner = cfg.ownerLogins[0];
if (!owner) {
  console.log("backfill: no owner login in the config");
  process.exit(1);
}
const drive = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.driveUser)}/drive/root:`;
const enc = (p: string) => p.split("/").map((s) => encodeURIComponent(s)).join("/");
const h = { Authorization: `Bearer ${token}` };

type Ver = { id: string; at: string; text: string };
async function versions(path: string): Promise<Ver[]> {
  const v = await fetch(`${drive}${enc(path)}:/versions`, { headers: h });
  const list = v.ok ? (((await v.json()) as { value?: { id: string; lastModifiedDateTime: string }[] }).value ?? []) : [];
  const out: Ver[] = [];
  for (const x of list) {
    // The CURRENT version is not always served from /versions/{id}/content; read it from the file itself.
    let r = await fetch(`${drive}${enc(path)}:/versions/${encodeURIComponent(x.id)}/content`, { headers: h });
    if (!r.ok && out.length === 0) r = await fetch(`${drive}${enc(path)}:/content`, { headers: h });
    out.push({ id: x.id, at: x.lastModifiedDateTime, text: r.ok ? await r.text() : "" });
  }
  // Also the live file, in case the version list lags it.
  const cur = await fetch(`${drive}${enc(path)}:/content`, { headers: h });
  if (cur.ok) out.push({ id: "live", at: new Date().toISOString(), text: await cur.text() });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The records of one email-shaped snapshot version (inbox or Sent Items); [] when it does not parse. */
function snapshotRecords(text: string): Record<string, unknown>[] {
  try {
    const j = JSON.parse(text) as { snapshot?: { value?: unknown[] }; records?: unknown[] };
    return (Array.isArray(j.snapshot?.value) ? j.snapshot!.value! : Array.isArray(j.records) ? j.records : []) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

const { pgLedger } = await import("../src/features/huddle/lib/correspondence/ledger.server");
type Src = "email" | "teams" | "sent" | "transcript";
const zero = () => ({ versions: 0, items: 0, unique: 0, inserted: 0, contentFilled: 0, changed: 0, unchanged: 0, updated: 0, failed: 0 });
const totals: Record<Src, ReturnType<typeof zero>> = { email: zero(), teams: zero(), sent: zero(), transcript: zero() };
const seen = new Set<string>();
const store = async (source: Exclude<Src, "transcript">, items: SourceItem[]) => {
  const fresh = items.filter((it) => {
    const k = `${it.source}:${it.sourceItemId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  totals[source].items += items.length;
  totals[source].unique += fresh.length;
  if (!apply || !items.length) return;
  // Every item of the version goes through observe: an item whose content changed between versions is updated, and a
  // row stored before content existed has its content filled (same hash, NULL content).
  try {
    const r: ObserveResult = await pgLedger.observe(owner, items);
    totals[source].inserted += r.inserted;
    totals[source].changed += r.changed;
    totals[source].unchanged += r.unchanged;
    totals[source].contentFilled += r.contentFilled ?? 0;
  } catch {
    totals[source].failed += items.length;
  }
};

for (const v of await versions(cfg.email.path)) {
  totals.email.versions++;
  const records = snapshotRecords(v.text);
  const { items } = ledgerEmailItems(records, cfg, { path: cfg.email.path, etag: `version:${v.id}` });
  console.log(`email version ${v.at}: records ${records.length} | items ${items.length}`);
  await store("email", items);
}

if (cfg.teams.enabled) {
  for (const v of await versions(cfg.teams.path)) {
    totals.teams.versions++;
    const parsed = parseTeamsLog(v.text, cfg);
    if (parsed.rejected) {
      console.log(`teams version ${v.at}: rejected ${parsed.rejected}`);
      continue;
    }
    const items = parsed.messages.map((m) => teamsSourceItem(m, { path: cfg.teams.path, etag: `version:${v.id}` }));
    console.log(`teams version ${v.at}: lines ${parsed.lines} | messages ${items.length}`);
    await store("teams", items);
  }
}

// Sent Items (2026-11-16): STORE-ONLY rows (inserted `processed`, never claimed by the processing pass).
if (cfg.sent.enabled) {
  for (const v of await versions(cfg.sent.path)) {
    totals.sent.versions++;
    const records = snapshotRecords(v.text);
    const { items, skipped } = sentSourceItems(records, cfg, { path: cfg.sent.path, etag: `version:${v.id}` });
    console.log(`sent version ${v.at}: records ${records.length} | items ${items.length} | skipped ${skipped}`);
    await store("sent", items);
  }
} else console.log("sent: not configured (sent entry absent or off) -- skipped");

// Fireflies (2026-11-16): every meeting the minutes flow knows. fireflies.server has NO "list transcripts" call
// (only fetchTranscript by id), so chat.fireflies_meetings is the meeting list. One meeting at a time.
if (String(process.env.FIREFLIES_API_KEY ?? "").trim()) {
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const { fetchTranscript } = await import("../src/features/huddle/lib/fireflies/fireflies.server");
  const { meetingDateMs } = await import("../src/features/huddle/lib/fireflies/minutes");
  let ids: { meeting_id: string; owner_email: string }[] = [];
  try {
    ids = (await getSharedPool().query(`SELECT meeting_id, owner_email FROM chat.fireflies_meetings ORDER BY created_at`)).rows;
  } catch {
    console.log("transcript: could not read chat.fireflies_meetings");
  }
  totals.transcript.versions = ids.length;
  for (const m of ids) {
    try {
      const { transcript } = await fetchTranscript(m.meeting_id);
      const ms = meetingDateMs(transcript as Parameters<typeof meetingDateMs>[0]);
      const item = firefliesTranscriptItem(m.meeting_id, transcriptContent(transcript, ms != null ? new Date(ms).toISOString() : null));
      totals.transcript.items++;
      totals.transcript.unique++;
      if (!apply) continue;
      const r = await pgLedger.storeContent(m.owner_email || owner, [item]);
      totals.transcript.inserted += r.inserted;
      totals.transcript.updated += r.updated;
    } catch {
      totals.transcript.failed++;
    }
  }
} else console.log("transcript: FIREFLIES_API_KEY not set -- Fireflies pass skipped");

const line = (s: Src) => {
  const x = totals[s];
  return `${s} ${s === "transcript" ? "meetings" : "versions"} ${x.versions}, items ${x.items}, unique ${x.unique}, inserted ${x.inserted}, content filled ${x.contentFilled}${s === "transcript" ? `, content updated ${x.updated}` : `, changed ${x.changed}, unchanged ${x.unchanged}`}, failed ${x.failed}`;
};
console.log(`backfill ${apply ? "APPLIED" : "DRY RUN"} since ${since}: ${(["email", "teams", "sent", "transcript"] as const).map(line).join(" | ")}`);
process.exit(0);
