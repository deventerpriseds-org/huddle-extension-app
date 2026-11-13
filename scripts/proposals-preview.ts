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
import { parseFeedsConfig, validateEmailSnapshot, TEAMS_LOG_PATH_DEFAULT } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
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
const tp = t.status === 200 ? parseTeamsLog(t.text, cfg) : null;
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
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = `/automation/Huddle Preview/task-proposals-preview-${stamp}.md`;
const put = await fetch(`${drive}${enc(out)}:/content`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
  body: md.join("\n"),
});
console.log(`preview file: HTTP ${put.status} -> OneDrive ${out}`);
if (!put.ok) process.exit(1);
