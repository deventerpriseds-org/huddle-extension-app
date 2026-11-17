// WHAT:          Pure core of the Actions view: the per-owner "What shows" settings (defaults + resolution), the window
//                start ("since Monday"), the owner's Wrong? correction rule, and THE selection that turns stored
//                candidates into the rows, counts and "N hidden" the page shows. No I/O.
// WHY:           Owner-approved design 2026-11-16 (actions-proto): one page listing, since Monday, the email / Teams /
//                meeting items that need the owner and are not resolved. AC docs/qc-evidence/AC-actions-view-modules.md
//                sections B, D, E (Tier 1: what is listed; counts reconcile; a correction hides only its own version).
// SUPERSEDES:    nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/actions-view.test.ts; docs/qc-evidence/BUILD-actions-view.md.
//
// THIS REPO IS PUBLIC: no names, ids, addresses or content here. Nothing in this module logs.

import type { ActionCategory, ActionKind, ActionSection } from "../correspondence/action-classify";
import { ACTION_SECTION_ORDER } from "../correspondence/action-classify";

// ── SETTINGS ("What shows") ─────────────────────────────────────────────────────────────────────────

/** The three noise categories the owner hides by default (owner 2026-11-15). Exact SCHEMA enum values. */
export const HIDEABLE_CATEGORIES = ["meeting_invite", "timekeeping", "verification_code"] as const satisfies readonly ActionCategory[];
export type HideableCategory = (typeof HIDEABLE_CATEGORIES)[number];
export const HIDEABLE_CATEGORY_LABEL: Record<HideableCategory, string> = {
  meeting_invite: "Meeting invites and calendar replies",
  timekeeping: "Timekeeping and timesheet reminders",
  verification_code: "Verification and sign-in codes",
};

export type ActionSource = "email" | "teams" | "meeting";
export const ACTION_SOURCES: readonly ActionSource[] = ["email", "teams", "meeting"];

export interface ActionsSettings {
  hideCategories: HideableCategory[];
  /** UNINVOLVED_CHAT_RULE switch: hide Teams group / meeting / channel chats the owner never wrote in and was never
   *  @mentioned in. Default ON (owner 2026-11-16). */
  hideUninvolvedChats: boolean;
  sources: Record<ActionSource, boolean>;
  /** "Stop flagging this list": latest-OTHER sender addresses (lower-cased) of CC / list email to hide. */
  hiddenSenders: string[];
  /** Run the classifier on the heartbeat. null = default (ON for the configured owner only). */
  classify: boolean | null;
  /** Most model calls per owner per day. */
  dailyCap: number;
  /** The owner's zone for "since Monday" and the daily cap's day. */
  timeZone: string;
}

/** Owner decision 2026-11-17: 150 -> 500 (150 ran out mid-day). The owner changes it in DAILY_CAP_SETTING_PATH. */
export const DAILY_CAP_DEFAULT = 500;
export const DAILY_CAP_MAX = 2000;
/** Where the owner changes the daily limit: the Actions page's "What shows" panel, "Sorting" heading, "Daily limit"
 *  field (WhatShows in ActionsView.tsx). Named in the cap notice, so it must match those labels. */
export const DAILY_CAP_SETTING_PATH = "What shows → Sorting → Daily limit";

/**
 * Pure (owner 2026-11-17): the notice shown at the top of the Actions page when today's AI checks are used up, or
 * null. `usedToday` is the SAME count the heartbeat caps on (actionCallsToday: every recorded attempt since the
 * owner's local midnight, loop-2 D2), and the condition is the one that makes classifyCallsLeft return 0, so the
 * page says "limit reached" exactly when the heartbeat stops calling the model. No notice when sorting is off (the
 * cap is not the reason) or the count could not be read.
 */
export function capNotice(usedToday: number | null | undefined, dailyCap: number, classifyOn: boolean): string | null {
  if (!classifyOn || typeof usedToday !== "number" || !Number.isFinite(usedToday)) return null;
  if (usedToday < dailyCap) return null;
  return `Daily AI check limit reached (${usedToday} of ${dailyCap} used today). Remaining items wait until tomorrow. To change the limit, open ${DAILY_CAP_SETTING_PATH} on this page.`;
}

export const ACTIONS_SETTINGS_DEFAULT: ActionsSettings = {
  hideCategories: [...HIDEABLE_CATEGORIES],
  hideUninvolvedChats: true,
  sources: { email: true, teams: true, meeting: true },
  hiddenSenders: [],
  classify: null,
  dailyCap: DAILY_CAP_DEFAULT,
  timeZone: "America/New_York",
};

