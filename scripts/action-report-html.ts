// WHAT:          The action-scan report's ROWS and HTML (steps 2 + 3, Teams, meetings, what was set aside), pure, no I/O.
//                rowsFromStoredVerdicts turns the verdicts STORED for the Actions view (chat.correspondence_ledger
//                result_ids.action, as loadVerdicts reads them) into report rows; renderActionReportHtml draws the page
//                and the counts-only log lines. Used by scripts/action-scan-steps.ts for both the ledger (stored) path
//                and the legacy files path.
// WHY:           Owner-approved 2026-11-17: "the report must SAVE its AI verdicts into the same store the in-app Actions
//                view reads". The report now runs the app's own classify pass and renders FROM the store, so what the
//                report shows is exactly what the view will list (same key, same current-version rule, same guard).
//                The HTML is the one the owner already reviews (moved here from action-scan-steps.ts, unchanged in
//                shape; the "not checked" heading is now a parameter).
// SUPERSEDES:    the inline HTML block of scripts/action-scan-steps.ts runActionScan (moved, not copied).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/report-saves-verdicts.test.ts; docs/qc-evidence/BUILD-report-saves-verdicts.md.
//
// THIS REPO'S LOGS ARE PUBLIC: the log lines returned here carry COUNTS only. The HTML goes to the owner's OneDrive
// and (optionally) his mailbox, never to the log.

import { isDirectPosition, type ActionVerdict } from "../src/features/huddle/lib/correspondence/action-classify";
import type { ConversationFacts } from "../src/features/huddle/lib/correspondence/needs-you";
import type { AssembledLedgerPlan, LedgerReportPlan, TeamsChatFacts } from "../src/features/huddle/lib/correspondence/report-from-ledger";
import { threadUnits, verdictIsCurrent } from "../src/features/huddle/lib/actions/pipeline";
import type { ActionsSettings } from "../src/features/huddle/lib/actions/actions";

/** What the ledger source adds to the scan. */
export interface LedgerScanPart {
  plan: LedgerReportPlan;
  /** Forwarded part of stored "Fw:" emails, by feed id (only plain-text forward headers survive storage). */
  forwards: Map<string, string>;
  forwardsMissing: number;
  forwardsTotal: number;
  /** Signal stores that could not be read: nothing was excluded on their account. */
  unavailable: string[];
}

export type Row = { f: ConversationFacts; yes: boolean; kind: string; todo: string | null; due: string | null; quote: string | null; quoteFound: boolean; confidence: string; reason: string; category: string };
export type TRow = Omit<Row, "f"> & { c: TeamsChatFacts };

export interface ReportRows {
  step2: Row[];
  step3: Row[];
  teamsRows: TRow[];
  /** Threads with NO usable current stored verdict after the pass (over the cap, a failed call, or an AI answer the
   *  guard did not admit): listed, never dropped. */
  notCheckedEmail: ConversationFacts[];
  notCheckedTeams: TeamsChatFacts[];
  ownerOnly: number;
  teamsOwnerOnly: number;
  /** Of the not-checked: a current verdict exists but the guard did not admit it (quote not found / bad shape). */
  notAdmitted: number;
}

export const newestMs = (f: ConversationFacts) => Math.max(...f.messages.map((m) => Date.parse(String(m.at ?? ""))).filter(Number.isFinite), -Infinity);

/** Pure: one stored verdict -> the report row fields, or null when it is not a row. Only `open` (admitted by the guard:
 *  its quote IS a verbatim span) and `none` are rows. A `not_checked` answer (quote not found word-for-word, or a
 *  bad shape) is NOT listed as open -- the Actions view never shows it either -- it goes to the not-checked block. */
function rowFields(v: ActionVerdict): Omit<Row, "f"> | null {
  if (v.status !== "open" && v.status !== "none") return null;
  return {
    yes: v.status === "open",
    kind: v.kind ?? "?",
    todo: v.todo,
    due: v.due,
    quote: v.quote,
    quoteFound: true,
    confidence: v.confidence ?? "?",
    reason: v.reason ?? "",
    category: v.category ?? "other",
  };
}

/**
 * Pure: the report rows FROM THE STORE. Units are the Actions view's own (threadUnits), each looked up at the row its
 * verdict is stored on, and used only when verdictIsCurrent (same key AND current classifier-input version). A unit
 * with no current verdict is listed as not checked. Nothing here reads a model answer that was not stored.
 */
