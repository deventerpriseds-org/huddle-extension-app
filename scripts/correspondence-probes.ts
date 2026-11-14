// WHAT:       Counts-only probes P-1..P-6 from docs/qc-evidence/AC-correspondence-redesign.md (branch
//             claude_ac-correspondence-redesign), run on the owner's REAL work-email snapshot, Teams log and the last
//             Fireflies meetings, so the redesign's matching rules are built on the data actually present.
// WHY:        Owner 2026-11-14: "The logic and tuning is horrible" (meeting minutes, invites, broadcasts, per-message
//             rows). The AC pass found several rules depend on fields whose real shape is unknown (Content-Class on
//             invites, recipient string format, Teams mentions, Fireflies action-item text).
//             THIS REPO'S LOGS ARE PUBLIC: every line printed here is a COUNT, a header NAME, a fixed-vocabulary
//             value (Content-Class), or a vendor-domain/prefix from a fixed candidate list. Never a subject, address,
//             name, id or body.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run by .github/workflows/proposals-preview.yml with probe=true.
// Env: TOKEN (app-only Graph), HUDDLE_ONEDRIVE_FEEDS, FIREFLIES_API_KEY (optional; P-4 skipped without it).
import { parseFeedsConfig, TEAMS_LOG_PATH_DEFAULT } from "../src/features/huddle/lib/external-feeds/onedrive-feed";

