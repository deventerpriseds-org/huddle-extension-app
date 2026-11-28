// WHAT:       Pure helpers for Outlook email LABELS (the feed's `categories` field) and the feed's `status` field:
//             the email-only shape pre-step in front of calendar's normalizeCategories, the owner's
//             "Outlook labels that create a task" list cleaner, the whole-label matcher, and the label task title.
// WHY:        Owner request 2026-11-28 ("tasks from the file that have a category of 'needs action' should
//             automatically be processed to tasks"). Probe run 46110175163 measured 3 records labelled
//             ["Action Needed"] that the app dropped on ingest. Contract: docs/qc-evidence/AC-actions-label-autotask.md
//             sections 1, 3a, 5 (spelling table S-1..S-27).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-actions-label-autotask.md; scripts/actions-view.test.ts section LBL.
//
// THIS REPO IS PUBLIC: synthetic examples only. Nothing here logs.

import { normalizeCategories } from "../calendar/calendar-ignore";
import { stripReplyPrefixes } from "../external-feeds/onedrive-feed";

/** Seed of the owner's "Outlook labels that create a task" setting (AC-3.1). */
export const AUTO_TASK_LABELS_DEFAULT: readonly string[] = ["Action Needed"];
/** AC-3.3 bounds (safe default). */
export const AUTO_TASK_LABELS_MAX = 20;
export const AUTO_TASK_LABEL_MAX_LEN = 100;
/** AC-1.2: a stored `status` string is cut to this length. */
export const EMAIL_STATUS_MAX_LEN = 64;
/** AC-3.10: the title used when the subject is empty after stripping reply prefixes. */
export const LABEL_TASK_FALLBACK_TITLE = "Email: (no subject)";

/**
 * Pure (AC-1.3, S-6..S-8, S-18, S-21): the email-only pre-step. A bare string or a `;`-joined string becomes its
 * parts; an `outlookCategory`-like `{displayName}` object (alone or in an array) becomes its name. Everything is then
 * passed through calendar's normalizeCategories UNCHANGED (calendar behaviour is not touched). Returns null when the
 * record carried no `categories` key at all (absent = unknown), so the caller can keep the key absent.
 */
export function emailCategories(rec: Record<string, unknown>): string[] | null {
  if (!Object.prototype.hasOwnProperty.call(rec, "categories")) return null;
  const raw = rec.categories;
  const one = (v: unknown): unknown[] => {
    if (typeof v === "string") return v.split(";");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const n = (v as Record<string, unknown>).displayName;
      return typeof n === "string" ? [n] : [];
    }
    return [];
  };
  const pre: unknown[] = Array.isArray(raw)
    ? raw.flatMap((v) => (typeof v === "string" ? [v] : v && typeof v === "object" && !Array.isArray(v) ? one(v) : [v]))
    : one(raw);
  return normalizeCategories(pre);
}

/** Pure (AC-1.2): the feed's `status`, stored as sent (cut to 64 chars), never interpreted. Non-string or blank ->
 *  null (the caller leaves the key absent). */
export function emailStatus(rec: Record<string, unknown>): string | null {
  const v = rec.status;
  if (typeof v !== "string" || !v.trim()) return null;
  return v.slice(0, EMAIL_STATUS_MAX_LEN);
}

/** Pure (S-5, S-10): the comparison key of a label -- trimmed, every whitespace run (incl. no-break space) one
 *  space, case-folded. Zero-width characters are NOT folded (S-24). */
export function labelKey(s: string): string {
  return s.replace(/[\s ]+/g, " ").trim().toLowerCase();
}

/** Pure (AC-3.3, S-19): the owner's list -> trimmed non-blank strings, de-duplicated case-insensitively (first
 *  spelling kept), at most 20 entries of at most 100 chars. */
export function cleanAutoTaskLabels(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.replace(/[\s ]+/g, " ").trim().slice(0, AUTO_TASK_LABEL_MAX_LEN);
    const k = labelKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= AUTO_TASK_LABELS_MAX) break;
  }
  return out;
}

