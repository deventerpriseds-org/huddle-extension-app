// WHAT:          The Actions view's two passes over the stored ledger plan, every I/O injected:
//                (1) CLASSIFY (heartbeat): each in-window thread whose current version has no stored verdict goes to the
//                    canonical classifier ONCE, the answer passes the Tier 1 admission guard, an admitted item is backed
//                    by a chat.task_proposals row through the EXISTING proposeFromSource path, and the verdict is stored
//                    on the thread's latest ledger row (result_ids.action). Meeting items (owner's or unassigned) become
//                    the EXISTING triage rows. Capped per day; no call when switched off.
//                (2) CANDIDATES (page read, no model call): plan + stored verdicts + backing proposals + bell rows ->
//                    ActionCandidate[] for selectActionItems.
// WHY:           Owner-approved Actions view (2026-11-16). AC docs/qc-evidence/AC-actions-view-modules.md E, E-U, H.
// SUPERSEDES:    nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/actions-view.test.ts; docs/qc-evidence/BUILD-actions-view.md.
//
// LOGS ARE PUBLIC-SAFE: this module never logs; the server prints the returned COUNTS only.

import {
  actionSectionFor,
  admitActionVerdict,
  emailActionInput,
  emailInstructionsFor,
  emailQuoteHaystack,
  TEAMS_INSTRUCTIONS,
  teamsActionInput,
  teamsQuoteHaystack,
  type ActionVerdict,
} from "../correspondence/action-classify";
import type { ConversationFacts } from "../correspondence/needs-you";
import type { AssembledLedgerPlan, LedgerReportRow, MeetingItems, TeamsChatFacts } from "../correspondence/report-from-ledger";
import type { EmailContent } from "../correspondence/source-item";
import { FEED_ID_PREFIX } from "../external-feeds/onedrive-feed";
import { meetingItemIsOwnersOrUnassigned } from "../proposals/meeting-triage";
import { titleKey } from "../proposals/proposals";
import { safeLink } from "../attention/attention";
import { correctionFor, type ActionCandidate, type ActionsSettings } from "./actions";

const stripFeed = (id: string) => (id.startsWith(FEED_ID_PREFIX) ? id.slice(FEED_ID_PREFIX.length) : id);

/** One classifiable thread: where its verdict is stored and what the backing proposal's ref is. */
export interface ThreadUnit {
  source: "email" | "teams";
  /** Classification key: thread key + latest message ledger id. */
  itemKey: string;
  /** The ledger row the verdict is stored on (the thread's latest message). */
  storeAt: { source: "email" | "teams"; sourceItemId: string };
  /** The ledger id of the latest OTHER message: the backing proposal's source ref. */
  refItemId: string;
  at: string | null;
  email?: ConversationFacts;
  teams?: TeamsChatFacts;
  uninvolved: boolean;
}

/** Pure: the threads of the plan the Actions view covers. Uninvolved chats are included (flagged) only when the
 *  owner switched the filter OFF; otherwise they never become units, so they can never reach the model (AC-EU-2). */
export function threadUnits(a: AssembledLedgerPlan, s: ActionsSettings): { units: ThreadUnit[]; uninvolvedHidden: number } {
  const units: ThreadUnit[] = [];
  if (s.sources.email) {
    for (const f of a.plan.email.scan) {
      if (!f.latestOther) continue; // owner-only thread: nothing from anyone else to act on
      const last = f.messages[f.messages.length - 1];
      units.push({ source: "email", itemKey: `${f.key}|${last.id}`, storeAt: { source: "email", sourceItemId: stripFeed(last.id) }, refItemId: stripFeed(f.latestOther.id), at: f.latestOther.at, email: f, uninvolved: false });
    }
  }
  const chat = (c: TeamsChatFacts, uninvolved: boolean) => {
    if (!c.latestOther) return;
    const last = c.messages[c.messages.length - 1];
    units.push({ source: "teams", itemKey: `teams:${c.chatId}|${last.id}`, storeAt: { source: "teams", sourceItemId: last.id }, refItemId: c.latestOther.id, at: c.latestOther.at, teams: c, uninvolved });
  };
  if (s.sources.teams) {
    for (const c of a.plan.teams.scan) chat(c, false);
    if (!s.hideUninvolvedChats) for (const c of a.plan.teams.hiddenUninvolved) chat(c, true);
  }
  return { units, uninvolvedHidden: s.sources.teams && s.hideUninvolvedChats ? a.plan.teams.hiddenUninvolved.length : 0 };
}

