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
//             2026-11-16 (report from the ledger): (a) the Fireflies pass also LISTS meetings by date range from the
//             Fireflies API (fireflies.server listTranscriptsInRange) and fetches the union with chat.fireflies_meetings;
//             (b) on apply, each Teams version's items have their stored CONTENT re-written (storeContent, content only)
//             so rows stored earlier gain mention ids / owner id / mentionsOwner. Dry run writes nothing either way.
//             2026-11-16 (tuning fixes, owner: "about 3 of 5 forwarded emails lost the forwarded part when they were
//             stored"): stored email content now carries `forwarded` (the forwarded email, read from the raw body).
//             The hash is unchanged, so observe never rewrites an existing row: after the version loops the ledger's
//             FLAGS for stored forwards are read (never their content), planForwardRefill picks the rows that would
//             gain a forwarded part, the log prints the counts, and on apply those rows' CONTENT is re-written
//             (storeContent, content only). A dry run reads the flags and counts; it writes nothing.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md 2026-11-15; correspondence-probes.ts P-7; docs/qc-evidence/BUILD-correspondence-content.md;
//             docs/qc-evidence/BUILD-correspondence-tuning-fixes.md.
// Env: TOKEN (app-only Graph), HUDDLE_ONEDRIVE_FEEDS, AZURE_PG_URL, BACKFILL_SINCE (ISO, default Monday 2026-11-09 00:00 ET),
//      FIREFLIES_API_KEY (optional: without it the Fireflies pass is skipped and says so),
//      BACKFILL_APPLY=1 to write (otherwise a DRY RUN that only reads and counts; nothing is written anywhere).
import { ledgerEmailItems } from "../src/features/huddle/lib/correspondence/ingest-pass";
import { firefliesTranscriptItem, planForwardRefill, sentSourceItems, teamsSourceItem, transcriptContent } from "../src/features/huddle/lib/correspondence/source-item";
import type { ObserveResult, SourceItem, StoredForwardFlags } from "../src/features/huddle/lib/correspondence/source-item";
import { feedRecordBody, htmlToText, parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
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
const zero = () => ({ versions: 0, items: 0, unique: 0, inserted: 0, contentFilled: 0, changed: 0, unchanged: 0, updated: 0, failed: 0, refreshed: 0, labelsRefreshed: 0 });
const totals: Record<Src, ReturnType<typeof zero>> = { email: zero(), teams: zero(), sent: zero(), transcript: zero() };
const seen = new Set<string>();
// Every email / Sent Items item read, oldest version first, for the forwarded-part refill plan below.
const mailItems: SourceItem[] = [];
// The newest raw inbox record per ledger key -- only to COUNT why a forward has no readable forwarded part.
const rawById = new Map<string, Record<string, unknown>>();
const store = async (source: Exclude<Src, "transcript">, items: SourceItem[]) => {
  if (source === "email" || source === "sent") mailItems.push(...items);
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
    // 2026-11-28 (AC-actions-label-autotask AC-1.6 / AC-1.8): observe re-writes CONTENT ONLY when an unchanged email's
    // labels / status differ from the stored ones (no re-judge). Counted, never printed per row.
    totals[source].labelsRefreshed += r.labelsRefreshed ?? 0;
  } catch {
    totals[source].failed += items.length;
    return;
  }
  // 2026-11-16 (coordinator input, report from the ledger): Teams content gained mention ids / the line owner id /
  // mentionsOwner. The content hash deliberately does NOT include them (nothing re-processes), so observe leaves an
  // already-stored row's content as it was. storeContent re-writes CONTENT ONLY on the rows observe just made sure
  // exist -- never status, hash, attempts or claims -- so stored Teams rows gain the new fields. Versions run oldest
  // first, so the newest copy of each message is what stays.
  if (source === "teams") {
    try {
      const s = await pgLedger.storeContent(owner, items);
      totals.teams.refreshed += s.updated;
    } catch {
      totals.teams.failed += items.length;
    }
  }
};

for (const v of await versions(cfg.email.path)) {
  totals.email.versions++;
  const records = snapshotRecords(v.text);
  const { items } = ledgerEmailItems(records, cfg, { path: cfg.email.path, etag: `version:${v.id}` });
  for (const r of records) if (typeof r.id === "string" && r.id) rawById.set(`email\u0000${cfg.mailbox}:${r.id.trim()}`, r);
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
    for (const r of records) if (typeof r.id === "string" && r.id) rawById.set(`sent\u0000${cfg.mailbox}:${r.id.trim()}`, r);
    console.log(`sent version ${v.at}: records ${records.length} | items ${items.length} | skipped ${skipped}`);
    await store("sent", items);
  }
} else console.log("sent: not configured (sent entry absent or off) -- skipped");

