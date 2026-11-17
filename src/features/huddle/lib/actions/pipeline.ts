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
  canonQuote,
  CLASSIFIER_INPUT_VERSION,
  plainRoles,
  emailActionInput,
  emailInstructionsFor,
  emailQuoteHaystack,
  TEAMS_INSTRUCTIONS,
  teamsActionInput,
  teamsQuoteHaystack,
  type ActionVerdict,
} from "../correspondence/action-classify";
import { personNameWordCount, type ConversationFacts } from "../correspondence/needs-you";
import { foldPersonName, normTeamsId, type AssembledLedgerPlan, type LedgerReportRow, type MeetingItems, type TeamsChatFacts } from "../correspondence/report-from-ledger";
import type { EmailContent } from "../correspondence/source-item";
import { FEED_ID_PREFIX } from "../external-feeds/onedrive-feed";
import { meetingItemIsOwnersOrUnassigned } from "../proposals/meeting-triage";
import { titleKey } from "../proposals/proposals";
import { safeLink } from "../attention/attention";
import { correctionFor, plainPreview, type ActionCandidate, type ActionsSettings } from "./actions";

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

/** Pure (loop-2 D-1): is a stored verdict the CURRENT judgement of this thread version? Same item key AND judged at
 *  the current classifier-input version of its source (absent = 1). An older verdict is neither reused nor shown. */
export function verdictIsCurrent(v: Pick<ActionVerdict, "key" | "inputVersion"> | null | undefined, itemKey: string, source: "email" | "teams"): boolean {
  return !!v && v.key === itemKey && (v.inputVersion ?? 1) === CLASSIFIER_INPUT_VERSION[source];
}

/** Pure (loop-2 D-1): the item keys whose stored verdict is current, from the stored verdicts keyed
 *  "<source>\u0000<ledger id>" (as loadVerdicts reads them). Only these are skipped by the classify pass. */
export function currentlyJudgedKeys(verdicts: ReadonlyMap<string, ActionVerdict>): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of verdicts) {
    const source = k.slice(0, k.indexOf("\u0000"));
    if ((source === "email" || source === "teams") && v && typeof v.key === "string" && verdictIsCurrent(v, v.key, source)) out.add(v.key);
  }
  return out;
}

/** At most this many model calls per pass (a pass rides the ~45s heartbeat). */
export const CLASSIFY_PER_PASS = 6;

/** Pure (AC-H-3, loop-2 D2): how many model calls this pass may START. `attemptsToday` is every model call ATTEMPT
 *  made since the owner's local midnight (recorded at the moment of the call, whatever happened after it).
 *  `perPass` (2026-11-17) is the caller's own per-pass limit (default CLASSIFY_PER_PASS, which the heartbeat uses).
 *  The daily cap bounds every caller. */
export function classifyCallsLeft(attemptsToday: number, dailyCap: number, perPass: number = CLASSIFY_PER_PASS): number {
  return Math.max(0, Math.min(perPass, dailyCap - (Number.isFinite(attemptsToday) ? attemptsToday : dailyCap)));
}

// ── 2026-11-17: runClassify may start several model calls together (`ClassifyDeps.concurrency`), through the SAME
// pass and still bounded by the daily cap and the D2 attempt record. The heartbeat's own pass is unchanged
// (CLASSIFY_PER_PASS, one at a time); the option exists for the daily-report path.

/** Model calls started together (one batch) when a caller asks for parallelism. Each call is bounded by the 15s
 *  model timeout, so a batch is too. */
