// WHAT:       TUNING STEPS 2 + 3 of the correspondence redesign, run by scripts/reply-scan-preview.ts with PREVIEW_STEP=action.
//             Step 2: conversations where the owner is ON THE TO LINE (alone or with others) -- "is there an OPEN ITEM for
//             you, reply or not?". Step 3: conversations where he is only CC'd or got it through a list -- "is there an
//             ACTION for you anyway?". One model question per conversation, per step. Writes ONE HTML report to the owner's
//             OneDrive (/automation/Huddle Preview/action-scan-<timestamp>.html), prints its web link, and with
//             PREVIEW_EMAIL=1 also emails it. Stores nothing in Huddle.
// WHY:        Owner 2026-11-14, reviewing step 1: "Some of the items may not require a reply but requires an action. Next
//             ask for all that include me directly, find which of those have an open item. Next ask for all that address
//             me indirectly with an action." He circled six step-1 "no reply" rows that need ACTION (two manager forwards
//             with due dates, a security-account setup, an attachment he asked for, a CC'd hours notice, an intro).
//             Forwarded emails are now given to the model (lib/correspondence/forwarded.ts): the two manager forwards
//             were judged on the signature alone. THIS REPO'S LOGS ARE PUBLIC: counts, file path and web link only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current (its instructions + schema moved to the in-app classifier,
//             lib/correspondence/action-classify.ts, 2026-11-16, and are imported here).
// EVIDENCE:   .github/workflows/proposals-preview.yml step=action.
//
// 2026-11-16 (owner: "this report should be running against the table that has everything since Monday"): with
// `ledger` given (scripts/reply-scan-preview.ts PREVIEW_SOURCE=ledger, the default) the scan also covers TEAMS (one
// question per chat, the step-2 answer schema), lists the Fireflies action items of each meeting ("From meetings",
// no AI), and shows -- collapsed -- what was set aside: resolved by the owner (a decided task proposal or a dismissed
// bell row), Teams group/meeting chats he is not part of (UNINVOLVED_CHAT_RULE, skipped BEFORE any AI call), and
// anything over the model-call cap (listed, never silently dropped). Rules: lib/correspondence/report-from-ledger.ts.
import type { ConversationFacts, NeedsYouContext } from "../src/features/huddle/lib/correspondence/needs-you";
import type { LedgerReportPlan, TeamsChatFacts } from "../src/features/huddle/lib/correspondence/report-from-ledger";
import { FORWARD_SUBJECT, forwardedText } from "../src/features/huddle/lib/correspondence/forwarded";
import { mapFeedMessage, type OneDriveFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { EXTRACT_MODEL } from "../src/features/huddle/lib/proposals/proposals.server";
import {
  ACTION_SCHEMA,
  STEP2_INSTRUCTIONS,
  STEP3_INSTRUCTIONS,
  TEAMS_INSTRUCTIONS,
  emailActionInput,
  emailQuoteHaystack,
  quoteIsVerbatim,
  teamsActionInput,
  teamsQuoteHaystack,
} from "../src/features/huddle/lib/correspondence/action-classify";

// The instructions, schema, inputs and verbatim rule are the in-app classifier's (lib/correspondence/action-classify.ts,
// canonical since 2026-11-16): the report and the Actions view ask the model exactly the same question.
export { STEP2_INSTRUCTIONS, STEP3_INSTRUCTIONS, TEAMS_INSTRUCTIONS };

/** What the ledger source adds to the scan (scripts/reply-scan-preview.ts builds it). */
export interface LedgerScanPart {
  plan: LedgerReportPlan;
  /** Forwarded part of stored "Fw:" emails, by feed id (only plain-text forward headers survive storage). */
  forwards: Map<string, string>;
  forwardsMissing: number;
  forwardsTotal: number;
  /** Signal stores that could not be read: nothing was excluded on their account. */
  unavailable: string[];
}

const SCHEMA = ACTION_SCHEMA;

type Row = { f: ConversationFacts; yes: boolean; kind: string; todo: string | null; due: string | null; quote: string | null; quoteFound: boolean; confidence: string; reason: string; category: string };
type TRow = Omit<Row, "f"> & { c: TeamsChatFacts };
/** Categories the owner switched off (owner 2026-11-15: "Meeting invites, time keeping, verification codes can be
 *  toggled off in settings"). Seeded default; PREVIEW_HIDE_CATEGORIES overrides it until the settings screen exists.
 *  Hidden rows are listed collapsed at the end, never dropped. */
const HIDE = new Set(
  (process.env.PREVIEW_HIDE_CATEGORIES ?? "meeting_invite,timekeeping,verification_code").split(",").map((x) => x.trim()).filter(Boolean),
);

export async function runActionScan(a: {
  facts: ConversationFacts[];
  rawRecords: Record<string, unknown>[];
  cfg: OneDriveFeedsConfig;
  ctx: NeedsYouContext;
  token: string;
  drive: string;
  enc: (p: string) => string;
  sinceMs: number;
  maxCalls: number;
  newest: (f: ConversationFacts) => number;
  /** Present when the report reads the Azure ledger (the default source). */
  ledger?: LedgerScanPart;
}) {
  const { facts, cfg, ctx, token, drive, enc, sinceMs, maxCalls, newest, ledger } = a;
  // The forwarded part of every "Fw:" message, keyed by the same id the facts use.
  const fwd = new Map<string, string>(ledger ? ledger.forwards : []);
  const fwdStats = { subjects: 0, marker: 0, emptyBody: 0 };
  for (const r of ledger ? [] : a.rawRecords) {
    const body = r.body as unknown;
    const raw = typeof body === "string" ? body : body && typeof body === "object" ? String((body as Record<string, unknown>).content ?? "") : "";
    const isHtml = r.isHtml === true || (!!body && typeof body === "object" && String((body as Record<string, unknown>).contentType ?? "").toLowerCase() === "html");
    const isFwd = FORWARD_SUBJECT.test(String(r.subject ?? ""));
    if (isFwd) fwdStats.subjects++;
    if (isFwd && /id=["']?(?:divRplyFwdMsg|appendonsend)/i.test(raw)) fwdStats.marker++;
    if (isFwd && !raw.trim()) fwdStats.emptyBody++;
    const t = forwardedText(String(r.subject ?? ""), raw, isHtml);
    if (t) fwd.set(mapFeedMessage(r, cfg.mailbox).id, t);
  }
  // Counts only (public log): how many "Fw:" messages, how many carry Outlook's marker, how many had a readable forward.
  if (ledger) console.log(`forwards (ledger): Fw emails ${ledger.forwardsTotal} | forwarded text read ${fwd.size} | forwarded part not stored ${ledger.forwardsMissing}`);
  else console.log(`forwards: Fw subjects ${fwdStats.subjects} | with Outlook marker ${fwdStats.marker} | empty body ${fwdStats.emptyBody} | forwarded text read ${fwd.size}`);

  const input = (f: ConversationFacts) => emailActionInput(f, ctx.ownerNames, fwd);

  const { callOpenAIRouter } = await import("../src/features/huddle/lib/openai-responses.server");
  let calls = 0;
  let failures = 0;
  let overCap = 0;
  let ownerOnly = 0;
  let settledIndirect = 0;
  const step2: Row[] = [];
  const step3: Row[] = [];
  /** Not sent to the model because of the cap: LISTED in the report, never silently dropped. */
  const overCapEmail: ConversationFacts[] = [];
  const overCapTeams: TeamsChatFacts[] = [];
  for (const f of facts) {
    if (!f.latestOther) {
      ownerOnly++;
      continue;
    }
    const direct = f.ownerPosition === "direct" || f.ownerPosition === "group" || f.ownerPosition === "unknown";
    // Step 2 keeps conversations he already answered: an answer can still leave something for him to do.
    if (!direct && f.settled) {
      settledIndirect++;
      continue;
    }
    if (calls >= maxCalls) {
      overCap++;
      overCapEmail.push(f);
      continue;
    }
    calls++;
    try {
      const raw = (await callOpenAIRouter<unknown>({ model: EXTRACT_MODEL, system: direct ? STEP2_INSTRUCTIONS : STEP3_INSTRUCTIONS, prompt: input(f), schema: SCHEMA as unknown as Record<string, unknown>, schemaName: direct ? "open_item_scan" : "indirect_action_scan" })) as Record<string, unknown>;
      const quote = typeof raw?.quote === "string" && raw.quote.trim() ? raw.quote.trim() : null;
      const haystack = emailQuoteHaystack(f, fwd);
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
      (direct ? step2 : step3).push({
        f,
        yes: raw?.open_item === true,
        kind: String(raw?.kind ?? "?"),
        todo: str(raw?.todo),
        due: str(raw?.due),
        quote,
        quoteFound: quoteIsVerbatim(quote, haystack),
        confidence: String(raw?.confidence ?? "?"),
        reason: String(raw?.reason ?? "").slice(0, 300),
        category: String(raw?.category ?? "other"),
      });
    } catch {
      failures++;
    }
  }
  // ── TEAMS (ledger source only): one question per chat. Chats the owner is not part of were set aside BEFORE this
  // point (planLedgerReport, UNINVOLVED_CHAT_RULE) and never reach the model.
  const teamsRows: TRow[] = [];
  let teamsOwnerOnly = 0;
  const teamsChats = ledger?.plan.teams.scan ?? [];
  const teamsInput = (c: TeamsChatFacts) => teamsActionInput(c, ctx.ownerNames);
  for (const c of teamsChats) {
    if (!c.latestOther) {
      teamsOwnerOnly++;
      continue;
    }
    if (calls >= maxCalls) {
      overCap++;
      overCapTeams.push(c);
      continue;
    }
    calls++;
    try {
      const raw = (await callOpenAIRouter<unknown>({ model: EXTRACT_MODEL, system: TEAMS_INSTRUCTIONS, prompt: teamsInput(c), schema: SCHEMA as unknown as Record<string, unknown>, schemaName: "teams_open_item_scan" })) as Record<string, unknown>;
      const quote = typeof raw?.quote === "string" && raw.quote.trim() ? raw.quote.trim() : null;
      const haystack = teamsQuoteHaystack(c);
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
      teamsRows.push({
        c,
        yes: raw?.open_item === true,
        kind: String(raw?.kind ?? "?"),
        todo: str(raw?.todo),
        due: str(raw?.due),
        quote,
        quoteFound: quoteIsVerbatim(quote, haystack),
        confidence: String(raw?.confidence ?? "?"),
        reason: String(raw?.reason ?? "").slice(0, 300),
        category: String(raw?.category ?? "other"),
      });
    } catch {
      failures++;
    }
  }
  const teamsHidden = teamsRows.filter((r) => HIDE.has(r.category));
  const teamsShown = teamsRows.filter((r) => !HIDE.has(r.category));
  const yT = teamsShown.filter((r) => r.yes);
  const meetings = ledger?.plan.meetings.inWindow ?? [];
  const meetingOpen = meetings.reduce((n, m) => n + m.open.length, 0);
  const meetingDone = meetings.reduce((n, m) => n + m.resolved.length, 0);
  const resolvedEmail = ledger?.plan.email.resolved ?? [];
  const resolvedTeams = ledger?.plan.teams.resolved ?? [];
  const uninvolved = ledger?.plan.teams.hiddenUninvolved ?? [];

  const hidden = [...step2, ...step3].filter((r) => HIDE.has(r.category));
  const shown2 = step2.filter((r) => !HIDE.has(r.category));
  const shown3 = step3.filter((r) => !HIDE.has(r.category));
  const y2 = shown2.filter((r) => r.yes);
  const y3 = shown3.filter((r) => r.yes);
  const answered2 = shown2.filter((r) => !r.yes && r.f.settled);
  const none2 = shown2.filter((r) => !r.yes && !r.f.settled);
  const catCount = (rs: Row[]) => Object.entries(rs.reduce<Record<string, number>>((m, r) => ((m[r.category] = (m[r.category] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(", ");
  const nf = (rs: Row[]) => rs.filter((r) => r.yes && !r.quoteFound).length;
  console.log(
    `action-scan since ${new Date(sinceMs).toISOString().slice(0, 10)}: conversations ${facts.length} | model calls ${calls} | failures ${failures} | over cap ${overCap} | ` +
      `forwards read ${fwd.size} | STEP 2 (on To) open ${y2.length} of ${step2.length} (quote not found ${nf(step2)}) | ` +
      `STEP 3 (CC/list) action ${y3.length} of ${shown3.length} (quote not found ${nf(step3)}) | step 2 answered by reply ${answered2.length} | ` +
      `step 2 reply-kind open ${y2.filter((r) => r.kind === "reply" || r.kind === "both").length} | hidden by settings ${hidden.length} | categories: ${catCount([...step2, ...step3])} | ` +
      `settled CC/list ${settledIndirect} | owner-only ${ownerOnly} | model ${EXTRACT_MODEL}`,
  );
  if (ledger)
    console.log(
      `ledger sections: TEAMS open ${yT.length} of ${teamsShown.length} (quote not found ${teamsShown.filter((r) => r.yes && !r.quoteFound).length}; hidden by settings ${teamsHidden.length}; owner-only ${teamsOwnerOnly}) | ` +
        `teams not-involved hidden ${uninvolved.length} | resolved by you: email ${resolvedEmail.length}, teams ${resolvedTeams.length} | ` +
        `FROM MEETINGS ${meetings.length} meetings, open items ${meetingOpen}, already triaged ${meetingDone} | not checked (cap): email ${overCapEmail.length}, teams ${overCapTeams.length}`,
    );

  // ── HTML (owner's OneDrive / email only; never the public log).
  const esc = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const at = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "?");
  const pos: Record<string, string> = { direct: "To: you only", group: "To: you + others", cc_only: "CC only", none: "via a list / not listed", unknown: "?" };
  const kindLabel: Record<string, string> = { reply: "Reply", action: "Do it", both: "Reply + do it", none: "-" };
  const td = (c: string) => `<td valign="top" style="padding:8px 10px;border-bottom:1px solid #eaeef2;font-size:14px">${c}</td>`;
  const th = (cols: string[]) => `<tr>${cols.map((c) => `<th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de;font-size:12px;color:#57606a;text-transform:uppercase">${c}</th>`).join("")}</tr>`;
  const table = (head: string[], body: string[]) => (body.length ? `<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;margin:8px 0 24px">${th(head)}${body.join("")}</table>` : `<p style="color:#57606a">None.</p>`);
  const who = (r: Row) => `<b>${esc(r.f.latestOther!.name)}</b><br><span style="color:#57606a;font-size:12px">${esc(at(r.f.latestOther!.at))} &middot; ${esc(pos[r.f.ownerPosition] ?? r.f.ownerPosition)}${r.f.settled ? " &middot; you replied" : ""}</span>`;
  const confOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const yesTable = (rs: Row[]) =>
    table(
      ["From", "Subject", "What you need to do", "Sure?"],
      [...rs]
        .filter((r) => r.yes)
        .sort((x, y) => (confOrder[x.confidence] ?? 3) - (confOrder[y.confidence] ?? 3) || newest(y.f) - newest(x.f))
        .map(
          (r) =>
            `<tr>${td(who(r))}${td(esc(r.f.latestOther!.subject))}${td(
              `<b>${esc(r.todo ?? "(no to-do given)")}</b> <span style="font-size:12px;color:#57606a">[${esc(kindLabel[r.kind] ?? r.kind)}${r.due ? ` &middot; due ${esc(r.due)}` : ""}]</span><br>` +
                `${r.quote ? `<i>&ldquo;${esc(r.quote)}&rdquo;</i>${r.quoteFound ? "" : ` <span style="color:#9a6700">(quote not found word-for-word)</span>`}<br>` : ""}<span style="color:#57606a;font-size:13px">${esc(r.reason)}</span>`,
            )}${td(esc(r.confidence))}</tr>`,
        ),
    );
  const noTable = (rs: Row[]) =>
    table(
      ["From", "Subject", "Why not"],
      [...rs].sort((x, y) => newest(y.f) - newest(x.f)).map((r) => `<tr>${td(who(r))}${td(esc(r.f.latestOther!.subject))}${td(`<span style="font-size:13px">${esc(r.reason)}</span> <span style="font-size:11px;color:#8c959f">[${esc(r.category.replace(/_/g, " "))}]</span>`)}</tr>`),
    );
  // ── Ledger-only sections (Teams, meetings, what was set aside). Over-cap rows are listed for both sources.
  const kindName: Record<string, string> = { one_on_one: "1:1 chat", group: "group chat", meeting: "meeting chat", channel: "channel", unknown: "chat" };
  const viaLabel: Record<string, string> = { approved: "added as a task", completed: "task completed", dismissed: "ignored", delegated: "passed to someone" };
  const chatTitle = (c: TeamsChatFacts) => `<b>${esc(c.chatName || (c.kind === "one_on_one" ? c.latestOther?.name ?? "1:1 chat" : "(unnamed chat)"))}</b><br><span style="color:#57606a;font-size:12px">${esc(kindName[c.kind] ?? c.kind)}${c.latestOther ? ` &middot; ${esc(c.latestOther.name)} &middot; ${esc(at(c.latestOther.at))}` : ""}${c.settled ? " &middot; you replied" : ""}${c.ownerMentioned ? " &middot; you were @mentioned" : ""}${c.webUrl ? ` &middot; <a href="${esc(c.webUrl)}">open</a>` : ""}</span>`;
  const yesTableT = (rs: TRow[]) =>
    table(
      ["Chat", "What you need to do", "Sure?"],
      [...rs]
        .filter((r) => r.yes)
        .sort((x, y) => (confOrder[x.confidence] ?? 3) - (confOrder[y.confidence] ?? 3) || y.c.newestMs - x.c.newestMs)
        .map(
          (r) =>
            `<tr>${td(chatTitle(r.c))}${td(
              `<b>${esc(r.todo ?? "(no to-do given)")}</b> <span style="font-size:12px;color:#57606a">[${esc(kindLabel[r.kind] ?? r.kind)}${r.due ? ` &middot; due ${esc(r.due)}` : ""}]</span><br>` +
                `${r.quote ? `<i>&ldquo;${esc(r.quote)}&rdquo;</i>${r.quoteFound ? "" : ` <span style="color:#9a6700">(quote not found word-for-word)</span>`}<br>` : ""}<span style="color:#57606a;font-size:13px">${esc(r.reason)}</span>`,
            )}${td(esc(r.confidence))}</tr>`,
        ),
    );
  const noTableT = (rs: TRow[]) =>
    table(
      ["Chat", "Why not"],
      [...rs].sort((x, y) => y.c.newestMs - x.c.newestMs).map((r) => `<tr>${td(chatTitle(r.c))}${td(`<span style="font-size:13px">${esc(r.reason)}</span> <span style="font-size:11px;color:#8c959f">[${esc(r.category.replace(/_/g, " "))}]</span>`)}</tr>`),
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
      ? `<h2 style="font-size:19px;margin:28px 0 4px;color:#9a6700">Not checked by the AI: over the cap of ${maxCalls} (${overCapEmail.length + overCapTeams.length})</h2>
<p style="color:#57606a;font-size:13px;margin:0 0 6px">These were NOT judged. Re-run with a higher max_sources to include them.</p>
${simpleTable(["From / chat", "Subject"], [...overCapEmail.map((f) => [`<b>${esc(f.latestOther?.name ?? "?")}</b><br><span style="color:#57606a;font-size:12px">${esc(at(f.latestOther?.at ?? null))}</span>`, esc(f.latestOther?.subject ?? "")]), ...overCapTeams.map((c) => [chatTitle(c), "(Teams)"])])}`
      : "";
  const ledgerSummary = ledger
    ? ` &middot; Teams: <b>${yT.length}</b> open of ${teamsShown.length} chats checked &middot; ${uninvolved.length} Teams group/meeting chats you are not part of, hidden &middot; From meetings: <b>${meetingOpen}</b> open action items in ${meetings.length} meetings &middot; ${resolvedEmail.length + resolvedTeams.length} already resolved by you (task added or ignored)${ledger.plan.teams.cantTell ? ` &middot; ${ledger.plan.teams.cantTell} group chats shown because Huddle cannot tell yet whether you are in them` : ""}${ledger.unavailable.length ? ` &middot; <span style="color:#9a6700">could not read ${esc(ledger.unavailable.join(" and "))}: nothing excluded on that account</span>` : ""}`
    : "";
  const ledgerHtml = ledger
    ? `<h2 style="font-size:19px;margin:28px 0 4px">Teams &mdash; open items (${yT.length})</h2>
${yesTableT(teamsShown)}
<h3 style="font-size:16px;margin:16px 0 4px;color:#57606a">Teams &mdash; AI says nothing open (${teamsShown.length - yT.length})</h3>
${noTableT(teamsShown.filter((r) => !r.yes))}
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
<p style="color:#57606a;font-size:13px;margin:0 0 12px">One question per conversation, answered by the AI (${esc(EXTRACT_MODEL)}) from the meaning of the whole thread, including the email inside any forward. A person writing to you personally now counts as a Reply even with no task. "Reply" = write back, "Do it" = an action with no reply needed. Tell me which YES are wrong and which NO should be YES.</p>
<p style="font-size:14px">Step 2 (you are on To): <b>${y2.length}</b> open &middot; ${answered2.length} answered by your reply &middot; Step 3 (CC or a list): <b>${y3.length}</b> with an action of ${shown3.length} &middot; ${hidden.length} hidden by your settings (${esc([...HIDE].join(", ").replace(/_/g, " "))}) &middot; ${ownerOnly} only you wrote${settledIndirect ? ` &middot; ${settledIndirect} CC/list you already answered` : ""}${failures ? ` &middot; ${failures} AI errors` : ""}${overCap ? ` &middot; ${overCap} not checked (cap)` : ""}${ledgerSummary}</p>
<p style="color:#57606a;font-size:12px;margin:0 0 12px">Read from: ${ledger ? "Huddle's Azure store (everything stored since the window start)" : "the OneDrive feed files"}.</p>
<h2 style="font-size:19px;margin:28px 0 4px">Step 2 &mdash; you are on the To line: open items (${y2.length})</h2>
${yesTable(shown2)}
<h3 style="font-size:16px;margin:16px 0 4px;color:#57606a">Step 2 &mdash; answered by your reply (${answered2.length})</h3>
${noTable(answered2)}
<h3 style="font-size:16px;margin:16px 0 4px;color:#57606a">Step 2 &mdash; AI says nothing open (${none2.length})</h3>
${noTable(none2)}
<h2 style="font-size:19px;margin:28px 0 4px">Step 3 &mdash; CC'd or via a list: actions for you (${y3.length})</h2>
${yesTable(shown3)}
<h3 style="font-size:16px;margin:16px 0 4px;color:#57606a">Step 3 &mdash; AI says no action for you (${shown3.length - y3.length})</h3>
${noTable(shown3.filter((r) => !r.yes))}
${ledgerHtml}
${overCapBlock}
<details style="margin-top:28px"><summary style="font-size:16px;color:#57606a;cursor:pointer">Hidden by your settings (${hidden.length}): ${esc([...HIDE].join(", ").replace(/_/g, " "))}</summary>
${noTable(hidden)}
</details>
</div></body></html>`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = `/automation/Huddle Preview/action-scan-${stamp}.html`;
  const put = await fetch(`${drive}${enc(out)}:/content`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/html" }, body: html });
  let webUrl = "";
  try {
    webUrl = String(((await put.json()) as Record<string, unknown>)?.webUrl ?? "");
  } catch {
    /* no link in the response */
  }
  console.log(`action scan file: HTTP ${put.status} -> OneDrive ${out}`);
  // The web link is NOT printed: it carries the owner's OneDrive path, and this repo's Actions logs are public
  // (verifier loop 9, 3c). The session builds the link from the file path above.
  void webUrl;
  if (!put.ok) process.exitCode = 1;
  if (process.env.PREVIEW_EMAIL === "1") {
    const from = (process.env.HUDDLE_EMAIL_FROM || "dev@enterpriseds.io").split(",")[0].trim();
    const send = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { subject: `Huddle steps 2+3: what is still open for you since ${sinceLabel}`, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: cfg.driveUser } }] }, saveToSentItems: false }),
    });
    console.log(`email: sendMail HTTP ${send.status}`);
  }
}
