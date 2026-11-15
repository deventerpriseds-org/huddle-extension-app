// WHAT:       ONE-TIME back-fill of the Azure correspondence ledger (chat.correspondence_ledger) from every SAVED VERSION
//             of the OneDrive feed files (email + Teams), oldest first, through the SAME mappers and ledger the live
//             collection pass uses (ledgerEmailItems / parseTeamsLog + teamsSourceItem / pgLedger.observe). Each message
//             is stored once (the ledger upserts on source + item id), so overlapping versions are harmless.
// WHY:        Owner 2026-11-15: "This data should be in azure ... Push everything there and make sure it's used going
//             forward. The files should be for loads only." The Power Automate flows REPLACE each file every run (email
//             127 -> 61 -> 17 records; P-7 probe), and collection was never switched on, so only OneDrive's version
//             history still holds Monday onward. THIS REPO IS PUBLIC: the log prints counts and version times only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md 2026-11-15; correspondence-probes.ts P-7.
// Env: TOKEN (app-only Graph), HUDDLE_ONEDRIVE_FEEDS, AZURE_PG_URL, BACKFILL_SINCE (ISO, default Monday 2026-11-09 00:00 ET),
//      BACKFILL_APPLY=1 to write (otherwise a dry run that only counts).
import { ledgerEmailItems } from "../src/features/huddle/lib/correspondence/ingest-pass";
import { teamsSourceItem } from "../src/features/huddle/lib/correspondence/source-item";
import type { SourceItem } from "../src/features/huddle/lib/correspondence/source-item";
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

const { pgLedger } = await import("../src/features/huddle/lib/correspondence/ledger.server");
const seen = new Set<string>();
const totals = { email: { versions: 0, items: 0, unique: 0, inserted: 0, changed: 0, unchanged: 0 }, teams: { versions: 0, items: 0, unique: 0, inserted: 0, changed: 0, unchanged: 0 } };
const store = async (source: "email" | "teams", items: SourceItem[]) => {
  const fresh = items.filter((it) => {
    const k = `${it.source}:${it.sourceItemId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  totals[source].items += items.length;
  totals[source].unique += fresh.length;
  if (!apply || !items.length) return;
  // Every item of the version goes through observe: an item whose content changed between versions is updated.
  const r = await pgLedger.observe(owner, items);
  totals[source].inserted += r.inserted;
  totals[source].changed += r.changed;
  totals[source].unchanged += r.unchanged;
};

for (const v of await versions(cfg.email.path)) {
  totals.email.versions++;
  let records: Record<string, unknown>[] = [];
  try {
    const j = JSON.parse(v.text) as { snapshot?: { value?: unknown[] }; records?: unknown[] };
    records = (Array.isArray(j.snapshot?.value) ? j.snapshot!.value! : Array.isArray(j.records) ? j.records : []) as Record<string, unknown>[];
  } catch {
    records = [];
  }
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

console.log(
  `backfill ${apply ? "APPLIED" : "DRY RUN"} since ${since}: ` +
    `email versions ${totals.email.versions}, items ${totals.email.items}, unique ${totals.email.unique}, inserted ${totals.email.inserted}, changed ${totals.email.changed}, unchanged ${totals.email.unchanged} | ` +
    `teams versions ${totals.teams.versions}, items ${totals.teams.items}, unique ${totals.teams.unique}, inserted ${totals.teams.inserted}, changed ${totals.teams.changed}, unchanged ${totals.teams.unchanged}`,
);
process.exit(0);