/** Pure: the meeting items Actions covers: in-window, not already triaged, and the owner's or unassigned. */
export function meetingUnits(meetings: readonly MeetingItems[], ownerNames: readonly string[]): { meeting: MeetingItems; items: string[]; othersHidden: number }[] {
  return meetings.map((m) => {
    const items: string[] = [];
    let othersHidden = 0;
    m.open.forEach((it, i) => (meetingItemIsOwnersOrUnassigned(m.openHeadings?.[i] ?? null, ownerNames) ? items.push(it) : othersHidden++));
    return { meeting: m, items, othersHidden };
  });
}

/** At most this many model calls per pass (a pass rides the ~45s heartbeat). */
export const CLASSIFY_PER_PASS = 6;

/** Pure (AC-H-3, loop-2 D2): how many model calls this pass may START. `attemptsToday` is every model call ATTEMPT
 *  made since the owner's local midnight (recorded at the moment of the call, whatever happened after it). */
export function classifyCallsLeft(attemptsToday: number, dailyCap: number): number {
  return Math.max(0, Math.min(CLASSIFY_PER_PASS, dailyCap - (Number.isFinite(attemptsToday) ? attemptsToday : dailyCap)));
}

export interface ClassifyDeps {
  /** Loop-2 D2: record ONE model call attempt (durably, on the thread's ledger row) BEFORE the call is made, so a
   *  call that times out, fails, or whose verdict / proposal write fails still counts toward the daily cap. Throws
   *  when it cannot record; then no call is made. */
  recordCall(at: ThreadUnit["storeAt"]): Promise<void>;
  /** The model call (strict JSON). Throws on failure. */
  model(system: string, input: string, schemaName: string): Promise<unknown>;
  /** Back an admitted item with a proposal (EXISTING proposeFromSource). onBoard = already an open board task. */
  propose(unit: ThreadUnit, v: ActionVerdict, threadText: string): Promise<{ id: string | null; onBoard: boolean }>;
  storeVerdict(at: ThreadUnit["storeAt"], v: ActionVerdict): Promise<void>;
  /** The EXISTING meeting-triage rows (addTriageRows(triageRowsFor(...))). */
  addMeetingRows(m: MeetingItems, items: string[]): Promise<number>;
  nowIso(): string;
  /** Wall-clock guard: no new model call starts after this (the pass rides the ~45s heartbeat). */
  nowMs?(): number;
  deadlineMs?: number;
}

export interface ClassifyResult {
  calls: number;
  open: number;
  none: number;
  notChecked: number;
  failures: number;
  overCap: number;
  alreadyJudged: number;
  meetingRows: number;
  uninvolvedSkipped: number;
}

/**
 * The heartbeat CLASSIFY pass. `judged` = the item keys that already have a stored verdict (AC-E-7). `callsLeft` =
 * classifyCallsLeft(attempts today, daily cap) (AC-E-8 / AC-H-3). A model failure stores no verdict (retried next
 * pass, AC-E-5), but its attempt was recorded first, so retries still spend the daily cap (D2).
 */
