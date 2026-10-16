// WHAT:       The pure half of "focus on these": split what the owner typed or said into items, and
//             match each item to one of his OPEN tasks by its title. No I/O — focus.server.ts does the
//             reads/writes; this file is what the tests exercise.
// WHY:        Owner, 2026-10-16: "i should be able to reply to the priority message question with a list
//             of items i want to work on and if they exist, it should start them, but if they dont, it
//             should create the tasks first then start them. this needs to be a streamlined ability if i
//             ask iris or if i type in the text input section of the priorities tab." Matching must be
//             conservative: a wrong match STARTS the wrong task, a missed match only creates a duplicate.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/focus.test.ts

/** One row of the owner's board, as much of it as matching needs. */
export interface FocusCandidate {
  id: string;
  title: string;
  status: string | null;
  tags?: readonly unknown[] | null;
}

export type MatchedBy = "id" | "exact" | "contains" | "words" | "model";

export interface FocusMatch {
  item: string;
  taskId: string | null;
  title: string | null;
  by: MatchedBy | null;
}

const BULLET = /^\s*(?:[-*•]+|\d+[.)]|\(\d+\))\s*/;

/**
 * Split a typed or spoken list into items. Newlines, semicolons, bullets/numbering and commas separate
 * items; a lone leading "and"/"then" on an item is dropped. Commas DO split here (unlike
 * `splitTaskEntries`, which feeds journey's own parser), because a list typed into one line is how the
 * owner writes "the deck, interview prep, gym". Empty and duplicate items are dropped, order kept.
 */
export function splitFocusText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n|;|,/)) {
    const item = raw
      .replace(BULLET, "")
      .replace(/^\s*(?:and|then|also)\s+/i, "")
      .replace(/[.!]+\s*$/, "")
      .trim();
    if (!item) continue;
    const key = normalizeTitle(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "a", "an", "the", "my", "to", "for", "of", "on", "in", "and", "with", "at", "by", "up", "do", "get",
  "work", "start", "finish", "it", "this", "that", "some", "i", "me",
]);

function words(t: string): Set<string> {
  return new Set(normalizeTitle(t).split(" ").filter((w) => w.length > 1 && !STOP.has(w)));
}

/** Closed statuses never match: "start the deck" must not reopen a finished deck. */
export function isFocusCandidate(row: FocusCandidate): boolean {
  const s = (row.status ?? "").trim().toUpperCase();
  return s !== "DONE" && s !== "ARCHIVED" && s !== "CANCELLED";
}

/** The share of the item's meaningful words found in the title. 1 = every word of the item is there. */
function coverage(item: string, title: string): number {
  const iw = words(item);
  if (iw.size === 0) return 0;
  const tw = words(title);
  let hit = 0;
  for (const w of iw) if (tw.has(w)) hit++;
  return hit / iw.size;
}

/**
 * Match one item to an open task, deterministically. In order: exact normalized title; the item's
 * words appearing as a phrase in exactly one title (or vice versa); every meaningful word of the item
 * present in exactly one title. ANY TIE IS NO MATCH — guessing between two candidates would start the
 * wrong one, and the model step (or a create) handles what this cannot settle.
 */
export function matchOne(item: string, rows: readonly FocusCandidate[]): FocusMatch {
  const none: FocusMatch = { item, taskId: null, title: null, by: null };
  const open = rows.filter(isFocusCandidate);
  const key = normalizeTitle(item);
  if (!key) return none;

  const exact = open.filter((r) => normalizeTitle(r.title) === key);
  if (exact.length === 1) return { item, taskId: exact[0].id, title: exact[0].title, by: "exact" };
  if (exact.length > 1) return none;

  if (key.length >= 4) {
    const contains = open.filter((r) => {
      const t = normalizeTitle(r.title);
      return (` ${t} `).includes(` ${key} `) || (t.length >= 4 && (` ${key} `).includes(` ${t} `));
    });
    if (contains.length === 1) return { item, taskId: contains[0].id, title: contains[0].title, by: "contains" };
    if (contains.length > 1) return none;
  }

  if (words(item).size >= 2) {
    const full = open.filter((r) => coverage(item, r.title) === 1);
    if (full.length === 1) return { item, taskId: full[0].id, title: full[0].title, by: "words" };
  }
  return none;
}

export function matchAll(items: readonly string[], rows: readonly FocusCandidate[]): FocusMatch[] {
  const used = new Set<string>();
  return items.map((item) => {
    const m = matchOne(item, rows.filter((r) => !used.has(r.id)));
    if (m.taskId) used.add(m.taskId);
    return m;
  });
}

/** One finished item, as both surfaces report it. */
export interface FocusItemResult {
  item: string;
  taskId: string | null;
  title: string;
  created: boolean;
  started: boolean;
  starred: boolean;
  matchedBy: MatchedBy | null;
  error?: string;
}

/** The one-line summary both the toast and Iris's tool result use. */
export function summarizeFocus(results: readonly FocusItemResult[]): string {
  const started = results.filter((r) => r.started);
  const created = started.filter((r) => r.created);
  const failed = results.filter((r) => !r.started);
  const parts: string[] = [];
  if (started.length) {
    parts.push(
      `Started ${started.length}: ${started.map((r) => `"${r.title}"`).join(", ")}` +
        (created.length ? ` (${created.length} new)` : ""),
    );
  }
  if (failed.length) {
    parts.push(`Couldn't start ${failed.map((r) => `"${r.title}"${r.error ? ` (${r.error})` : ""}`).join(", ")}`);
  }
  return parts.join(". ") || "Nothing to start.";
}