const isZone = (z: unknown): z is string => {
  if (typeof z !== "string" || !z || z.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

/** Pure: stored JSON (anything) -> complete settings. Unknown / bad fields fall back to the default, field by field. */
export function resolveActionsSettings(raw: unknown): ActionsSettings {
  const d = ACTIONS_SETTINGS_DEFAULT;
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const cats = Array.isArray(o.hideCategories) ? o.hideCategories.filter((c): c is HideableCategory => (HIDEABLE_CATEGORIES as readonly string[]).includes(c as string)) : d.hideCategories;
  const src = o.sources && typeof o.sources === "object" ? (o.sources as Record<string, unknown>) : {};
  const senders = Array.isArray(o.hiddenSenders) ? o.hiddenSenders.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim().toLowerCase().slice(0, 254)).slice(0, 200) : [];
  const cap = typeof o.dailyCap === "number" && Number.isFinite(o.dailyCap) ? Math.max(0, Math.min(DAILY_CAP_MAX, Math.floor(o.dailyCap))) : d.dailyCap;
  return {
    hideCategories: [...new Set(cats)],
    hideUninvolvedChats: typeof o.hideUninvolvedChats === "boolean" ? o.hideUninvolvedChats : d.hideUninvolvedChats,
    sources: {
      email: typeof src.email === "boolean" ? src.email : true,
      teams: typeof src.teams === "boolean" ? src.teams : true,
      meeting: typeof src.meeting === "boolean" ? src.meeting : true,
    },
    hiddenSenders: [...new Set(senders)],
    classify: typeof o.classify === "boolean" ? o.classify : null,
    dailyCap: cap,
    timeZone: isZone(o.timeZone) ? o.timeZone : d.timeZone,
  };
}

/** Pure: does the classifier run for this owner? An explicit setting wins; otherwise ON only for the configured
 *  owner (owner 2026-11-16: "defaults ON for the owner only"). */
export function classifyEnabled(s: ActionsSettings, isConfiguredOwner: boolean): boolean {
  return s.classify ?? isConfiguredOwner;
}

// ── TIME ─────────────────────────────────────────────────────────────────────────────────────────────

/** Pure: wall-clock parts of `ms` in `tz`. */
function partsIn(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { y: Number(g("year")), mo: Number(g("month")), d: Number(g("day")), h: Number(g("hour")), mi: Number(g("minute")), s: Number(g("second")), wd: g("weekday") };
}

/** Pure: the UTC instant of local midnight (00:00) of the day `ms` falls on in `tz` (DST-safe: the offset is read
 *  at that midnight, not at `ms`). */
export function localMidnightMs(ms: number, tz: string): number {
  const a = partsIn(ms, tz);
  const guess = Date.UTC(a.y, a.mo - 1, a.d, 0, 0, 0);
  // offset at the guess: local(guess) - guess
  const b = partsIn(guess, tz);
  const off = Date.UTC(b.y, b.mo - 1, b.d, b.h, b.mi, b.s) - guess;
  const first = guess - off;
  // One correction round when the offset differs across the boundary.
  const c = partsIn(first, tz);
  const off2 = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s) - first;
  return guess - off2;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Pure (AC-E-9): the most recent Monday 00:00 in `tz` at or before `nowMs` (on a Monday, that day's 00:00). */
export function sinceMondayMs(nowMs: number, tz: string): number {
  const wd = WEEKDAY[partsIn(nowMs, tz).wd] ?? 1;
  const back = (wd + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  // Step back by whole days from local noon, so a DST change never lands on the wrong calendar day.
  const noon = localMidnightMs(nowMs, tz) + 12 * 3600_000;
  return localMidnightMs(noon - back * 86_400_000, tz);
}

// ── CORRECTIONS (Wrong?) ─────────────────────────────────────────────────────────────────────────────

export const CORRECTION_REASONS = ["not_mine", "already_handled", "not_an_action", "wrong_section", "stop_list"] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];
export const CORRECTION_LABEL: Record<CorrectionReason, string> = {
  not_mine: "Not mine to do",
  already_handled: "Already handled",
  not_an_action: "Not an action",
  wrong_section: "Wrong section",
  stop_list: "Stop flagging this list",
};
export const CORRECTION_TEXT_MAX = 500;

/** Stored on chat.task_proposals.owner_correction (and the latest message's ledger row, for the classifier's record).
 *  `history` keeps every earlier correction; Undo sets `withdrawnAt` and keeps the record. */
export interface OwnerCorrection {
  reason: CorrectionReason;
  text: string | null;
  /** The classification key the owner corrected: a newer message (new key) is judged again. */
  itemKey: string;
  at: string;
  withdrawnAt?: string | null;
  history?: Omit<OwnerCorrection, "history">[];
}

/** Pure (Tier 1, AC-E-14 / AC-C-18 / AC-C-19): does this correction hide the item as it is NOW? Only when it is not
 *  withdrawn AND it was made on the same version of the item (same classification key). */
export function correctionHides(c: OwnerCorrection | null | undefined, currentItemKey: string): boolean {
  return !!c && !c.withdrawnAt && c.itemKey === currentItemKey;
}

/**
 * What chat.task_proposals.owner_correction holds (loop-2 D4, 2026-11-17): ONE correction PER ITEM VERSION, keyed by
 * the classification key (thread key + latest message id; meeting id + item). One proposal can back two threads
 * (the store attaches a second source with the same to-do), and the column used to hold ONE correction, so Wrong?
 * on thread B overwrote thread A's and brought A back. Now each item version keeps its own entry; Wrong? / Undo on B
 * never touch A. The pre-D4 single-object shape is read as a map of its one item (no migration needed).
 */
export interface OwnerCorrections {
  v: 2;
  items: Record<string, OwnerCorrection>;
}
/** Bound on entries kept per proposal (oldest dropped first). One proposal backing this many thread versions does
 *  not happen in practice; the bound only keeps a pathological row small. */
export const CORRECTION_ITEMS_MAX = 200;

const isCorrection = (x: unknown): x is OwnerCorrection =>
  !!x && typeof x === "object" && typeof (x as OwnerCorrection).itemKey === "string" && typeof (x as OwnerCorrection).reason === "string";

/** Pure: the stored column (either shape, or anything malformed) -> a Map of item key -> correction. */
export function correctionsOf(stored: unknown): Map<string, OwnerCorrection> {
  const m = new Map<string, OwnerCorrection>();
  if (!stored || typeof stored !== "object") return m;
  const s = stored as { v?: unknown; items?: unknown };
  if (s.v === 2 && s.items && typeof s.items === "object") {
    for (const [k, c] of Object.entries(s.items as Record<string, unknown>)) if (isCorrection(c) && c.itemKey === k) m.set(k, c);
    return m;
  }
  if (isCorrection(stored)) m.set(stored.itemKey, stored); // the pre-D4 single-correction shape
  return m;
}

/** Pure: the correction of THIS item version only (never another thread's that shares the proposal). */
export function correctionFor(stored: unknown, itemKey: string): OwnerCorrection | null {
  return correctionsOf(stored).get(itemKey) ?? null;
}

const toStored = (m: Map<string, OwnerCorrection>): OwnerCorrections => {
  const entries = [...m.entries()].sort((a, b) => String(a[1].at).localeCompare(String(b[1].at))).slice(-CORRECTION_ITEMS_MAX);
  return { v: 2, items: Object.fromEntries(entries) };
};

/** Pure: Wrong? on ONE item version. Every other item's entry is carried over untouched. */
export function withItemCorrection(
  stored: unknown,
  input: { reason: unknown; text?: unknown; itemKey: unknown },
  nowIso: string,
): { ok: true; stored: OwnerCorrections; correction: OwnerCorrection } | { ok: false; error: string } {
  const m = correctionsOf(stored);
  const made = makeCorrection(input, typeof input.itemKey === "string" ? m.get(input.itemKey) ?? null : null, nowIso);
  if (!made.ok) return made;
  m.set(made.correction.itemKey, made.correction);
  return { ok: true, stored: toStored(m), correction: made.correction };
}

/** Pure: Undo on ONE item version (marks it withdrawn, keeps the record). No entry / already withdrawn -> unchanged. */
export function withItemUndo(stored: unknown, itemKey: string, nowIso: string): { changed: boolean; stored: OwnerCorrections; correction: OwnerCorrection | null } {
  const m = correctionsOf(stored);
  const prev = m.get(itemKey) ?? null;
  if (!prev || prev.withdrawnAt) return { changed: false, stored: toStored(m), correction: prev };
  const next = { ...prev, withdrawnAt: nowIso };
  m.set(itemKey, next);
  return { changed: true, stored: toStored(m), correction: next };
}

/** Pure: a validated correction from client input, or an error. Text is data: trimmed, bounded, never interpreted. */
export function makeCorrection(
  input: { reason: unknown; text?: unknown; itemKey: unknown },
  prev: OwnerCorrection | null,
  nowIso: string,
): { ok: true; correction: OwnerCorrection } | { ok: false; error: string } {
  if (!(CORRECTION_REASONS as readonly string[]).includes(input.reason as string)) return { ok: false, error: "Pick a reason." };
  if (typeof input.itemKey !== "string" || !input.itemKey || input.itemKey.length > 600) return { ok: false, error: "That item isn't in your list." };
  const text = typeof input.text === "string" && input.text.trim() ? input.text.trim().slice(0, CORRECTION_TEXT_MAX) : null;
  const history = [...(prev?.history ?? []), ...(prev ? [{ reason: prev.reason, text: prev.text, itemKey: prev.itemKey, at: prev.at, withdrawnAt: prev.withdrawnAt ?? null }] : [])].slice(-20);
  return { ok: true, correction: { reason: input.reason as CorrectionReason, text, itemKey: input.itemKey, at: nowIso, withdrawnAt: null, ...(history.length ? { history } : {}) } };
}

// ── SELECTION ───────────────────────────────────────────────────────────────────────────────────────

/** One thread / meeting item as the server assembled it (verdict + backing proposal + display facts). */
export interface ActionCandidate {
  /** The backing chat.task_proposals id; null when none could be stored. */
  proposalId: string | null;
  proposalState: string | null;
  source: ActionSource;
  /** open = admitted; none = not open; not_checked = no admitted verdict (unclassified, refused, over cap). */
  status: "open" | "none" | "not_checked";
  answeredByReply: boolean;
  /** Admitted but the to-do is already open on the board. */
  onBoard: boolean;
  section: ActionSection | null;
  category: ActionCategory | null;
  kind: ActionKind | null;
  itemKey: string;
  /** The correction of THIS item version (correctionFor), never another thread's sharing the proposal. */
  correction: OwnerCorrection | null;
  /** Lower-cased latest-OTHER sender address of a CC / list email (Stop flagging this list); null otherwise. */
  listSender: string | null;
  /** UNINVOLVED_CHAT_RULE hid this chat (only present when the rule said hide). */
  uninvolved: boolean;
  at: string | null;
  /** Display payload, passed through untouched. */
  display: ActionDisplay;
}

export interface ActionDisplay {
  title: string;
  who: string;
  sourceLabel: string;
  reasonLine: string | null;
  quote: string | null;
  due: string | null;
  /** Email: the chat.email_replies row behind Draft reply, when there is one. */
  reply: { emailReplyId: string; draftable: boolean; proposedReply: string | null; status: string; webLink: string | null } | null;
  /** Email: what Draft reply asks Iris when there is no reply row. */
  replyAsk: { who: string; subject: string | null } | null;
  /** Teams: the https-only link (safeLink), else null. */
  teamsLink: string | null;
  /** Meeting rows: the meeting title. */
  meetingTitle: string | null;
  assignee: string | null;
}

export interface ActionRow extends ActionDisplay {
  id: string;
  source: ActionSource;
  section: ActionSection;
  state: string;
  itemKey: string;
  category: ActionCategory | null;
  kind: ActionKind | null;
  at: string | null;
  fromList: boolean;
  listSender: string | null;
}

export interface ActionsSelection {
  rows: ActionRow[];
  answered: ActionRow[];
  corrected: ActionRow[];
  counts: { all: number; email: number; teams: number; meeting: number };
  sectionCounts: Record<ActionSection, number>;
  hidden: { total: number; categories: Partial<Record<HideableCategory, number>>; uninvolved: number; sources: number; senders: number };
  notChecked: number;
}

const LISTED_STATES = new Set(["proposed", "untriaged"]);
const ms = (iso: string | null) => {
  const v = Date.parse(String(iso ?? ""));
  return Number.isFinite(v) ? v : 0;
};

/**
 * Pure, THE SELECTION (Tier 1). In this order, each candidate is:
 *   not_checked (or open with no backing row)            -> counted notChecked, never listed;
 *   none + answered by the owner's reply                 -> the "Answered by your reply" group (never counted);
 *   none                                                 -> dropped;
 *   on the board already / backing proposal decided     -> resolved, dropped;
 *   corrected (Wrong?) on this same version              -> the Corrected list (Undo), never counted;
 *   hidden by a What-shows switch                         -> counted in hidden, never listed;
 *   otherwise                                            -> a row.
 * Counts are computed FROM the rows, so Email + Teams + Meetings = All = the sum of the sections (AC-D-2).
 */
export function selectActionItems(cands: readonly ActionCandidate[], s: ActionsSettings): ActionsSelection {
  const out: ActionsSelection = {
    rows: [],
    answered: [],
    corrected: [],
    counts: { all: 0, email: 0, teams: 0, meeting: 0 },
    sectionCounts: { needs_reply: 0, todo: 0, fyi: 0, meetings: 0 },
    hidden: { total: 0, categories: {}, uninvolved: 0, sources: 0, senders: 0 },
    notChecked: 0,
  };
  const hiddenCats = new Set<string>(s.hideCategories);
  const hiddenSenders = new Set(s.hiddenSenders);
  const toRow = (c: ActionCandidate, section: ActionSection): ActionRow => ({
    ...c.display,
    id: c.proposalId ?? "",
    source: c.source,
    section,
    state: c.proposalState ?? "proposed",
    itemKey: c.itemKey,
    category: c.category,
    kind: c.kind,
    at: c.at,
    fromList: !!c.listSender,
    listSender: c.listSender,
  });
  for (const c of cands) {
    if (c.status === "not_checked") {
      out.notChecked++;
      continue;
    }
    if (c.status === "none") {
      if (c.answeredByReply && c.source === "email" && c.section) out.answered.push(toRow(c, c.section));
      else if (c.answeredByReply) out.answered.push(toRow(c, "needs_reply"));
      continue;
    }
    if (c.onBoard) continue;
    if (!c.proposalId || !c.section) {
      out.notChecked++;
      continue;
    }
    if (!LISTED_STATES.has(c.proposalState ?? "")) continue;
    if (correctionHides(c.correction, c.itemKey)) {
      out.corrected.push(toRow(c, c.section));
      continue;
    }
    if (c.uninvolved && s.hideUninvolvedChats) {
      out.hidden.uninvolved++;
      out.hidden.total++;
      continue;
    }
    if (!s.sources[c.source]) {
      out.hidden.sources++;
      out.hidden.total++;
      continue;
    }
    if (c.category && hiddenCats.has(c.category)) {
      const k = c.category as HideableCategory;
      out.hidden.categories[k] = (out.hidden.categories[k] ?? 0) + 1;
      out.hidden.total++;
      continue;
    }
    if (c.listSender && hiddenSenders.has(c.listSender)) {
      out.hidden.senders++;
      out.hidden.total++;
      continue;
    }
    out.rows.push(toRow(c, c.section));
  }
  const order = new Map(ACTION_SECTION_ORDER.map((x, i) => [x, i]));
  out.rows.sort((a, b) => (order.get(a.section) ?? 9) - (order.get(b.section) ?? 9) || ms(b.at) - ms(a.at));
  out.answered.sort((a, b) => ms(b.at) - ms(a.at));
  for (const r of out.rows) {
    out.counts.all++;
    out.counts[r.source]++;
    out.sectionCounts[r.section]++;
  }
  return out;
}

/** Pure: the counts of the rows a source filter leaves visible (AC-D-1..D-3). */
export function filterRows(rows: readonly ActionRow[], filter: "all" | ActionSource): ActionRow[] {
  return filter === "all" ? [...rows] : rows.filter((r) => r.source === filter);
}

/** Pure (AC-I-8, X-6): the bell (chat.email_replies) rows an Actions Done / Dismiss settles, from the backing
 *  proposal's source refs. Email: the message's feed id; Teams: the chat id. Meetings have no bell row. */
export function bellTargetsFor(refs: readonly { source: string; sourceItemId: string }[]): { emailGraphIds: string[]; chatIds: string[] } {
  const emailGraphIds = new Set<string>();
  const chatIds = new Set<string>();
  for (const r of refs) {
    if (r.source === "email" && r.sourceItemId && !r.sourceItemId.includes(":conv:") && !r.sourceItemId.includes(":msg:")) emailGraphIds.add(`feed:${r.sourceItemId}`);
    if (r.source === "teams" && r.sourceItemId) {
      const chat = chatIdOfTeamsItem(r.sourceItemId);
      if (chat) chatIds.add(chat);
    }
  }
  return { emailGraphIds: [...emailGraphIds], chatIds: [...chatIds] };
}

/** Pure: a Teams ledger source_item_id is `encodeURIComponent(chatId) + ":" + encodeURIComponent(messageId)`
 *  (source-item.ts teamsSourceItemId), so the ONE raw colon separates them; the chat id is decoded back. */
export function chatIdOfTeamsItem(sourceItemId: string): string | null {
  const i = sourceItemId.indexOf(":");
  if (i <= 0) return null;
  try {
    return decodeURIComponent(sourceItemId.slice(0, i));
  } catch {
    return null;
  }
}