export const CLASSIFY_PARALLEL = 5;

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
  /** 2026-11-17: model calls started together per batch (default 1 = the original one-at-a-time pass). */
  concurrency?: number;
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
  const pending: ThreadUnit[] = [];
  for (const u of units) {
    if (judged.has(u.itemKey)) res.alreadyJudged++;
    else pending.push(u);
  }
  const conc = Math.max(1, Math.floor(deps.concurrency ?? 1));
  let stop = false;
  /** One unit, start to stored verdict. Returns false when its attempt could not be recorded (then nothing more
   *  starts). JS is single-threaded, so the shared counters stay exact across a parallel batch. */
  const judgeOne = async (u: ThreadUnit): Promise<boolean> => {
    // D2: the attempt is counted BEFORE the call. No record, no call (the store is what the cap reads).
    try {
      await deps.recordCall(u.storeAt);
    } catch {
      res.failures++;
      return false;
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
      return true;
    }
    const haystack = u.email ? emailQuoteHaystack(u.email, a.forwards) : teamsQuoteHaystack(u.teams!);
    const settled = u.email ? u.email.settled : u.teams!.settled;
    let v = admitActionVerdict(raw, haystack, { key: u.itemKey, settled, nowIso: deps.nowIso(), inputVersion: CLASSIFIER_INPUT_VERSION[u.source] });
    if (v.status === "open") {
      const text = u.email ? u.email.messages.map((m) => m.text).filter(Boolean).join("\n\n") : u.teams!.messages.map((m) => m.text).filter(Boolean).join("\n\n");
      try {
        const p = await deps.propose(u, v, text);
        v = { ...v, proposalId: p.id, ...(p.onBoard ? { onBoard: true } : {}) };
      } catch {
        res.failures++;
        return true; // nothing stored: retried next pass
      }
    }
    try {
      await deps.storeVerdict(u.storeAt, v);
    } catch {
      res.failures++;
      return true;
    }
    if (v.status === "open") res.open++;
    else if (v.status === "none") res.none++;
    else res.notChecked++;
    return true;
  };
  let i = 0;
  while (i < pending.length && !stop) {
    if (res.calls >= callsLeft || (deps.deadlineMs !== undefined && deps.nowMs && deps.nowMs() >= deps.deadlineMs)) {
      res.overCap += pending.length - i;
      break;
    }
    // Never start more calls than the cap has left: the batch is sized by the remaining allowance.
    const batch = pending.slice(i, i + Math.min(conc, callsLeft - res.calls));
    i += batch.length;
    const recorded = await Promise.all(batch.map(judgeOne));
    if (recorded.includes(false)) stop = true;
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
  // Loop-2 D-2: the latest OTHER sender's Teams id per Teams item (for the de-dup's same-sender test only).
  const teamsSenderById = new Map<string, string>();
  for (const r of a.rows) if (r.source === "teams" && r.content?.kind === "teams") teamsSenderById.set(r.sourceItemId, normTeamsId((r.content as { sender?: { id?: unknown } }).sender?.id));
  const senderByItem = new Map<string, string>();
  const { units, uninvolvedHidden } = threadUnits(a.assembled, a.settings);
  for (const u of units) {
    const v = a.verdicts.get(`${u.storeAt.source}\u0000${u.storeAt.sourceItemId}`);
    const current = v && verdictIsCurrent(v, u.itemKey, u.source) ? v : null;
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
    // 2026-11-17: an item with no current verdict is listed under "Not checked yet" with a plain preview of the
    // latest message from the other person (display only).
    const preview = current ? null : plainPreview((u.email ?? u.teams)?.latestOther?.text ?? null);
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
          title: p?.title ?? plainRoles(current?.todo) ?? lo.subject ?? "",
          who: lo.name,
          sourceLabel: ["Email", POSITION_LABEL[f.ownerPosition] ?? ""].filter(Boolean).join(" · "),
          reasonLine: plainRoles(current?.reason ?? null),
          quote: current?.quote ?? null,
          due: current?.due ?? null,
          reply: reply ? { emailReplyId: reply.id, draftable: a.isDraftable(reply.graphMessageId), proposedReply: reply.proposedReply, status: reply.status, webLink: reply.draftWebLink } : null,
          replyAsk: { who: lo.name, subject: lo.subject || null },
          teamsLink: null,
          meetingTitle: null,
          assignee: null,
          preview,
        },
      });
    } else {
      const c = u.teams!;
      const lo = c.latestOther!;
      const sid = teamsSenderById.get(lo.id);
      if (sid) senderByItem.set(u.itemKey, sid);
      out.push({
        ...base,
        source: "teams",
        section: actionSectionFor("teams", current?.kind ?? null),
        listSender: null,
        display: {
          title: p?.title ?? plainRoles(current?.todo) ?? (c.chatName || lo.name),
          who: lo.name,
          sourceLabel: teamsSourceLabel(c, a.assembled.ctx.ownerFullNames ?? []),
          reasonLine: plainRoles(current?.reason ?? null),
          quote: current?.quote ?? null,
          due: current?.due ?? null,
          reply: null,
          replyAsk: null,
          teamsLink: safeLink(c.webUrl) ?? null,
          meetingTitle: null,
          assignee: null,
          preview,
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
  return { candidates: collapseDuplicateTeamsItems(out, (c) => senderByItem.get(c.itemKey) ?? null), uninvolvedHidden, meetingOthersHidden };
}

// ── 2026-11-17 accuracy fixes (owner report: one Teams ask showed twice, "Teams 1:1" and "Teams, <his own name>") ──

/** Pure: the Teams source label. A non-1:1 chat whose Teams name is only the owner's own name (Teams names an
 *  untitled group chat after its members) is labelled "Teams group chat", never with the owner's name. */
export function teamsSourceLabel(c: Pick<TeamsChatFacts, "kind" | "chatName">, ownerNames: readonly string[]): string {
  if (c.kind === "one_on_one") return "Teams 1:1";
  // Loop-2 D-3: FULL names only (ownerFullNames); a chat named after a bare first name keeps its name.
  const own = new Set(ownerNames.filter((n) => personNameWordCount(n) >= 2).map(foldPersonName).filter(Boolean));
  const name = c.chatName && !own.has(foldPersonName(c.chatName)) ? c.chatName : null;
  return name ? `Teams, ${name}` : c.chatName ? "Teams group chat" : "Teams";
}

/** Loop-2 D-2: a quoted sentence shorter than this (folded) never makes two rows "the same ask": short generic
 *  sentences ("Can you take a look at this?", 28 characters -- the verifier's counter-example, so 25 was too low)
 *  are re-used for different things. 40 still covers a real re-posted ask (a full sentence with its specifics). */
export const DEDUP_MIN_QUOTE_CHARS = 40;

/** Pure: the chat id of a Teams item key ("teams:<chatId>|<message id>"), or null. */
export function teamsChatOfItemKey(itemKey: string): string | null {
  if (!itemKey.startsWith("teams:")) return null;
  const bar = itemKey.lastIndexOf("|");
  const chat = bar > 6 ? itemKey.slice(6, bar) : "";
  return chat || null;
}

/**
 * Pure: ONE row per Teams ask (loop-2 D-2, tightened). OPEN Teams items are the same ask ONLY when
 *  - they come from the SAME chat, or
 *  - the SAME sender id (senderIdOf; null = unknown, never matched) quoted the SAME sentence (folded) of at least
 *    DEDUP_MIN_QUOTE_CHARS characters (posted in a 1:1 and again in a small group chat, or re-posted later).
 * Only the NEWEST (by `at`) is kept. A shared backing proposal is NEVER a reason to collapse: the proposal store
 * attaches different senders' to-dos to one proposal by title (proposals-store.server.ts, OQ-9). A display NAME is
 * never a sender id. Nothing else is touched: emails, meetings, and Teams items that are not open keep their place.
 */
export function collapseDuplicateTeamsItems(cands: readonly ActionCandidate[], senderIdOf: (c: ActionCandidate) => string | null = () => null): ActionCandidate[] {
  const keysOf = (c: ActionCandidate): string[] => {
    const k: string[] = [];
    const chat = teamsChatOfItemKey(c.itemKey);
    if (chat) k.push(`c:${chat}`);
    const sid = senderIdOf(c);
    const q = c.display.quote ? canonQuote(c.display.quote) : "";
    if (sid && q.length >= DEDUP_MIN_QUOTE_CHARS) k.push(`q:${sid}\u0000${q}`);
    return k;
  };
  const t = (c: ActionCandidate) => (c.at ? Date.parse(c.at) : NaN);
  const winner = new Map<string, ActionCandidate>();
  for (const c of cands) {
    if (c.source !== "teams" || c.status !== "open") continue;
    for (const k of keysOf(c)) {
      const w = winner.get(k);
      if (!w || (t(c) || -Infinity) > (t(w) || -Infinity)) winner.set(k, c);
    }
  }
  return cands.filter((c) => c.source !== "teams" || c.status !== "open" || keysOf(c).every((k) => winner.get(k) === c));
}
