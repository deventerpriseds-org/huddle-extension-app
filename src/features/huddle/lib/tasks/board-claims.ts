// WHAT:       The PURE facts about what an agent actually DID to the board / the work this turn, read off the
//             turn's recorded toolUses (the same records the chat breadcrumbs show). Used by the 1:1 hand-off
//             decision (F1: "the addressed agent already handled it") and by the turn honesty presenter (F6:
//             "never claim a board action that was not performed").
// WHY:        A toolUse with ok=true is NOT proof a write happened (AC-handoff-confirm-flow.md CF-8): a status
//             change deferred to the assignee, a dedup-skipped create, a blocked meta-task and a Huddle-only
//             suggestion are all recorded ok=true. Every consumer must read "performed" from ONE predicate.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-handoff-lane-a.md; scripts/handoff-lane-a.test.ts.
//
// No server imports: huddle.functions.ts calls this inside the synchronous reply assembly, and the offline
// tests import it with bun.

/** The structural board facts a journey board tool call carries (task, status, tags), recorded beside the
 *  toolUse by the dispatcher. Optional: older records and non-board tools have none. */
export type BoardFact = {
  taskId?: string;
  title?: string;
  status?: string;
  tags?: string[];
};

/** The minimal toolUse shape these predicates read (ToolUseEvent satisfies it). */
export type ToolUseLike = {
  agentId: string;
  tool: string;
  summary: string;
  ok: boolean;
  detail?: string;
  board?: BoardFact;
};

/** journey catalog tools that CREATE tasks (mirrors create-task-core RAW_JOURNEY_CREATE_TOOLS). */
const RAW_CREATE_TOOLS = new Set(["quick_create_task", "parse_and_create_tasks", "create_task"]);
/** journey catalog tools that CHANGE an existing task. */
const STATUS_TOOLS = new Set(["update_task", "batch_update_tasks"]);
const DELETE_TOOLS = new Set(["delete_task"]);

/** Summaries the dispatcher writes for a call that did NOT perform a write, although it records ok=true. */
const NOT_PERFORMED_RE =
  /^(?:deferred\b|blocked\b|offered\b|suggested\b|no new tasks created\b)|skipped duplicate|Huddle-only|journey disabled/i;

export function isDeferredStatusChange(u: ToolUseLike): boolean {
  return u.ok && /^deferred\b/i.test(u.summary) && STATUS_TOOLS.has(u.tool);
}

export function isSkippedDuplicateCreate(u: ToolUseLike): boolean {
  return u.ok && /skipped duplicate/i.test(u.summary) && (RAW_CREATE_TOOLS.has(u.tool) || /^create_huddle_tasks?$/.test(u.tool));
}

export function isSuggestionOnlyCreate(u: ToolUseLike): boolean {
  return u.ok && /^create_huddle_tasks?$/.test(u.tool) && (/^suggested\b/i.test(u.summary) || /Huddle-only/.test(u.summary));
}

/** A create that really wrote a row on the canonical board this turn. */
export function isPerformedCreate(u: ToolUseLike): boolean {
  if (!u.ok || NOT_PERFORMED_RE.test(u.summary)) return false;
  if (u.tool === "create_huddle_task") return u.summary.includes("→ Huddle board + journey");
  if (u.tool === "create_huddle_tasks") return /^created [1-9]\d*\/\d+ → Huddle board \+ journey/.test(u.summary);
  if (RAW_CREATE_TOOLS.has(u.tool)) return /journey-voice · ok/.test(u.summary);
  return false;
}

/** A status/tag change (or delete) that really wrote this turn. */
export function isPerformedTaskChange(u: ToolUseLike): boolean {
  if (!u.ok || NOT_PERFORMED_RE.test(u.summary)) return false;
  if (STATUS_TOOLS.has(u.tool) || DELETE_TOOLS.has(u.tool)) return /journey-voice · ok/.test(u.summary);
  return false;
}

/** Real WORK for the ask, done this turn: a specialist dispatched, a document saved, or a task row created.
 *  (A deduped delegation still counts: the delegation it duplicates happened earlier this same turn.) */
