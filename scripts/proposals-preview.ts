// WHAT:       A ONE-OFF PREVIEW of the task proposals Huddle would put in Iris's checklist, from the owner's REAL
//             work-email snapshot and Teams chat log. Runs the shipped extraction + validation (proposeFromSource,
//             the same model call the live feature uses) and writes the result as a Markdown file into the
//             owner's OWN OneDrive. Stores nothing in Huddle, creates no task, sends nothing.
// WHY:        Owner 2026-11-13: "give me a preview of the action items you pulled from the email/chat". The
//             feature is still switched off and unmerged; a preview on real data is the cheapest check of its
//             quality before switch-on. THIS REPO'S LOGS ARE PUBLIC: the action items, subjects, senders and
//             ids go ONLY into the owner's OneDrive file; the log prints counts and the file path.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run by .github/workflows/proposals-preview.yml; .claude/actions.md ACT:correspondence-checklist.
// Env: TOKEN (app-only Graph), HUDDLE_ONEDRIVE_FEEDS (the app's config), OPENAI_API_KEY, PREVIEW_DAYS (default 7),
//      PREVIEW_MAX_SOURCES (default 60). Run: npx -y tsx scripts/proposals-preview.ts
import {
  latestSentByConversation,
  mapFeedMessage,
  mapSentRecords,
  parseFeedsConfig,
  sentReplySettles,
  validateEmailSnapshot,
  validateSentSnapshot,
  TEAMS_LOG_PATH_DEFAULT,
} from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { INBOUND_EMAIL_MODE_DEFAULT, screenMessage } from "../src/features/huddle/lib/email/inbound-email";
import { decideChatThread } from "../src/features/huddle/lib/correspondence/bell";
import { parseTeamsLog } from "../src/features/huddle/lib/external-feeds/teams-log";
import { ledgerEmailItems } from "../src/features/huddle/lib/correspondence/ingest-pass";
import { teamsSourceItem, type SourceItem } from "../src/features/huddle/lib/correspondence/source-item";
import { proposalSourceFromItem, type NewProposal, type ProposalStore } from "../src/features/huddle/lib/proposals/proposals";
import { proposeFromSource } from "../src/features/huddle/lib/proposals/engine";
import { extract, EXTRACT_MODEL } from "../src/features/huddle/lib/proposals/proposals.server";