// Forwarded-part refill (2026-11-16). FLAGS only are read -- no subject, body or address leaves the database.
{
  let stored: StoredForwardFlags[] = [];
  let readOk = true;
  try {
    const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
    stored = (
      await getSharedPool().query<StoredForwardFlags>(
        `SELECT source, source_item_id AS "sourceItemId", (content IS NOT NULL) AS "hasContent",
                COALESCE(content ? 'forwarded', false) AS "hasForwarded", (content_purged_at IS NOT NULL) AS "purged"
           FROM chat.correspondence_ledger
          WHERE source IN ('email', 'sent') AND lower(owner_email) = lower($1)
            AND (content IS NULL OR content->>'isForward' = 'true')`,
        [owner],
      )
    ).rows;
  } catch {
    readOk = false;
    console.log("forwards: could not read the ledger flags -- refill skipped");
  }
  if (readOk) {
    // A NULL-content row is only a forward if a version says so: keep it only when the items read mark it isForward.
    const fwdKeys = new Set(mailItems.filter((it) => (it.content as { isForward?: boolean } | undefined)?.isForward).map((it) => `${it.source}\u0000${it.sourceItemId}`));
    const flags = stored.filter((s) => s.hasContent || fwdKeys.has(`${s.source}\u0000${s.sourceItemId}`));
    const plan = planForwardRefill(mailItems, flags);
    let refilled = 0;
    let refillFailed = 0;
    if (apply && plan.refill.length) {
      try {
        refilled = (await pgLedger.storeContent(owner, plan.refill)).updated;
      } catch {
        refillFailed = plan.refill.length;
      }
    }
    console.log(
      `forwards: read ${plan.forwardsRead} (with forwarded part ${plan.forwardsWithPart}) | stored ${plan.storedForwards}, ` +
        `stored without forwarded part ${plan.storedMissing} | would gain it ${plan.wouldGain} | still missing ${plan.stillMissing} | ` +
        `purged ${plan.purged}${apply ? ` | content re-written ${refilled}, failed ${refillFailed}` : " | DRY RUN: nothing written"}`,
    );
    // Why the rest have no forwarded part -- SHAPE counts only (no text): an attachment-only forward, an empty body,
    // or a body whose header we cannot read.
    const gained = new Set(plan.refill.map((it) => `${it.source}\u0000${it.sourceItemId}`));
    const why: Record<string, number> = {};
    for (const s of flags) {
      const k = `${s.source}\u0000${s.sourceItemId}`;
      if (s.hasForwarded || s.purged || gained.has(k)) continue;
      const r = rawById.get(k);
      const { raw, isHtml } = r ? feedRecordBody(r) : { raw: "", isHtml: false };
      const reason = !r
        ? "not_in_any_version"
        : !raw.trim() ? "empty_body"
        : /id=["']?(?:divRplyFwdMsg|appendonsend)/i.test(raw) ? "outlook_marker_unread"
        : /<blockquote\b/i.test(raw) ? "blockquote_unread"
        : /^\s*(?:From|De|Von)\s*:/im.test(isHtml ? htmlToText(raw) : raw) ? "header_unread"
        : r.hasAttachments === true ? "no_header_has_attachments"
        : "no_header";
      why[`${s.source}:${reason}`] = (why[`${s.source}:${reason}`] ?? 0) + 1;
    }
    console.log(`forwards still missing by shape: ${JSON.stringify(why)}`);
  }
}

// Outlook labels (AC-actions-label-autotask AC-1.8 / AC-3.25, 2026-11-28). The live pass and the apply run above
// re-write a stored email's categories / status through observe's content-only refresh (no re-judge). This block
// prints COUNTS only: how many read emails carry labels, how many stored rows lack or differ, and -- in the DRY RUN,
// before an apply run lets the heartbeat create anything -- the most board tasks the next pass can auto-create.
{
  try {
    const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
    const { planCategoriesRefill } = await import("../src/features/huddle/lib/correspondence/email-labels");
    const { resolveActionsSettings } = await import("../src/features/huddle/lib/actions/actions");
    const { getActionsSettingsRaw } = await import("../src/features/huddle/lib/email/email-replies.server");
    const labels = resolveActionsSettings(await getActionsSettingsRaw(owner).catch(() => null)).autoTaskLabels;
    const flags = (
      await getSharedPool().query<{ sourceItemId: string; hasContent: boolean; purged: boolean; categories: unknown; autotaskSettled: boolean }>(
        `SELECT source_item_id AS "sourceItemId", (content IS NOT NULL) AS "hasContent", (content_purged_at IS NOT NULL) AS "purged",
                content->'categories' AS "categories",
                (COALESCE(result_ids->'autotask'->>'done', '') = 'true' OR COALESCE(result_ids->'autotask'->>'gaveUp', '') = 'true') AS "autotaskSettled"
           FROM chat.correspondence_ledger WHERE source = 'email' AND lower(owner_email) = lower($1)`,
        [owner],
      )
    ).rows;
    const plan = planCategoriesRefill(mailItems, flags, labels);
    console.log(
      `categories: read ${plan.read} (matching the auto-task labels ${plan.labelled}) | stored ${plan.stored}, stored-missing ${plan.storedMissing} | ` +
        `would-gain ${plan.wouldGain} | purged ${plan.purged}${apply ? ` | gained ${totals.email.labelsRefreshed}` : " | DRY RUN: nothing written"}`,
    );
    console.log(`autotask: labels configured ${labels.length} | the next pass would auto-create at most ${plan.wouldAutoTask} board task(s) (decided / already on the board create none)`);
  } catch {
    console.log("categories: could not read the ledger labels -- counts skipped");
  }
}

// Fireflies: every meeting the minutes flow knows (chat.fireflies_meetings, the webhook's record) UNION every meeting
// the Fireflies API lists in [BACKFILL_SINCE, now] (2026-11-16: the webhook record starts 2026-11-10, so a meeting it
// never saw was never stored). One meeting at a time, through the same transcript-row path. Counts and dates only.
if (String(process.env.FIREFLIES_API_KEY ?? "").trim()) {
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const { fetchTranscript, listTranscriptsInRange } = await import("../src/features/huddle/lib/fireflies/fireflies.server");
  const { meetingDateMs } = await import("../src/features/huddle/lib/fireflies/minutes");
  const { dayCounts, unionMeetings } = await import("../src/features/huddle/lib/fireflies/fireflies-list");
  let known: { meeting_id: string; owner_email: string }[] = [];
  try {
    known = (await getSharedPool().query(`SELECT meeting_id, owner_email FROM chat.fireflies_meetings ORDER BY created_at`)).rows;
  } catch {
    console.log("transcript: could not read chat.fireflies_meetings");
  }
  let listed: Awaited<ReturnType<typeof listTranscriptsInRange>>["meetings"] = [];
  try {
    const l = await listTranscriptsInRange(since, new Date().toISOString());
    listed = l.meetings;
    console.log(`transcript list: mode ${l.mode} | pages ${l.pages} | listed in window ${l.meetings.length} (no time ${l.noTime}) | by day ${JSON.stringify(dayCounts(l.meetings.map((m) => m.atMs)))}`);
  } catch (e) {
    console.log(`transcript list: FAILED (${e instanceof Error && /^[a-z0-9_:.-]{1,60}$/.test(e.message) ? e.message : "error"}) -- known meetings only`);
  }
  const ids = unionMeetings(known, listed, owner);
  const from = (k: string) => ids.filter((x) => x.from === k).length;
  console.log(`transcript union: known ${known.length} | listed ${listed.length} | to fetch ${ids.length} (known only ${from("known")}, listed only ${from("listed")}, both ${from("both")})`);
  totals.transcript.versions = ids.length;
  const fetchedMs: (number | null)[] = [];
  for (const m of ids) {
    try {
      const { transcript } = await fetchTranscript(m.id);
      const ms = meetingDateMs(transcript as Parameters<typeof meetingDateMs>[0]);
      fetchedMs.push(ms);
      const item = firefliesTranscriptItem(m.id, transcriptContent(transcript, ms != null ? new Date(ms).toISOString() : null));
      totals.transcript.items++;
      totals.transcript.unique++;
      if (!apply) continue;
      const r = await pgLedger.storeContent(m.owner || owner, [item]);
      totals.transcript.inserted += r.inserted;
      totals.transcript.updated += r.updated;
    } catch {
      totals.transcript.failed++;
    }
  }
  console.log(`transcript fetched by meeting day (ET): ${JSON.stringify(dayCounts(fetchedMs))} | fetch failed ${totals.transcript.failed}`);
} else console.log("transcript: FIREFLIES_API_KEY not set -- Fireflies pass skipped");

const line = (s: Src) => {
  const x = totals[s];
  return `${s} ${s === "transcript" ? "meetings" : "versions"} ${x.versions}, items ${x.items}, unique ${x.unique}, inserted ${x.inserted}, content filled ${x.contentFilled}${s === "transcript" ? `, content updated ${x.updated}` : `, changed ${x.changed}, unchanged ${x.unchanged}`}${s === "teams" ? `, content refreshed ${x.refreshed}` : ""}, failed ${x.failed}`;
};
console.log(`backfill ${apply ? "APPLIED" : "DRY RUN"} since ${since}: ${(["email", "teams", "sent", "transcript"] as const).map(line).join(" | ")}`);
process.exit(0);
