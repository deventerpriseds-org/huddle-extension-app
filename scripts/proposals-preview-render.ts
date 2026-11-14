// WHAT:          Pure renderer for the preview report (scripts/proposals-preview.ts): exactly THREE lists -- "Needs your
//                reply" (one row per conversation), "Action items for you" (owner as doer, grouped per conversation) and
//                "Meeting action items for you" -- plus a counts line. HTML (OneDrive file + optional email) and Markdown.
// WHY:           Owner 2026-11-14: the old report listed 41 "open" emails (minutes, mass mail, invites, earlier replies
//                in the same thread each as its own row). AC-R7.1-7.5 (AC-correspondence-redesign.md). Pure so the
//                offline test renders it directly.
// SUPERSEDES:    the per-message "Emails from people" / "Teams chats" / "Proposed to-dos" sections that were inline in
//                scripts/proposals-preview.ts.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/proposals-preview.test.ts PV-7..PV-10; docs/qc-evidence/IMPL-needs-you-redesign.md.
//
// Everything that is not one of the three lists is a NUMBER with a label (AC-R7.5): no subject, sender or name.

export interface NeedsYouReport {
  sinceLabel: string;
  generatedLabel: string;
  /** Coverage notes (file times, Sent Items state). Plain text; escaped on render. */
  coverage: string[];
  /** EMAIL only for now (owner 2026-11-14: "email report for now, no teams"). */
  replies: Array<{ key: string; kind: "Email"; who: string; at: string; title: string; ask?: string }>;
  todos: Array<{ key: string; kind: "Email"; context: string; at: string; items: Array<{ title: string; due: string | null; evidence: string }> }>;
  /** Owner-confirmed ("Mine") meeting action items from the triage store (part B). null = nothing stored yet. */
  meeting: Array<{ title: string; meeting: string | null; due: string | null }> | null;
  /** Label -> count. Labels are verdict / reason NAMES only. */
  counts: Array<[string, number]>;
}

export const LIST_TITLES = ["Needs your reply", "Action items for you", "Meeting action items for you"] as const;
export const MEETING_EMPTY = "none triaged yet";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderNeedsYouHtml(r: NeedsYouReport): string {
  const h2 = (t: string, n: number) => `<h2 style="font-size:18px;margin:28px 0 6px;color:#1f2328">${esc(t)} (${n})</h2>`;
  const td = (cells: string[]) => `<tr>${cells.map((c) => `<td valign="top" style="padding:8px 10px;border-bottom:1px solid #eaeef2;font-size:14px;color:#1f2328">${c}</td>`).join("")}</tr>`;
  const none = (t = "None.") => `<p style="color:#57606a;font-size:14px">${esc(t)}</p>`;
  const parts: string[] = [];
  parts.push(`<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:760px;margin:0 auto;color:#1f2328">`);
  parts.push(`<h1 style="font-size:22px;margin:0 0 4px">What needs you since ${esc(r.sinceLabel)} ET</h1>`);
  parts.push(`<p style="margin:0 0 16px;color:#57606a;font-size:13px">Huddle preview, generated ${esc(r.generatedLabel)} ET from your work email (email only for now). One row per conversation. Nothing was added to your board.</p>`);
  if (r.coverage.length) parts.push(`<div style="background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px"><b>What this covers.</b> ${r.coverage.map(esc).join(" &middot; ")}</div>`);
  parts.push(h2(LIST_TITLES[0], r.replies.length));
  parts.push(
    r.replies.length
      ? `<table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;margin:8px 0 20px">${r.replies
          .map((x) => td([esc(x.kind), `<b>${esc(x.who)}</b>`, esc(x.at), `${esc(x.title)}${x.ask ? `<br><i>&ldquo;${esc(x.ask)}&rdquo;</i>` : ""}`]))
          .join("")}</table>`
      : none(),
  );
  parts.push(h2(LIST_TITLES[1], r.todos.reduce((a, g) => a + g.items.length, 0)));
  if (!r.todos.length) parts.push(none());
  for (const g of r.todos) {
    parts.push(`<h3 style="font-size:15px;margin:18px 0 4px;color:#1f2328">${esc(g.kind)}: ${esc(g.context)} <span style="font-weight:400;color:#57606a;font-size:12px">${esc(g.at)}</span></h3>`);
    parts.push(`<ul style="margin:4px 0 12px;padding-left:20px">`);
    for (const it of g.items) parts.push(`<li style="margin:0 0 8px;font-size:14px"><b>${esc(it.title)}</b>${it.due ? ` &middot; due ${esc(it.due)}` : ""}<br><span style="color:#57606a;font-size:13px">&ldquo;${esc(it.evidence)}&rdquo;</span></li>`);
    parts.push(`</ul>`);
  }
  parts.push(h2(LIST_TITLES[2], r.meeting?.length ?? 0));
  if (!r.meeting || !r.meeting.length) parts.push(none(r.meeting ? "None." : MEETING_EMPTY));
  else parts.push(`<ul style="margin:4px 0 12px;padding-left:20px">${r.meeting.map((m) => `<li style="font-size:14px"><b>${esc(m.title)}</b>${m.meeting ? ` &middot; ${esc(m.meeting)}` : ""}${m.due ? ` &middot; due ${esc(m.due)}` : ""}</li>`).join("")}</ul>`);
  parts.push(`<p style="font-size:12px;color:#57606a;margin-top:24px" data-counts="1"><b>Not listed (counts only):</b> ${r.counts.map(([k, n]) => `${esc(k)} ${n}`).join(" &middot; ") || "none"}</p>`);
  parts.push(`</div>`);
  return parts.join("\n");
}

export function renderNeedsYouMarkdown(r: NeedsYouReport): string {
  const md: string[] = [`# What needs you since ${r.sinceLabel} ET`, ``, `Generated ${r.generatedLabel} ET. One row per conversation. Nothing was added to your board.`, ``];
  if (r.coverage.length) md.push(`> ${r.coverage.join(" | ")}`, ``);
  md.push(`## ${LIST_TITLES[0]} (${r.replies.length})`, ``);
  for (const x of r.replies) md.push(`- ${x.kind} | ${x.at} | **${x.who}** | ${x.title}${x.ask ? ` | "${x.ask}"` : ""}`);
  if (!r.replies.length) md.push(`None.`);
  md.push(``, `## ${LIST_TITLES[1]} (${r.todos.reduce((a, g) => a + g.items.length, 0)})`, ``);
  for (const g of r.todos) {
    md.push(`### ${g.kind}: ${g.context} (${g.at})`, ``);
    for (const it of g.items) md.push(`- [ ] **${it.title}**${it.due ? ` | due ${it.due}` : ""}`, `  > ${it.evidence.replace(/\s+/g, " ")}`);
    md.push(``);
  }
  if (!r.todos.length) md.push(`None.`, ``);
  md.push(`## ${LIST_TITLES[2]} (${r.meeting?.length ?? 0})`, ``);
  if (!r.meeting || !r.meeting.length) md.push(r.meeting ? `None.` : MEETING_EMPTY);
  else for (const m of r.meeting) md.push(`- [ ] **${m.title}**${m.meeting ? ` | ${m.meeting}` : ""}${m.due ? ` | due ${m.due}` : ""}`);
  md.push(``, `**Not listed (counts only):** ${r.counts.map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`, ``);
  return md.join("\n");
}