export async function runClassify(
  a: AssembledLedgerPlan,
  s: ActionsSettings,
  judged: ReadonlySet<string>,
  callsLeft: number,
  deps: ClassifyDeps,
): Promise<ClassifyResult> {
  const res: ClassifyResult = { calls: 0, open: 0, none: 0, notChecked: 0, failures: 0, overCap: 0, alreadyJudged: 0, meetingRows: 0, uninvolvedSkipped: 0 };
  const { units, uninvolvedHidden } = threadUnits(a, s);
  res.uninvolvedSkipped = uninvolvedHidden;
  for (const u of units) {
    if (judged.has(u.itemKey)) {
      res.alreadyJudged++;
      continue;
    }
    if (res.calls >= callsLeft || (deps.deadlineMs !== undefined && deps.nowMs && deps.nowMs() >= deps.deadlineMs)) {
      res.overCap++;
      continue;
    }
    // D2: the attempt is counted BEFORE the call. No record, no call (the store is what the cap reads).
    try {
      await deps.recordCall(u.storeAt);
    } catch {
      res.failures++;
      break;
    }
    res.calls++;
    let raw: unknown;
    try {
      if (u.email) {
        const ins = emailInstructionsFor(u.email);
        raw = await deps.model(ins.system, emailActionInput(u.email, a.ctx.ownerNames, a.forwards), ins.schemaName);
      } else {
        raw = await deps.model(TEAMS_INSTRUCTIONS, teamsActionInput(u.teams!, a.ctx.ownerNames), "teams_open_item_scan");
      }
    } catch {
      res.failures++;
      continue;
    }
    const haystack = u.email ? emailQuoteHaystack(u.email, a.forwards) : teamsQuoteHaystack(u.teams!);
    const settled = u.email ? u.email.settled : u.teams!.settled;
    let v = admitActionVerdict(raw, haystack, { key: u.itemKey, settled, nowIso: deps.nowIso() });
    if (v.status === "open") {
      const text = u.email ? u.email.messages.map((m) => m.text).filter(Boolean).join("\n\n") : u.teams!.messages.map((m) => m.text).filter(Boolean).join("\n\n");
      try {
        const p = await deps.propose(u, v, text);
        v = { ...v, proposalId: p.id, ...(p.onBoard ? { onBoard: true } : {}) };
      } catch {
        res.failures++;
        continue; // nothing stored: retried next pass
      }
    }
    try {
      await deps.storeVerdict(u.storeAt, v);
    } catch {
      res.failures++;
      continue;
    }
    if (v.status === "open") res.open++;
    else if (v.status === "none") res.none++;
    else res.notChecked++;
  }
  if (s.sources.meeting) {
    for (const mu of meetingUnits(a.plan.meetings.inWindow, a.ctx.ownerNames)) {
      if (!mu.items.length) continue;
      try {
        res.meetingRows += await deps.addMeetingRows(mu.meeting, mu.items);
      } catch {
        res.failures++;
      }
    }
  }
  return res;
}

// ── CANDIDATES (page read) ──────────────────────────────────────────────────────────────────────────

export interface ProposalLite {
  id: string;
  state: string;
  title: string;
  assignee: string | null;
  /** The stored owner_correction column as read (per-item map, or the pre-D4 single shape); read with correctionFor. */
  correction: unknown;
}

export interface MeetingProposalLite extends ProposalLite {
  meetingId: string;
  normTitle: string;
}

export interface ReplyRowLite {
  id: string;
  graphMessageId: string;
  conversationId: string | null;
  status: string;
  proposedReply: string | null;
  draftWebLink: string | null;
}

const POSITION_LABEL: Record<string, string> = { direct: "To: you", group: "To: you + others", cc_only: "CC", none: "Via a list", unknown: "" };