export function rowsFromStoredVerdicts(a: AssembledLedgerPlan, s: ActionsSettings, verdicts: ReadonlyMap<string, ActionVerdict>): ReportRows {
  const out: ReportRows = { step2: [], step3: [], teamsRows: [], notCheckedEmail: [], notCheckedTeams: [], ownerOnly: 0, teamsOwnerOnly: 0, notAdmitted: 0 };
  if (s.sources.email) out.ownerOnly = a.plan.email.scan.filter((f) => !f.latestOther).length;
  if (s.sources.teams) out.teamsOwnerOnly = a.plan.teams.scan.filter((c) => !c.latestOther).length;
  for (const u of threadUnits(a, s).units) {
    const v = verdicts.get(`${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`);
    const current = v && verdictIsCurrent(v, u.itemKey, u.source) ? v : null;
    const fields = current ? rowFields(current) : null;
    if (current && !fields) out.notAdmitted++;
    if (u.email) {
      if (!fields) out.notCheckedEmail.push(u.email);
      else (isDirectPosition(u.email.ownerPosition) ? out.step2 : out.step3).push({ f: u.email, ...fields });
    } else if (u.teams) {
      if (!fields) out.notCheckedTeams.push(u.teams);
      else out.teamsRows.push({ c: u.teams, ...fields });
    }
  }
  return out;
}

export interface RenderInput extends ReportRows {
  /** Email conversations in the scan (the log's "conversations" count). */
  conversations: number;
  calls: number;
  failures: number;
  /** Threads left unchecked because of the cap (part of notChecked*). */
  overCap: number;
  maxCalls: number;
  settledIndirect: number;
  sinceMs: number;
  forwardsRead: number;
  model: string;
  hide: ReadonlySet<string>;
  ledger?: LedgerScanPart;
  /** Heading of the not-checked block. */
  notCheckedTitle: string;
  notCheckedNote: string;
  /** One line under the summary saying where the verdicts came from / went. */
  storeNote?: string;
}