const cfg0 = parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS);
if (!cfg0) {
  console.log("config: OFF / invalid -- nothing to preview");
  process.exit(0);
}
const token = process.env.TOKEN ?? "";
const days = Number(process.env.PREVIEW_DAYS ?? 7) || 7;
const maxSources = Number(process.env.PREVIEW_MAX_SOURCES ?? 60) || 60;
const since = Date.now() - days * 86_400_000;
const drive = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg0.driveUser)}/drive/root:`;
const enc = (p: string) => p.split("/").map((s) => encodeURIComponent(s)).join("/");
const read = async (path: string) => {
  const r = await fetch(`${drive}${enc(path)}:/content`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, text: r.ok ? await r.text() : "" };
};

// ── Teams: owner id. The config does not carry it yet (it is added at switch-on, never in a public input), so
// for THIS PREVIEW ONLY the owner is inferred as the sender present in the most distinct chats (the owner is a
// member of every chat in their own log). Without it the owner's own messages would be read as asks.
const teamsPath = cfg0.teams.enabled ? cfg0.teams.path : TEAMS_LOG_PATH_DEFAULT;
const t = await read(teamsPath);
let ownerIds = cfg0.teams.ownerSenderIds;
if (t.status === 200 && !ownerIds.length) {
  const chatsBy = new Map<string, Set<string>>();
  for (const line of t.text.split("\n")) {
    try {
      const o = JSON.parse(line) as { chatId?: string; messages?: { from?: { user?: { id?: string } } }[] };
      for (const m of o.messages ?? []) {
        const id = m?.from?.user?.id?.toLowerCase();
        if (id && o.chatId) (chatsBy.get(id) ?? chatsBy.set(id, new Set()).get(id)!).add(o.chatId);
      }
    } catch {
      /* not a JSON line */
    }
  }
  const top = [...chatsBy.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  if (top) {
    ownerIds = [top[0]];
    console.log(`teams: owner inferred for the preview (present in ${top[1].size} of ${new Set([...chatsBy.values()].flatMap((s) => [...s])).size} chats)`);
  }
}
const cfg = { ...cfg0, teams: { ...cfg0.teams, enabled: true, path: teamsPath, ownerSenderIds: ownerIds } };

// ── Sources (the ledger's own mappers), newest first, within the window.
const items: SourceItem[] = [];
const e = await read(cfg.email.path);
const ev = e.status === 200 ? validateEmailSnapshot(JSON.parse(e.text), cfg) : null;
console.log(`email: HTTP ${e.status} | ${ev ? (ev.ok ? "valid" : `REJECTED ${ev.reason}`) : "-"}`);
if (ev?.ok) items.push(...ledgerEmailItems(ev.snapshot.records, cfg, { path: cfg.email.path, etag: null }).items);
// PREVIEW ONLY (owner wants production; the flow added synthetic:false from 2026-11-13, but every message so far
// sits in the 2026-11-12 lines that predate it). PREVIEW_ACCEPT_UNMARKED=1 treats a line with NO synthetic key as
// production for this preview. The live parser is unchanged: it still skips unmarked lines.
const teamsText =
  process.env.PREVIEW_ACCEPT_UNMARKED === "1"
    ? t.text
        .split("\n")
        .map((l) => {
          try {
            const o = JSON.parse(l);
            return o && typeof o === "object" && !Array.isArray(o) && !("synthetic" in o) ? JSON.stringify({ ...o, synthetic: false }) : l;
          } catch {
            return l;
          }
        })
        .join("\n")
    : t.text;
const tp = t.status === 200 ? parseTeamsLog(teamsText, cfg) : null;
console.log(`teams: HTTP ${t.status} | messages kept ${tp?.messages.length ?? 0} | skipped lines ${tp?.skippedLines ?? 0} (${JSON.stringify(tp?.skipped ?? {})})`);
for (const m of tp?.messages ?? []) items.push(teamsSourceItem(m, { path: teamsPath }));

const recent = items.filter((i) => Date.parse(i.at ?? "") >= since).sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
const sources = [];
const skips: Record<string, number> = {};
for (const it of recent) {
  const s = proposalSourceFromItem(it, cfg.mailbox);
  if ("skip" in s) skips[s.skip] = (skips[s.skip] ?? 0) + 1;
  else sources.push(s);
}
const chosen = sources.slice(0, maxSources);
console.log(`sources in the last ${days} day(s): ${recent.length} | readable ${sources.length} | skipped ${JSON.stringify(skips)} | extracted ${chosen.length} (cap ${maxSources}) | model ${EXTRACT_MODEL}`);

// ── In-memory store: nothing is written to Huddle.
const rows: NewProposal[] = [];
const store = {
  async upsert(p: NewProposal) {
    const hit = rows.find((r) => r.normTitle === p.normTitle);
    if (hit) return { kind: "attached" as const, id: hit.id };
    rows.push(p);
    return { kind: "created" as const, id: p.id };
  },
  async priorRelated() {
    return [];
  },
} as unknown as ProposalStore;

const rejected: Record<string, number> = {};
let failed = 0;
const perSource = new Map<string, { kind: string; context: string | null; at: string | null; titles: string[] }>();
for (const s of chosen) {
  try {
    const before = rows.length;
    const r = await proposeFromSource(cfg.ownerLogins[0] ?? "owner", s, { store, extract, openTitles: async () => null, tz: "America/New_York" });
    for (const [k, v] of Object.entries(r.rejected)) rejected[k] = (rejected[k] ?? 0) + (v ?? 0);
    if (rows.length > before) perSource.set(s.sourceItemId, { kind: s.source, context: s.context ?? null, at: s.at, titles: rows.slice(before).map((x) => x.id) });
  } catch {
    failed++;
  }
}
console.log(`proposals: ${rows.length} | rejected by validation ${JSON.stringify(rejected)} | extraction failures ${failed}`);

// ── The Markdown file, written to the owner's own OneDrive only.
const fmtAt = (s: string | null) => (s ? new Date(s).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "?");
const md: string[] = [
  `# Huddle task proposals: PREVIEW`,
  ``,
  `Generated ${fmtAt(new Date().toISOString())} ET from your work email and Teams chats (last ${days} days).`,
  `Nothing was added to your board or to Huddle. This is what Iris's checklist would show.`,
  ``,
  `- Sources read: ${chosen.length} of ${sources.length} readable (${recent.length} in the window)`,
  `- Proposed to-dos: **${rows.length}**`,
  `- Dropped by the grounding checks: ${Object.values(rejected).reduce((a, b) => a + b, 0)} (${Object.entries(rejected).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`,
  `- Not read: ${Object.entries(skips).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  ``,
];
for (const [, ps] of perSource) {
  md.push(`## ${ps.kind === "email" ? "Email" : "Teams"}: ${ps.context ?? "(no subject / chat name)"} (${fmtAt(ps.at)})`, ``);
  for (const id of ps.titles) {
    const p = rows.find((r) => r.id === id)!;
    const due = p.dueDate ? ` | due ${p.dueDate}` : p.dueText ? ` | due "${p.dueText}"` : "";
    md.push(`- [ ] **${p.title}**${p.assignee ? ` | for ${p.assignee}` : ""}${due}`, `  > ${p.evidence.replace(/\s+/g, " ")}`);
  }
  md.push(``);
}
// ── OPEN vs REPLIED since PREVIEW_SINCE (owner 2026-11-13: "I need all emails and chats open vs replies from
// Monday forward analyzed"). The SAME decisions the bell will make: an email is open when it is from a person,
// asks something, and no LATER sent message exists in its conversation (sentReplySettles); a chat is open when
// someone asked after the owner's last message (decideChatThread).
const sinceIso = process.env.PREVIEW_SINCE || "";
const sinceMs = sinceIso ? Date.parse(sinceIso) : since;
const sentRead = await read("/automation/email/sent.json");
const sv = sentRead.status === 200 ? validateSentSnapshot(JSON.parse(sentRead.text), cfg) : null;
const sentMapped = sv?.ok ? mapSentRecords(sv.snapshot.records, cfg) : { sent: [], skipped: 0 };
const latestSent = latestSentByConversation(sentMapped.sent);
console.log(`sent: HTTP ${sentRead.status} | ${sv ? (sv.ok ? "valid" : `REJECTED ${sv.reason}`) : "-"} | usable ${sentMapped.sent.length} | no time ${sentMapped.skipped}`);
const emailRows: { status: string; m: ReturnType<typeof mapFeedMessage> }[] = [];
const emailSkip: Record<string, number> = {};
if (ev?.ok) {
  for (const r of ev.snapshot.records) {
    const m = mapFeedMessage(r, cfg.mailbox);
    if (Date.parse(m.receivedDateTime ?? "") < sinceMs) continue;
    const person = screenMessage(m, "people", cfg.mailbox);
    if (!person.keep) {
      emailSkip[person.reason] = (emailSkip[person.reason] ?? 0) + 1;
      continue;
    }
    const asks = screenMessage(m, INBOUND_EMAIL_MODE_DEFAULT, cfg.mailbox).keep;
    const replied = sentReplySettles({ conversation_id: m.conversationId ?? null, received_at: m.receivedDateTime ?? null }, latestSent);
    emailRows.push({ m, status: replied ? "replied" : asks ? (sentMapped.sent.length ? "open" : "open?") : "fyi" });
  }
}
const chatsById = new Map<string, typeof tp extends null ? never : NonNullable<typeof tp>["messages"]>();
for (const m of tp?.messages ?? []) if (Date.parse(m.at) >= sinceMs) (chatsById.get(m.chatId) ?? chatsById.set(m.chatId, []).get(m.chatId)!).push(m);
const chatRows = [...chatsById.entries()].map(([id, msgs]) => ({ id, msgs, d: decideChatThread(msgs, true) }));
const n = (arr: { status?: string }[], st: string) => arr.filter((x) => x.status === st).length;
console.log(
  `open-vs-replied since ${new Date(sinceMs).toISOString().slice(0, 10)}: email open ${n(emailRows, "open") + n(emailRows, "open?")} replied ${n(emailRows, "replied")} fyi ${n(emailRows, "fyi")} | chats open ${chatRows.filter((c) => c.d.state === "open").length} answered ${chatRows.filter((c) => c.d.state === "answered").length} nothing ${chatRows.filter((c) => c.d.state === "nothing").length}`,
);
const clipLine = (s: string | null | undefined, k = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, k);
md.push(`---`, ``, `# Needs you: open vs replied since ${fmtAt(new Date(sinceMs).toISOString())} ET`, ``);
md.push(
  `**Coverage of the files this used:** work email received up to ${fmtAt(ev?.ok ? ev.snapshot.records.map((r) => String(r.receivedDateTime ?? "")).sort().pop() ?? null : null)}; ` +
    `Teams messages up to ${fmtAt((tp?.messages ?? []).map((m) => m.at).sort().pop() ?? null)}; ` +
    `Sent Items: ${sentMapped.sent.length} message(s) with a sent time, ${sentMapped.skipped} without. Anything after those times is not in the files yet.`,
  ``,
);
if (!sentMapped.sent.length) md.push(`> Sent Items has no usable sent times, so NO email can show as replied yet. Emails marked **open?** may already be answered.`, ``);
md.push(`## Emails (${emailRows.length} from people; skipped: ${Object.entries(emailSkip).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`, ``);
for (const st of ["open", "open?", "fyi", "replied"]) {
  const rowsSt = emailRows.filter((r) => r.status === st).sort((a, b) => String(b.m.receivedDateTime).localeCompare(String(a.m.receivedDateTime)));
  if (!rowsSt.length) continue;
  md.push(`### ${st === "open" ? "Open: asks you something, no reply found" : st === "open?" ? "Open? (asks you something; reply status unknown)" : st === "fyi" ? "From a person, no question detected" : "Replied"} (${rowsSt.length})`, ``);
  for (const r of rowsSt) md.push(`- ${fmtAt(r.m.receivedDateTime ?? null)} | **${clipLine(r.m.fromName || r.m.fromAddress, 60)}** | ${clipLine(r.m.subject, 120)}`);
  md.push(``);
}
md.push(`## Teams chats (${chatRows.length} with messages since then)`, ``);
for (const [label, state] of [["Open: someone asked after your last message", "open"], ["Answered: you posted after the last ask", "answered"], ["No ask detected", "nothing"]] as const) {
  const rowsSt = chatRows.filter((c) => c.d.state === state);
  if (!rowsSt.length) continue;
  md.push(`### ${label} (${rowsSt.length})`, ``);
  for (const c of rowsSt) {
    const last = [...c.msgs].sort((a, b) => a.at.localeCompare(b.at)).pop()!;
    const name = c.msgs.find((m) => m.chatName)?.chatName ?? "(chat)";
    const ask = c.d.state === "open" ? c.d.ask : null;
    md.push(`- **${clipLine(name, 80)}** | last message ${fmtAt(last.at)}${ask ? ` | ask from ${clipLine(ask.senderName, 40)} ${fmtAt(ask.at)}: "${clipLine(ask.text)}"` : ""}`);
  }
  md.push(``);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = `/automation/Huddle Preview/task-proposals-preview-${stamp}.md`;
const put = await fetch(`${drive}${enc(out)}:/content`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
  body: md.join("\n"),
});
console.log(`preview file: HTTP ${put.status} -> OneDrive ${out}`);
if (!put.ok) process.exit(1);