/** Pure: everything the page lists or counts, as candidates for selectActionItems. */
export function buildCandidates(a: {
  assembled: AssembledLedgerPlan;
  rows: readonly LedgerReportRow[];
  settings: ActionsSettings;
  /** Stored verdicts by "<source>\u0000<ledger id>" of the latest message row. */
  verdicts: ReadonlyMap<string, ActionVerdict>;
  proposals: ReadonlyMap<string, ProposalLite>;
  meetingProposals: readonly MeetingProposalLite[];
  replies: readonly ReplyRowLite[];
  isDraftable(graphMessageId: string): boolean;
}): { candidates: ActionCandidate[]; uninvolvedHidden: number; meetingOthersHidden: number } {
  const out: ActionCandidate[] = [];
  const emailById = new Map<string, EmailContent>();
  for (const r of a.rows) if (r.source === "email" && r.content?.kind === "email") emailById.set(r.sourceItemId, r.content as EmailContent);
  const { units, uninvolvedHidden } = threadUnits(a.assembled, a.settings);
  for (const u of units) {
    const v = a.verdicts.get(`${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`);
    const current = v && v.key === u.itemKey ? v : null;
    const p = current?.proposalId ? a.proposals.get(current.proposalId) ?? null : null;
    const base = {
      proposalId: p?.id ?? null,
      proposalState: p?.state ?? null,
      status: current?.status ?? ("not_checked" as const),
      answeredByReply: current?.answeredByReply ?? false,
      onBoard: current?.onBoard === true,
      category: current?.category ?? null,
      kind: current?.kind ?? null,
      itemKey: u.itemKey,
      // D4: only THIS item version's correction; another thread sharing the proposal never hides or un-hides it.
      correction: p ? correctionFor(p.correction, u.itemKey) : null,
      uninvolved: u.uninvolved,
      at: u.at,
    };
    if (u.email) {
      const f = u.email;
      const lo = f.latestOther!;
      const c = emailById.get(stripFeed(lo.id));
      const list = f.ownerPosition === "cc_only" || f.ownerPosition === "none";
      const ids = new Set(f.messages.map((m) => m.id));
      const reply = a.replies.find((r) => ids.has(r.graphMessageId)) ?? (f.conversationId ? a.replies.find((r) => r.conversationId === f.conversationId) : undefined) ?? null;
      out.push({
        ...base,
        source: "email",
        section: actionSectionFor("email", current?.kind ?? null, f.ownerPosition),
        listSender: list ? String(c?.from?.address ?? "").trim().toLowerCase() || null : null,
        display: {
          title: p?.title ?? current?.todo ?? lo.subject ?? "",
          who: lo.name,
          sourceLabel: ["Email", POSITION_LABEL[f.ownerPosition] ?? ""].filter(Boolean).join(" · "),
          reasonLine: current?.reason ?? null,
          quote: current?.quote ?? null,
          due: current?.due ?? null,
          reply: reply ? { emailReplyId: reply.id, draftable: a.isDraftable(reply.graphMessageId), proposedReply: reply.proposedReply, status: reply.status, webLink: reply.draftWebLink } : null,
          replyAsk: { who: lo.name, subject: lo.subject || null },
          teamsLink: null,
          meetingTitle: null,
          assignee: null,
        },
      });
    } else {
      const c = u.teams!;
      const lo = c.latestOther!;
      out.push({
        ...base,
        source: "teams",
        section: actionSectionFor("teams", current?.kind ?? null),
        listSender: null,
        display: {
          title: p?.title ?? current?.todo ?? (c.chatName || lo.name),
          who: lo.name,
          sourceLabel: c.kind === "one_on_one" ? "Teams 1:1" : `Teams${c.chatName ? `, ${c.chatName}` : ""}`,
          reasonLine: current?.reason ?? null,
          quote: current?.quote ?? null,
          due: current?.due ?? null,
          reply: null,
          replyAsk: null,
          teamsLink: safeLink(c.webUrl) ?? null,
          meetingTitle: null,
          assignee: null,
        },
      });
    }
  }
  // Meetings: the triage rows (untriaged / Mine) of in-window items that are the owner's or unassigned.
  let meetingOthersHidden = 0;
  if (a.settings.sources.meeting) {
    const allowed = new Map<string, MeetingItems>();
    for (const mu of meetingUnits(a.assembled.plan.meetings.inWindow, a.assembled.ctx.ownerNames)) {
      meetingOthersHidden += mu.othersHidden;
      for (const it of mu.items) allowed.set(`${mu.meeting.meetingId}\u0000${titleKey(it)}`, mu.meeting);
    }
    for (const p of a.meetingProposals) {
      const m = allowed.get(`${p.meetingId}\u0000${p.normTitle}`);
      if (!m) continue;
      out.push({
        proposalId: p.id,
        proposalState: p.state,
        status: "open",
        answeredByReply: false,
        onBoard: false,
        section: "meetings",
        category: null,
        kind: "action",
        itemKey: `meeting:${p.meetingId}|${p.normTitle}`,
        correction: correctionFor(p.correction, `meeting:${p.meetingId}|${p.normTitle}`),
        listSender: null,
        uninvolved: false,
        at: m.meetingAt,
        source: "meeting",
        display: {
          title: p.title,
          who: m.title ?? "Meeting",
          sourceLabel: "Meeting notes",
          reasonLine: p.state === "untriaged" ? "Action item from the notes. Not yet sorted." : "Action item from the notes.",
          quote: null,
          due: null,
          reply: null,
          replyAsk: null,
          teamsLink: null,
          meetingTitle: m.title,
          assignee: p.assignee,
        },
      });
    }
  }
  return { candidates: out, uninvolvedHidden, meetingOthersHidden };
}