const token = process.env.TOKEN ?? "";
const cfg = parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS);
if (!token || !cfg) {
  console.log("probe: missing TOKEN or feed config");
  process.exit(1);
}
const drive = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.driveUser)}/drive/root:`;
const enc = (p: string) => p.split("/").map((s) => encodeURIComponent(s)).join("/");
const read = async (path: string) => {
  const r = await fetch(`${drive}${enc(path)}:/content`, { headers: { Authorization: `Bearer ${token}` } });
  return r.ok ? await r.text() : "";
};
const bump = (m: Record<string, number>, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n);
const sorted = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
const owner = new Set([...cfg.ownerLogins, cfg.mailbox, cfg.driveUser].map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean));

// ── Email snapshot: P-1, P-2, P-5
let records: Record<string, unknown>[] = [];
try {
  const j = JSON.parse(await read(cfg.email.path)) as { snapshot?: unknown; records?: unknown };
  const snap = (j.snapshot ?? j.records) as unknown;
  records = Array.isArray(snap) ? (snap as Record<string, unknown>[]) : Array.isArray((snap as { records?: unknown })?.records) ? ((snap as { records: Record<string, unknown>[] }).records) : [];
} catch {
  console.log("P-1/P-2/P-5: email file is not JSON");
}
console.log(`email records: ${records.length}`);
const headerNames: Record<string, number> = {};
const contentClass: Record<string, number> = {};
const xHeaderHits: Record<string, number> = {};
const CAL_HEADERS = ["content-class", "x-ms-exchange-calendar-series-instance-id", "x-ms-exchange-organization-calendar-booking-response", "x-ms-has-attach", "x-ms-tnef-correlator", "x-mailer", "x-ms-exchange-organization-meeting-type", "x-ms-exchange-processed-by-bccfoldering"];
for (const r of records) {
  const hs = Array.isArray(r.internetMessageHeaders) ? (r.internetMessageHeaders as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  for (const h of hs) {
    const name = String(h?.name ?? h?.Name ?? "").toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    bump(headerNames, name);
    if (name === "content-class") bump(contentClass, String(h?.value ?? h?.Value ?? "").toLowerCase().slice(0, 60) || "(empty)");
    if (CAL_HEADERS.includes(name)) bump(xHeaderHits, name);
  }
}
console.log(`P-1 header names on >=3 emails: ${JSON.stringify(sorted(Object.fromEntries(Object.entries(headerNames).filter(([, n]) => n >= 3))))}`);
console.log(`P-1 Content-Class values: ${JSON.stringify(sorted(contentClass))}`);
console.log(`P-1 calendar-ish headers: ${JSON.stringify(sorted(xHeaderHits))}`);

const PREFIXES: [string, RegExp][] = [
  ["Invitation:", /^\s*invitation:/i],
  ["Updated invitation", /^\s*updated invitation/i],
  ["Accepted:", /^\s*accepted:/i],
  ["Declined:", /^\s*declined:/i],
  ["Tentative", /^\s*tentative(ly accepted)?:/i],
  ["Canceled/Cancelled:", /^\s*cancel+ed( event)?:/i],
  ["New Time Proposed:", /^\s*new time proposed:/i],
  ["Meeting notes/minutes/recap/summary (anywhere)", /\b(meeting (notes|minutes|recap|summary)|minutes:|recap:)/i],
  ["Fireflies-ish (anywhere)", /fireflies|action items/i],
  ["Re:/RE:", /^\s*re\s*:/i],
  ["Fw:/Fwd:", /^\s*fwd?\s*:/i],
];
const prefixHits: Record<string, number> = {};
for (const r of records) {
  const s = String(r.subject ?? "");
  for (const [k, re] of PREFIXES) if (re.test(s)) bump(prefixHits, k);
}
console.log(`P-2 subject patterns: ${JSON.stringify(sorted(prefixHits))}`);
const VENDOR_DOMAINS = ["fireflies.ai", "microsoft.com", "teams.mail.microsoft", "email.teams.microsoft.com", "zoom.us", "calendar.google.com", "google.com", "otter.ai", "notion.so", "linkedin.com"];
const vendor: Record<string, number> = {};
const addrOf = (v: unknown): string => {
  if (v && typeof v === "object") {
    const ea = (v as { emailAddress?: { address?: string } }).emailAddress;
    return String(ea?.address ?? "").toLowerCase();
  }
  const s = String(v ?? "");
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
};
for (const r of records) {
  const from = addrOf(r.from);
  const dom = from.split("@")[1] ?? "";
  const hit = VENDOR_DOMAINS.find((d) => dom === d || dom.endsWith(`.${d}`));
  if (hit) bump(vendor, hit);
}
console.log(`P-2 sender vendor domains (fixed list only): ${JSON.stringify(sorted(vendor))}`);

const fmt: Record<string, number> = {};
const where: Record<string, number> = {};
const toSize: Record<string, number> = {};
const splitAddrs = (s: string) => (s.match(/[^\s<>"',;()]+@[^\s<>"',;()]+/g) ?? []).map((a) => a.toLowerCase());
for (const r of records) {
  const raw = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? JSON.stringify(v) : v ? JSON.stringify(v) : "");
  const to = raw(r.toRecipients);
  const cc = raw(r.ccRecipients);
  bump(fmt, `to type=${Array.isArray(r.toRecipients) ? "array" : typeof r.toRecipients}`);
  if (to.includes(";")) bump(fmt, "to has ;");
  if (to.includes(",")) bump(fmt, "to has ,");
  if (to.includes("<")) bump(fmt, "to has <>");
  if (to.includes('"')) bump(fmt, "to has quote");
  const toA = splitAddrs(to);
  const ccA = splitAddrs(cc);
  const n = toA.length;
  bump(toSize, n === 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : n <= 10 ? "4-10" : ">10");
  const onTo = toA.some((a) => owner.has(a));
  const onCc = ccA.some((a) => owner.has(a));
  bump(where, onTo ? (n === 1 ? "owner on To alone" : "owner on To with others") : onCc ? "owner on CC only" : "owner nowhere (list/BCC/alias)");
}
console.log(`P-5 recipient format: ${JSON.stringify(sorted(fmt))}`);
console.log(`P-5 To size: ${JSON.stringify(sorted(toSize))}`);
console.log(`P-5 owner position: ${JSON.stringify(sorted(where))}`);

// ── Teams log: P-3, P-6
const teamsText = await read(cfg.teams.enabled ? cfg.teams.path : TEAMS_LOG_PATH_DEFAULT);
const chatShape: Record<string, number> = {};
const sendersHist: Record<string, number> = {};
const mention: Record<string, number> = {};
const perChat = new Map<string, Set<string>>();
let lines = 0;
for (const line of teamsText.split("\n")) {
  let o: { chatId?: string; ownerUserId?: string; messages?: Record<string, unknown>[] };
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  lines++;
  const id = String(o.chatId ?? "");
  if (!perChat.has(id)) {
    perChat.set(id, new Set());
    bump(chatShape, /unq\.gbl\.spaces/.test(id) ? "unq.gbl.spaces (1:1)" : /meeting_/.test(id) ? "meeting_" : /thread\.tacv2/.test(id) ? "thread.tacv2 (channel)" : /thread\.v2/.test(id) ? "thread.v2 (group)" : "other");
  }
  const own = String(o.ownerUserId ?? "").toLowerCase();
  for (const m of o.messages ?? []) {
    const uid = String((m.from as { user?: { id?: string } } | undefined)?.user?.id ?? "").toLowerCase();
    if (uid && uid !== own) perChat.get(id)!.add(uid);
    const ms = Array.isArray(m.mentions) ? (m.mentions as Record<string, unknown>[]) : [];
    if (ms.length) bump(mention, "messages with mentions");
    for (const x of ms) {
      const mt = x.mentioned as Record<string, unknown> | undefined;
      const kind = mt?.user ? (String((mt.user as { id?: string }).id ?? "").toLowerCase() === own ? "user=OWNER" : "user=other") : mt?.conversation ? "conversation" : mt?.tag ? "tag" : "other";
      bump(mention, kind);
    }
  }
}
for (const s of perChat.values()) bump(sendersHist, s.size === 0 ? "0 others" : s.size === 1 ? "1 other" : s.size === 2 ? "2 others" : s.size <= 5 ? "3-5 others" : ">5 others");
console.log(`P-3 teams lines ${lines}, chats ${perChat.size}; chat id shape: ${JSON.stringify(sorted(chatShape))}`);
console.log(`P-3 distinct non-owner senders per chat: ${JSON.stringify(sorted(sendersHist))}`);
console.log(`P-6 mentions: ${JSON.stringify(sorted(mention))}`);

// ── Fireflies: P-4 (action_items text shape of the last 10 meetings)
const ffKey = process.env.FIREFLIES_API_KEY ?? "";
if (!ffKey) console.log("P-4 skipped: no FIREFLIES_API_KEY");
else {
  try {
    const r = await fetch("https://api.fireflies.ai/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${ffKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { transcripts(limit: 10) { summary { action_items } } }" }),
    });
    const j = (await r.json()) as { data?: { transcripts?: { summary?: { action_items?: unknown } }[] }; errors?: unknown[] };
    console.log(`P-4 fireflies HTTP ${r.status}${j.errors ? ` errors=${j.errors.length}` : ""}`);
    const rows: string[] = [];
    for (const t of j.data?.transcripts ?? []) {
      const a = t.summary?.action_items;
      const text = Array.isArray(a) ? a.map(String).join("\n") : String(a ?? "");
      const ls = text.split("\n").filter((l) => l.trim());
      const c = { type: Array.isArray(a) ? "array" : typeof a, lines: ls.length, bullet: 0, heading: 0, stamp: 0, nameColon: 0 };
      for (const l of ls) {
        if (/^\s*([-*•]|\d+[.)])\s/.test(l)) c.bullet++;
        if (/^\s*\*\*[^*]+\*\*\s*$/.test(l) || /:\s*$/.test(l)) c.heading++;
        if (/\(\d{1,2}:\d{2}(:\d{2})?\)\s*$/.test(l)) c.stamp++;
        if (/^\s*\*\*[^*]{1,40}\*\*\s*$/.test(l)) c.nameColon++;
      }
      rows.push(JSON.stringify(c));
    }
    console.log(`P-4 per meeting (type, lines, bullet, heading-like, (mm:ss) stamp, bold-only line): ${rows.join(" ")}`);
  } catch (e) {
    console.log(`P-4 failed: ${e instanceof Error ? e.name : "error"}`);
  }
}