/** Pure: the report's HTML and its counts-only log lines. */
export function renderActionReportHtml(r: RenderInput): { html: string; logLines: string[] } {
  const { step2, step3, teamsRows, ledger, hide: HIDE, sinceMs } = r;
  const teamsHidden = teamsRows.filter((x) => HIDE.has(x.category));
  const teamsShown = teamsRows.filter((x) => !HIDE.has(x.category));
  const yT = teamsShown.filter((x) => x.yes);
  const meetings = ledger?.plan.meetings.inWindow ?? [];
  const meetingOpen = meetings.reduce((n, m) => n + m.open.length, 0);
  const meetingDone = meetings.reduce((n, m) => n + m.resolved.length, 0);
  const resolvedEmail = ledger?.plan.email.resolved ?? [];
  const resolvedTeams = ledger?.plan.teams.resolved ?? [];
  const uninvolved = ledger?.plan.teams.hiddenUninvolved ?? [];

  const hidden = [...step2, ...step3].filter((x) => HIDE.has(x.category));
  const shown2 = step2.filter((x) => !HIDE.has(x.category));
  const shown3 = step3.filter((x) => !HIDE.has(x.category));
  const y2 = shown2.filter((x) => x.yes);
  const y3 = shown3.filter((x) => x.yes);
  const answered2 = shown2.filter((x) => !x.yes && x.f.settled);
  const none2 = shown2.filter((x) => !x.yes && !x.f.settled);
  const catCount = (rs: Row[]) => Object.entries(rs.reduce<Record<string, number>>((m, x) => ((m[x.category] = (m[x.category] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(", ");
  const nf = (rs: { yes: boolean; quoteFound: boolean }[]) => rs.filter((x) => x.yes && !x.quoteFound).length;
  const overCapEmail = r.notCheckedEmail;
  const overCapTeams = r.notCheckedTeams;
  const logLines = [
    `action-scan since ${new Date(sinceMs).toISOString().slice(0, 10)}: conversations ${r.conversations} | model calls ${r.calls} | failures ${r.failures} | over cap ${r.overCap} | ` +
      `forwards read ${r.forwardsRead} | STEP 2 (on To) open ${y2.length} of ${step2.length} (quote not found ${nf(step2)}) | ` +
      `STEP 3 (CC/list) action ${y3.length} of ${shown3.length} (quote not found ${nf(step3)}) | step 2 answered by reply ${answered2.length} | ` +
      `step 2 reply-kind open ${y2.filter((x) => x.kind === "reply" || x.kind === "both").length} | hidden by settings ${hidden.length} | categories: ${catCount([...step2, ...step3])} | ` +
      `settled CC/list ${r.settledIndirect} | owner-only ${r.ownerOnly} | model ${r.model}`,
  ];
  if (ledger)
    logLines.push(
      `ledger sections: TEAMS open ${yT.length} of ${teamsShown.length} (quote not found ${nf(teamsShown)}; hidden by settings ${teamsHidden.length}; owner-only ${r.teamsOwnerOnly}) | ` +
        `teams not-involved hidden ${uninvolved.length} | resolved by you: email ${resolvedEmail.length}, teams ${resolvedTeams.length} | ` +
        `FROM MEETINGS ${meetings.length} meetings, open items ${meetingOpen}, already triaged ${meetingDone} | not checked: email ${overCapEmail.length}, teams ${overCapTeams.length}`,
    );

  // ── HTML (owner's OneDrive / email only; never the public log).
  const esc = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const at = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "?");
  const pos: Record<string, string> = { direct: "To: you only", group: "To: you + others", cc_only: "CC only", none: "via a list / not listed", unknown: "?" };
  const kindLabel: Record<string, string> = { reply: "Reply", action: "Do it", both: "Reply + do it", none: "-" };
  const td = (c: string) => `<td valign="top" style="padding:8px 10px;border-bottom:1px solid #eaeef2;font-size:14px">${c}</td>`;
  const th = (cols: string[]) => `<tr>${cols.map((c) => `<th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de;font-size:12px;color:#57606a;text-transform:uppercase">${c}</th>`).join("")}</tr>`;
  const table = (head: string[], body: string[]) => (body.length ? `<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;margin:8px 0 24px">${th(head)}${body.join("")}</table>` : `<p style="color:#57606a">None.</p>`);
  const who = (x: Row) => `<b>${esc(x.f.latestOther!.name)}</b><br><span style="color:#57606a;font-size:12px">${esc(at(x.f.latestOther!.at))} &middot; ${esc(pos[x.f.ownerPosition] ?? x.f.ownerPosition)}${x.f.settled ? " &middot; you replied" : ""}</span>`;
  const confOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const what = (x: Omit<Row, "f">) =>
    `<b>${esc(x.todo ?? "(no to-do given)")}</b> <span style="font-size:12px;color:#57606a">[${esc(kindLabel[x.kind] ?? x.kind)}${x.due ? ` &middot; due ${esc(x.due)}` : ""}]</span><br>` +
    `${x.quote ? `<i>&ldquo;${esc(x.quote)}&rdquo;</i>${x.quoteFound ? "" : ` <span style="color:#9a6700">(quote not found word-for-word)</span>`}<br>` : ""}<span style="color:#57606a;font-size:13px">${esc(x.reason)}</span>`;
  const yesTable = (rs: Row[]) =>
    table(
      ["From", "Subject", "What you need to do", "Sure?"],
      [...rs]
        .filter((x) => x.yes)
        .sort((x, y) => (confOrder[x.confidence] ?? 3) - (confOrder[y.confidence] ?? 3) || newestMs(y.f) - newestMs(x.f))
        .map((x) => `<tr>${td(who(x))}${td(esc(x.f.latestOther!.subject))}${td(what(x))}${td(esc(x.confidence))}</tr>`),
    );
  const noTable = (rs: Row[]) =>
    table(
      ["From", "Subject", "Why not"],
      [...rs].sort((x, y) => newestMs(y.f) - newestMs(x.f)).map((x) => `<tr>${td(who(x))}${td(esc(x.f.latestOther!.subject))}${td(`<span style="font-size:13px">${esc(x.reason)}</span> <span style="font-size:11px;color:#8c959f">[${esc(x.category.replace(/_/g, " "))}]</span>`)}</tr>`),
    );
  const kindName: Record<string, string> = { one_on_one: "1:1 chat", group: "group chat", meeting: "meeting chat", channel: "channel", unknown: "chat" };
  const viaLabel: Record<string, string> = { approved: "added as a task", completed: "task completed", dismissed: "ignored", delegated: "passed to someone" };
  const chatTitle = (c: TeamsChatFacts) => `<b>${esc(c.chatName || (c.kind === "one_on_one" ? c.latestOther?.name ?? "1:1 chat" : "(unnamed chat)"))}</b><br><span style="color:#57606a;font-size:12px">${esc(kindName[c.kind] ?? c.kind)}${c.latestOther ? ` &middot; ${esc(c.latestOther.name)} &middot; ${esc(at(c.latestOther.at))}` : ""}${c.settled ? " &middot; you replied" : ""}${c.ownerMentioned ? " &middot; you were @mentioned" : ""}${c.webUrl ? ` &middot; <a href="${esc(c.webUrl)}">open</a>` : ""}</span>`;
  const yesTableT = (rs: TRow[]) =>
    table(
      ["Chat", "What you need to do", "Sure?"],
      [...rs]
        .filter((x) => x.yes)
        .sort((x, y) => (confOrder[x.confidence] ?? 3) - (confOrder[y.confidence] ?? 3) || y.c.newestMs - x.c.newestMs)
        .map((x) => `<tr>${td(chatTitle(x.c))}${td(what(x))}${td(esc(x.confidence))}</tr>`),
    );
  const noTableT = (rs: TRow[]) =>
    table(
      ["Chat", "Why not"],
      [...rs].sort((x, y) => y.c.newestMs - x.c.newestMs).map((x) => `<tr>${td(chatTitle(x.c))}${td(`<span style="font-size:13px">${esc(x.reason)}</span> <span style="font-size:11px;color:#8c959f">[${esc(x.category.replace(/_/g, " "))}]</span>`)}</tr>`),
    );
  const meetingBlock = meetings.length
    ? meetings
        .map(
          (m) =>
            `<h3 style="font-size:15px;margin:14px 0 2px">${esc(m.title || "(untitled meeting)")} <span style="font-size:12px;color:#57606a;font-weight:normal">${esc(at(m.meetingAt))}${m.resolved.length ? ` &middot; ${m.resolved.length} already triaged` : ""}</span></h3>` +
            (m.open.length ? `<ul style="margin:4px 0 8px;font-size:14px">${m.open.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p style="color:#57606a;font-size:13px;margin:2px 0 8px">No open action items.</p>`),
        )
        .join("")
    : `<p style="color:#57606a">None.</p>`;
  const simpleTable = (head: string[], rows: string[][]) => table(head, rows.map((cells) => `<tr>${cells.map((x) => td(x)).join("")}</tr>`));
  const overCapBlock =
    overCapEmail.length + overCapTeams.length
      ? `<h2 style="font-size:19px;margin:28px 0 4px;color:#9a6700">${esc(r.notCheckedTitle)} (${overCapEmail.length + overCapTeams.length})</h2>
<p style="color:#57606a;font-size:13px;margin:0 0 6px">${esc(r.notCheckedNote)}</p>
${simpleTable(["From / chat", "Subject"], [...overCapEmail.map((f) => [`<b>${esc(f.latestOther?.name ?? "?")}</b><br><span style="color:#57606a;font-size:12px">${esc(at(f.latestOther?.at ?? null))}</span>`, esc(f.latestOther?.subject ?? "")]), ...overCapTeams.map((c) => [chatTitle(c), "(Teams)"])])}`
      : "";
  const ledgerSummary = ledger
    ? ` &middot; Teams: <b>${yT.length}</b> open of ${teamsShown.length} chats checked &middot; ${uninvolved.length} Teams group/meeting chats you are not part of, hidden &middot; From meetings: <b>${meetingOpen}</b> open action items in ${meetings.length} meetings &middot; ${resolvedEmail.length + resolvedTeams.length} already resolved by you (task added or ignored)${ledger.plan.teams.cantTell ? ` &middot; ${ledger.plan.teams.cantTell} group chats shown because Huddle cannot tell yet whether you are in them` : ""}${ledger.unavailable.length ? ` &middot; <span style="color:#9a6700">could not read ${esc(ledger.unavailable.join(" and "))}: nothing excluded on that account</span>` : ""}`
    : "";
  const ledgerHtml = ledger
    ? `<h2 style="font-size:19px;margin:28px 0 4px">Teams &mdash; open items (${yT.length})</h2>
${yesTableT(teamsShown)}
<h3 style="font-size:16px;margin:16px 0 4px;color:#57606a">Teams &mdash; AI says nothing open (${teamsShown.length - yT.length})</h3>
${noTableT(teamsShown.filter((x) => !x.yes))}
<h2 style="font-size:19px;margin:28px 0 4px">From meetings &mdash; action items not yet triaged (${meetingOpen})</h2>
<p style="color:#57606a;font-size:13px;margin:0 0 6px">Fireflies' own action-item list for each meeting, as stored. Items you already marked Mine / For someone / Skip are counted, not listed.</p>
${meetingBlock}
<details style="margin-top:28px"><summary style="font-size:16px;color:#57606a;cursor:pointer">Already resolved by you (${resolvedEmail.length + resolvedTeams.length}): a task was added from it, or you ignored it, and nothing newer arrived</summary>
${simpleTable(["From / chat", "Subject", "How"], [...resolvedEmail.map(({ f, via }) => [`<b>${esc(f.latestOther?.name ?? "?")}</b><br><span style="color:#57606a;font-size:12px">${esc(at(f.latestOther?.at ?? null))}</span>`, esc(f.latestOther?.subject ?? ""), esc(viaLabel[via.state] ?? via.state)]), ...resolvedTeams.map(({ c, via }) => [chatTitle(c), "(Teams)", esc(viaLabel[via.state] ?? via.state)])])}
</details>
<details style="margin-top:12px"><summary style="font-size:16px;color:#57606a;cursor:pointer">Teams group/meeting chats you are not part of (${uninvolved.length}): you never wrote in them and were never @mentioned</summary>
${simpleTable(["Chat", "Messages"], uninvolved.map((c) => [chatTitle(c), String(c.messages.length)]))}
</details>${teamsHidden.length ? `
<details style="margin-top:12px"><summary style="font-size:16px;color:#57606a;cursor:pointer">Teams hidden by your settings (${teamsHidden.length})</summary>
${noTableT(teamsHidden)}
</details>` : ""}`
    : "";
  const sinceLabel = at(new Date(sinceMs).toISOString());
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open items since ${esc(sinceLabel)}</title></head><body style="margin:16px;background:#fff;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328"><div style="max-width:900px;margin:0 auto">
<h1 style="font-size:22px;margin:0 0 4px">Steps 2 + 3: what is still open for you? (since ${esc(sinceLabel)} ET)</h1>
<p style="color:#57606a;font-size:13px;margin:0 0 12px">One question per conversation, answered by the AI (${esc(r.model)}) from the meaning of the whole thread, including the email inside any forward. A person writing to you personally now counts as a Reply even with no task. "Reply" = write back, "Do it" = an action with no reply needed. Tell me which YES are wrong and which NO should be YES.</p>
<p style="font-size:14px">Step 2 (you are on To): <b>${y2.length}</b> open &middot; ${answered2.length} answered by your reply &middot; Step 3 (CC or a list): <b>${y3.length}</b> with an action of ${shown3.length} &middot; ${hidden.length} hidden by your settings (${esc([...HIDE].join(", ").replace(/_/g, " "))}) &middot; ${r.ownerOnly} only you wrote${r.settledIndirect ? ` &middot; ${r.settledIndirect} CC/list you already answered` : ""}${r.failures ? ` &middot; ${r.failures} AI errors` : ""}${r.overCap ? ` &middot; ${r.overCap} not checked (cap)` : ""}${ledgerSummary}</p>
<p style="color:#57606a;font-size:12px;margin:0 0 12px">Read from: ${ledger ? "Huddle's Azure store (everything stored since the window start)" : "the OneDrive feed files"}.${r.storeNote ? ` ${esc(r.storeNote)}` : ""}</p>
<h2 style="font-size:19px;margin:28px 0 4px">Step 2 &mdash; you are on the To line: open items (${y2.length})</h2>
${yesTable(shown2)}
<h3 style="font-size:16px;margin:16px 0 4px;color:#57606a">Step 2 &mdash; answered by your reply (${answered2.length})</h3>
${noTable(answered2)}
<h3 style="font-size:16px;margin:16px 0 4px;color:#57606a">Step 2 &mdash; AI says nothing open (${none2.length})</h3>
${noTable(none2)}
<h2 style="font-size:19px;margin:28px 0 4px">Step 3 &mdash; CC'd or via a list: actions for you (${y3.length})</h2>
${yesTable(shown3)}
<h3 style="font-size:16px;margin:16px 0 4px;color:#57606a">Step 3 &mdash; AI says no action for you (${shown3.length - y3.length})</h3>
${noTable(shown3.filter((x) => !x.yes))}
${ledgerHtml}
${overCapBlock}
<details style="margin-top:28px"><summary style="font-size:16px;color:#57606a;cursor:pointer">Hidden by your settings (${hidden.length}): ${esc([...HIDE].join(", ").replace(/_/g, " "))}</summary>
${noTable(hidden)}
</details>
</div></body></html>`;
  return { html, logLines };
}