/**
 * Pure (section 5): the FIRST of the email's labels that equals (whole label, after labelKey) an entry of the
 * owner's list, or null. Only `categories` is read -- never the subject, body or status (S-15..S-17).
 */
export function matchedAutoTaskLabel(categories: unknown, labels: readonly string[]): string | null {
  if (!Array.isArray(categories) || !labels.length) return null;
  const want = new Set(labels.map((l) => labelKey(String(l))).filter(Boolean));
  if (!want.size) return null;
  for (const c of categories) {
    if (typeof c !== "string") continue;
    const k = labelKey(c);
    if (k && want.has(k)) return c.trim();
  }
  return null;
}

/**
 * Pure (AC-3.9, AC-3.10): the label task's title. The thread's current open verdict to-do wins when non-blank;
 * otherwise the subject with reply/forward prefixes stripped (the existing stripReplyPrefixes); otherwise a fixed
 * safe string. Never empty.
 */
export function labelTaskTitle(subject: string | null | undefined, verdictTodo?: string | null): string {
  const todo = typeof verdictTodo === "string" ? verdictTodo.trim() : "";
  if (todo) return todo;
  const s = stripReplyPrefixes(String(subject ?? "")).trim();
  return s || LABEL_TASK_FALLBACK_TITLE;
}

// ── Back-fill (AC-1.8 / AC-3.25): the categories refill plan, COUNTS only ───────────────────────────────────────

/** What the back-fill reads per stored email row (labels are read into memory to compare; only counts print). */
export interface StoredLabelFlags {
  sourceItemId: string;
  hasContent: boolean;
  purged: boolean;
  /** content->'categories' as stored (null = key absent). */
  categories: unknown;
  /** result_ids.autotask says done or gave up (the auto path never acts on it again). */
  autotaskSettled: boolean;
}

export interface CategoriesRefillPlan {
  /** Email items read from the file versions that carry a `categories` list (newest copy per id). */
  read: number;
  /** ... of which match the owner's auto-task labels. */
  labelled: number;
  /** Stored email rows matched to a read item. */
  stored: number;
  /** ... whose stored content has no `categories` key. */
  storedMissing: number;
  /** ... whose stored labels differ from the file's and are re-written (content only, no re-judge). */
  wouldGain: number;
  purged: number;
  /** AC-3.25: stored rows that, after the refill, carry a matching label and are not settled: the MOST board tasks the
   *  next pass can create (each is still screened: decided / already on the board create nothing). */
  wouldAutoTask: number;
}

/** Pure: the categories refill plan. `items` oldest version first (the newest copy wins); source 'email' only. */
export function planCategoriesRefill(items: readonly { source: string; sourceItemId: string; content?: unknown }[], stored: readonly StoredLabelFlags[], labels: readonly string[]): CategoriesRefillPlan {
  const fileCats = new Map<string, string[]>();
  for (const it of items) {
    if (it.source !== "email") continue;
    const c = it.content as { kind?: unknown; categories?: unknown } | undefined;
    if (!c || c.kind !== "email" || !Array.isArray(c.categories)) continue;
    fileCats.set(it.sourceItemId, c.categories as string[]);
  }
  const plan: CategoriesRefillPlan = { read: fileCats.size, labelled: 0, stored: 0, storedMissing: 0, wouldGain: 0, purged: 0, wouldAutoTask: 0 };
  for (const cats of fileCats.values()) if (matchedAutoTaskLabel(cats, labels)) plan.labelled++;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const s of stored) {
    if (s.purged) {
      if (fileCats.has(s.sourceItemId)) {
        plan.stored++;
        plan.purged++;
      }
      continue;
    }
    if (!s.hasContent) continue;
    const f = fileCats.get(s.sourceItemId);
    let effective: unknown = s.categories;
    if (f) {
      plan.stored++;
      if (s.categories === null || s.categories === undefined) plan.storedMissing++;
      if (!same(s.categories, f)) {
        plan.wouldGain++;
        effective = f;
      }
    }
    if (!s.autotaskSettled && matchedAutoTaskLabel(effective, labels)) plan.wouldAutoTask++;
  }
  return plan;
}
