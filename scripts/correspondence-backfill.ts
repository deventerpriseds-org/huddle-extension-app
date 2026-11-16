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

// DIAGNOSTIC (dry run only; COUNTS ONLY, public repo): could the unreadable lines of older Teams versions hold
// messages the newest version lacks? Rejoins physical lines until a JSON object parses, then compares
// chat+message ids against the newest version. Prints no ids, names or text.
const diag = !apply && process.env.BACKFILL_TEAMS_DIAG !== "0";
const teamsKeys = (text: string) => {
  const keys = new Set<string>();
  let buf = "", records = 0, synth = { t: 0, f: 0, missing: 0 };
  for (const raw of text.split(/\n/)) {
    buf = buf ? `${buf}\n${raw}` : raw;
    if (!buf.trim()) { buf = ""; continue; }
    let o: Record<string, unknown> | null = null;
    try { o = JSON.parse(buf); } catch { if (buf.length < 2_000_000) continue; }
    buf = "";
    if (!o || typeof o !== "object") continue;
    records++;
    if (o.synthetic === true) synth.t++; else if (o.synthetic === false) synth.f++; else synth.missing++;
    const chat = String((o as { chatId?: unknown }).chatId ?? "");
    const msgs = Array.isArray((o as { messages?: unknown }).messages) ? ((o as { messages: unknown[] }).messages) : [o];
    for (const m of msgs) { const id = String((m as { id?: unknown })?.id ?? ""); if (id) keys.add(`${chat}|${id}`); }
  }
  return { keys, records, synth };
};
// DIAGNOSTIC (counts only): what KIND of conversation is each Teams chat, and is the owner involved?
// Classifies by Graph id suffix (@unq.gbl.spaces = 1:1, @thread.v2 = group/meeting chat, @thread.tacv2 or
// @thread.skype = team CHANNEL), by any chatType-like field on the line, and by owner participation
// (owner sent >=1 message, or an @mention names the owner id). Prints counts and field NAMES only.
if (diag && cfg.teams.enabled) {
  const vs = await versions(cfg.teams.path);
  const text = vs[vs.length - 1].text;
  const kind = (id: string) => /@unq\.gbl\.spaces$/i.test(id) ? "one_on_one" : /@thread\.v2$/i.test(id) ? "group_or_meeting_chat" : /@thread\.(tacv2|skype)$/i.test(id) ? "CHANNEL" : "other";
  const chats = new Map<string, { kind: string; type: string; ownerSent: boolean; ownerMentioned: boolean; msgs: number }>();
  const lineKeys = new Set<string>(); const msgKeys = new Set<string>();
  for (const raw of text.split(/\n/)) {
    let o: Record<string, unknown>; try { o = JSON.parse(raw); } catch { continue; }
    if (!o || o.synthetic !== false) continue;
    Object.keys(o).forEach((k) => lineKeys.add(k));
    const id = String(o.chatId ?? o.chat_id ?? "");
    const owner = String(o.ownerUserId ?? "").toLowerCase();
    const type = String(o.chatType ?? o.chat_type ?? (o as { chat?: { chatType?: unknown } }).chat?.chatType ?? "absent");
    const c = chats.get(id) ?? { kind: kind(id), type, ownerSent: false, ownerMentioned: false, msgs: 0 };
    for (const m of (Array.isArray(o.messages) ? o.messages : []) as Record<string, unknown>[]) {
      Object.keys(m).forEach((k) => msgKeys.add(k));
      if (String(m.messageType ?? "message") !== "message") continue;
      c.msgs++;
      const from = m.from as { user?: { id?: unknown } } | undefined;
      const sid = String(from?.user?.id ?? (m.sender as { id?: unknown })?.id ?? m.sender ?? "").toLowerCase();
      if (owner && sid === owner) c.ownerSent = true;
      const ments = Array.isArray(m.mentions) ? (m.mentions as { mentioned?: { user?: { id?: unknown } } }[]) : [];
      if (owner && ments.some((x) => String(x?.mentioned?.user?.id ?? "").toLowerCase() === owner)) c.ownerMentioned = true;
    }
    chats.set(id, c);
  }
  const tally: Record<string, number> = {};
  for (const c of chats.values()) {
    const k = `${c.kind}/type=${c.type}/${c.ownerSent ? "owner_sent" : c.ownerMentioned ? "owner_mentioned_only" : "owner_not_active"}`;
    tally[k] = (tally[k] ?? 0) + 1;
  }
  console.log(`teams kinds: chats ${chats.size} | ${Object.entries(tally).sort().map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`teams kinds: messages in chats where owner not active ${[...chats.values()].filter((c) => !c.ownerSent && !c.ownerMentioned).reduce((n, c) => n + c.msgs, 0)}`);
  // Mention-match sanity (counts + id SHAPES only): does the owner id format match mention ids at all?
  {
    let mentionObjs = 0, ownerHits = 0; const shapes = new Set<string>(); let ownerShape = "";
    const shape = (v: string) => v.replace(/[0-9a-f]/gi, "x").replace(/x{4,}/g, (m) => `x${m.length}`).slice(0, 40);
    for (const raw of text.split(/\n/)) {
      let o: Record<string, unknown>; try { o = JSON.parse(raw); } catch { continue; }
      if (!o || o.synthetic !== false) continue;
      const owner = String(o.ownerUserId ?? "").toLowerCase(); if (owner) ownerShape = shape(owner);
      for (const m of (Array.isArray(o.messages) ? o.messages : []) as Record<string, unknown>[]) {
        for (const x of (Array.isArray(m.mentions) ? m.mentions : []) as { mentioned?: { user?: { id?: unknown } } }[]) {
          mentionObjs++; const id = String(x?.mentioned?.user?.id ?? "").toLowerCase(); if (id) shapes.add(shape(id));
          if (owner && id === owner) ownerHits++;
        }
      }
    }
    console.log(`teams mentions: objects ${mentionObjs} | of the owner ${ownerHits} | owner id shape ${ownerShape} | mention id shapes ${[...shapes].join(",")}`);
  }
  console.log(`teams field names: line [${[...lineKeys].sort().join(",")}] message [${[...msgKeys].sort().join(",")}]`);
}
if (diag && cfg.teams.enabled) {
  const vs = await versions(cfg.teams.path);
  const newest = teamsKeys(vs[vs.length - 1].text);
  const extra = new Set<string>();
  for (const v of vs) {
    const r = teamsKeys(v.text);
    let only = 0;
    for (const k of r.keys) if (!newest.keys.has(k)) { only++; extra.add(k); }
    console.log(`teams diag ${v.at}: rejoined records ${r.records} | synthetic t/f/missing ${r.synth.t}/${r.synth.f}/${r.synth.missing} | message ids ${r.keys.size} | not in newest ${only}`);
  }
  console.log(`teams diag total: newest ids ${newest.keys.size} | ids only in older versions ${extra.size}`);
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
    // Reason NAMES and counts only (public repo): why a version's lines produced no messages.
    console.log(`teams version ${v.at}: lines ${parsed.lines} | messages ${items.length} | skipped ${JSON.stringify(parsed.skipped)}`);
    // Coverage by ET day (counts + dates only): does this version reach back to Monday?
    const byDay: Record<string, number> = {};
    for (const m of parsed.messages) { const d = new Date(m.at).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); byDay[d] = (byDay[d] ?? 0) + 1; }
    console.log(`teams days ${v.at}: ${Object.keys(byDay).sort().map((d) => `${d}=${byDay[d]}`).join(" ")} | chats ${new Set(parsed.messages.map((m) => m.chatId)).size}`);
    await store("teams", items);
  }
}

console.log(
  `backfill ${apply ? "APPLIED" : "DRY RUN"} since ${since}: ` +
    `email versions ${totals.email.versions}, items ${totals.email.items}, unique ${totals.email.unique}, inserted ${totals.email.inserted}, changed ${totals.email.changed}, unchanged ${totals.email.unchanged} | ` +
    `teams versions ${totals.teams.versions}, items ${totals.teams.items}, unique ${totals.teams.unique}, inserted ${totals.teams.inserted}, changed ${totals.teams.changed}, unchanged ${totals.teams.unchanged}`,
);
process.exit(0);