export function isPerformedWork(u: ToolUseLike): boolean {
  if (!u.ok) return false;
  if (u.tool === "delegate_to_specialist") return !/delegation failed/i.test(u.summary);
  if (u.tool === "create_artifact") return typeof u.detail === "string" && u.detail.startsWith("/artifacts/");
  return isPerformedCreate(u);
}

/** Did `agentId` do real work for the ask in this turn (F1: then nobody else is handed it)? */
export function agentPerformedWork(toolUses: readonly ToolUseLike[], agentId: string): boolean {
  return toolUses.some((u) => u.agentId === agentId && isPerformedWork(u));
}

// ─── F6: board-claim honesty (AC-handoff-confirm-flow.md F6, spelling rows S-B1..S-B15) ────────────────
// A reply may not claim a COMPLETED board action ("I marked X done", "I've moved it to review", "added X to
// your board", "archived X") unless a PERFORMED write in this turn backs it. Run by the same turn-level
// presenter that already carries Nexus write honesty (huddle.functions.ts presentedReplies ->
// presentNexusWriteTurn, then this), so every exit point -- stream, chunk save, final result, the prior
// shown to later agents, memory -- gets it. Pure and idempotent: a corrected line is code-built and
// contains no claim, so applying the presenter twice gives the same text.

/** The board fact a journey board call carries, built at the dispatcher from its args + journey's echo. */
export function boardFactFrom(
  toolName: string,
  args: unknown,
  tasks?: ReadonlyArray<{ id?: string; title?: string; status?: string; tags?: string[] | null }>,
): BoardFact | undefined {
  if (!STATUS_TOOLS.has(toolName) && !DELETE_TOOLS.has(toolName) && !RAW_CREATE_TOOLS.has(toolName)) return undefined;
  const a = (args ?? {}) as Record<string, unknown>;
  const taskId = String(a.task_id ?? a.taskId ?? a.id ?? "").trim() || undefined;
  const echo = (tasks ?? []).find((t) => taskId && t.id === taskId) ?? (tasks ?? [])[0];
  const status = (typeof a.status === "string" && a.status) || echo?.status || undefined;
  const title = echo?.title || (typeof a.title === "string" ? a.title : undefined);
  const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : undefined;
  return { taskId: taskId ?? echo?.id, title, status, tags };
}

type ClaimKind = "done" | "status" | "added" | "archived" | "deleted" | "started";

const normClaimTitle = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();

/** Strip quoted user text ("…", “…”) so a quoted "mark it done" is never read as a claim (S-B13). */
const stripDoubleQuoted = (s: string) => s.replace(/"[^"]*"|“[^”]*”/g, " ");

const CLAIM_PATTERNS: Array<[ClaimKind, RegExp]> = [
  ["done", /\b(marked|checked off|ticked off)\b[^.!?]{0,80}?\b(?:done|complete|completed|finished)\b/],
  [
    "status",
    /\b(moved|set|put|bumped|pushed|dragged|shifted|switched)\b[^.!?]{0,80}?\b(?:to|into|in)\s+(?:the\s+)?['‘]?(?:in review|review|done|doing|in progress|backlog|up next|blocked|ready)\b/,
  ],
  ["added", /\b(added|put|logged|filed)\b[^.!?]{0,80}?\b(?:to|on|onto|in)\s+(?:your|the)\s+(?:journey\s+)?(?:board|backlog|task list|to-?do list)\b/],
  ["added", /\b(created|added|filed)\s+(?:a|an|the|that|this|your)?\s*(?:new\s+)?(?:task|card)\b/],
  ["archived", /\b(archived|parked)\b/],
  ["deleted", /\b(deleted|removed)\b[^.!?]{0,80}?\b(?:task|card|from (?:your|the) board)\b/],
  ["started", /\b(i'm now|i am now|i'm|i am)\s+(?:proceeding with|starting on|working on it now)\b|\b(i've|i have)\s+(?:already\s+)?started\b/],
];

/** Who did it: "I" / "I've" / "we've" right before the verb, or a subjectless start ("Marked as done ✅"). */
function claimSubjectOk(prefix: string): boolean {
  if (/(?:^|[^a-z'])(?:i|i've|i have|we|we've|we have)\s+(?:(?:just|already|also|now|went ahead and|gone ahead and)\s+)*$/.test(prefix)) return true;
  return /^[^a-z]*(?:(?:done|ok|okay|all set|sure|great|got it|perfect|yes|yep)\b[^a-z]*)*$/.test(prefix);
}

/** A modal / offer right before the verb makes it not a claim (S-B5..S-B7): "I'll set it", "want me to…". */
const NOT_A_CLAIM_PREFIX = /\b(?:i'll|i will|i can|i could|i'd|i would|going to|want me to|shall i|should i|let me|can i|happy to)\s+(?:\w+\s+){0,2}$/;

export interface BoardClaim {
  kind: ClaimKind;
  /** The first task title the sentence names in quotes, when it names one. */
  title?: string;
  /** Every task title the sentence names in quotes ("I parked 'A' and set 'B' to Up Next"). */
  titles: string[];
}

/** The completed board-action claim a single sentence makes, or null. Pure; exported for the spelling table. */
export function detectBoardClaim(sentence: string): BoardClaim | null {
  const raw = String(sentence ?? "");
  if (/\?\s*$/.test(raw.trim())) return null; // a question/offer, not a claim (S-B6)
  const s = stripDoubleQuoted(raw).toLowerCase().replace(/[‘’]/g, "'");
  for (const [kind, re] of CLAIM_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    if (kind !== "started") {
      const prefix = s.slice(0, m.index);
      if (NOT_A_CLAIM_PREFIX.test(prefix)) continue;
      if (!claimSubjectOk(prefix)) continue;
    }
    const titles = claimedTitles(raw);
    return { kind, title: titles[0], titles };
  }
  return null;
}

function claimedTitles(sentence: string): string[] {
  const out: string[] = [];
  const res = [
    /“([^”]{2,160})”/g,
    /"([^"]{2,160})"/g,
    /(?:^|[\s(—–-])['‘]([^'’]{2,160})['’](?=[\s.,!?;:)—–-]|$)/g,
  ];
  for (const re of res) for (const m of sentence.matchAll(re)) out.push(m[1].trim());
  return [...new Set(out)];
}

/** The title a recorded call touched: its board fact, else the “…” in a create_huddle_task summary. */
function useTitle(u: ToolUseLike): string | undefined {
  if (u.board?.title) return u.board.title;
  const m = /“([^”]+)”/.exec(u.summary);
  return m ? m[1] : undefined;
}

function titlesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true; // one side unnamed ("it") -> any write of the right kind backs it
  const x = normClaimTitle(a);
  const y = normClaimTitle(b);
  if (!x || !y) return true;
  return x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y));
}

function backsClaim(u: ToolUseLike, c: { kind: ClaimKind; title?: string }): boolean {
  const status = (u.board?.status ?? "").toLowerCase();
  let kindOk = false;
  switch (c.kind) {
    case "done":
      kindOk = isPerformedTaskChange(u) && (!status || /done|complete/.test(status));
      break;
    case "status":
    case "archived":
      kindOk = isPerformedTaskChange(u);
      break;
    case "added":
      kindOk = isPerformedCreate(u);
      break;
    case "deleted":
      kindOk = isPerformedTaskChange(u) && DELETE_TOOLS.has(u.tool);
      break;
    case "started":
      kindOk =
        isPerformedWork(u) ||
        (u.ok && u.tool === "tavily_web_search") ||
        (isPerformedTaskChange(u) && /doing|progress/.test(status));
      break;
  }
  if (!kindOk) return false;
  // A claim that names task A is not backed by a write on task B (F6-12).
  return titlesMatch(c.title, useTitle(u));
}

/** The titles a claim names that NO performed write backs. `[""]` = an unnamed claim ("it") with no backing
 *  write of its kind; `[]` = fully backed. Every named task must be backed on its own (F6-12). */
function unbackedTitles(c: BoardClaim, uses: readonly ToolUseLike[]): string[] {
  if (!c.titles.length) return uses.some((u) => backsClaim(u, { kind: c.kind })) ? [] : [""];
  return c.titles.filter((t) => !uses.some((u) => backsClaim(u, { kind: c.kind, title: t })));
}

export interface BoardClaimOptions {
  /** Internal (autowork / worker) turns run work the runtime already started, so "started" is not checked. */
  internal?: boolean;
  /** Current status of a task by title, when the turn knows it (journey echoes). Used only for wording. */
  statusOf?: (title: string) => string | undefined;
  /** Agent id -> display name, for the "passed to <Name>" wording. */
  nameOf?: (agentId: string) => string | undefined;
}

/** The code-built line that replaces an unbacked claim. Never itself a claim (idempotency). `title` is the
 *  one unbacked task this line is about ("" = the claim named none). */
function correctionFor(
  c: { kind: ClaimKind; title?: string },
  uses: readonly ToolUseLike[],
  opts: BoardClaimOptions,
): string {
  const deferred = uses.find(
    (u) => isDeferredStatusChange(u) && (c.kind === "done" || c.kind === "status" || c.kind === "archived") && titlesMatch(c.title, useTitle(u)),
  );
  const named = c.title || (deferred ? useTitle(deferred) : undefined);
  const q = named ? `“${named}”` : "that";
  if (deferred) {
    const who = /assigned to ([^\s,]+)/.exec(deferred.summary)?.[1] ?? "";
    const name = (who && opts.nameOf?.(who)) || who || "its assignee";
    return `That change wasn't made — ${named ? `“${named}”` : "the task"} is assigned to ${name}, so it was passed to them.`;
  }
  if (c.kind === "added") {
    const skipped = uses.find((u) => isSkippedDuplicateCreate(u) && titlesMatch(c.title, useTitle(u)));
    if (skipped) return `${named ? `“${named}”` : "That task"} is already on your board — no new card was added.`;
  }
  if (c.kind === "done" && named && /^done$|complete/i.test(opts.statusOf?.(named) ?? "")) {
    return `“${named}” was already done — nothing was changed on the board.`;
  }
  if (c.kind === "started") return named ? `Work on “${named}” hasn't started yet.` : "That work hasn't started yet.";
  return `Nothing was changed on the board for ${q}.`;
}

/** One reply's text with every unbacked board claim replaced by its code-built correction. Pure. */
export function presentBoardClaims(text: string, uses: readonly ToolUseLike[], opts: BoardClaimOptions = {}): string {
  const src = String(text ?? "");
  const parts = src.split(/((?<=[.!?])\s+|\n+)/);
  let changed = false;
  const out: string[] = [];
  let lastCorrection = "";
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i] ?? "";
    const sep = parts[i + 1] ?? "";
    const claim = sentence.trim() ? detectBoardClaim(sentence) : null;
    const missing = claim && !(claim.kind === "started" && opts.internal) ? unbackedTitles(claim, uses) : [];
    if (!claim || !missing.length) {
      out.push(sentence + sep);
      continue;
    }
    changed = true;
    const line = missing.map((t) => correctionFor({ kind: claim.kind, title: t }, uses, opts)).join(" ");
    if (line === lastCorrection) continue; // one correction per claim run, not one per sentence
    lastCorrection = line;
    out.push(line + (sep || " "));
  }
  if (!changed) return src;
  return out.join("").trim();
}

/** The turn-level view: every reply, against every tool call of the turn (earlier chunks included). */
export function presentBoardClaimsTurn<R extends { agentId: string; text: string }>(
  replies: R[],
  uses: readonly ToolUseLike[],
  opts: BoardClaimOptions = {},
): R[] {
  return replies.map((r) => {
    const text = presentBoardClaims(r.text, uses, opts);
    return text === r.text ? r : { ...r, text };
  });
}
