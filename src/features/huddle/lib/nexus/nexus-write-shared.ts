// WHAT:       The PURE half of the Nexus write tool: its name, its per-item result shape, and the
//             runtime honesty guard that stops an agent claiming a save that did not happen.
// WHY:        huddle.functions.ts imports `.server` modules only dynamically; the honesty guard runs
//             inside the synchronous reply assembly, so it needs a module with no server imports.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   AC-F2-35 (nexus-hub AC-syllabus-deliverables-write-tool.md); scripts/nexus-write-tool.test.ts.

export const NEXUS_WRITE_TOOL_NAME = "write_nexus_assignments";

export type ItemResult = {
  index: number;
  title?: string;
  action: "inserted" | "updated" | "duplicate" | "rejected" | "failed";
  persisted: true | false | "unknown";
  assignment_id?: string;
  course?: { id: unknown; code: unknown; name: unknown };
  due_date?: string;
  due_local?: string;
  time_assumed?: boolean;
  /** The local time did not exist (spring-forward gap) and was moved FORWARD (W13). */
  time_shifted?: boolean;
  /** A duplicate of a stored row that has NO due date: the date given was not saved (W7). */
  stored_undated?: boolean;
  /** A points value that was refused (not a whole number) -- the rest of the item may still save (W16). */
  points_note?: string;
  reason?: string;
  error?: string;
  detail?: string;
  candidates?: unknown[];
  courses?: unknown[];
  note?: string;
  /** A tool-level failure (no per-item results): the whole request, not one item (loop 3). */
  request_level?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SECONDARY, NOT ON ANY RUNTIME PATH since loop 3 (docs/FIX-nexus-write-loop3.md): the runtime rule is
// `presentNexusWriteTurn` below (code-built from the results, no word lists). The clause parser that follows
// (`enforceNexusWriteHonesty`, CLAIM_RE/DENIAL_RE) is kept ONLY for its pre-loop-3 tests; L3-H0 asserts no
// runtime caller. Its original description, for the record:
//
// STRUCTURAL, PER ITEM (FIX-nexus-write-redteam.md, W8/W10/W11): the reply is cut into clauses and
// each clause that CLAIMS a save is checked against the `persisted` value of the item(s) it names.
//   - a claim naming an item whose own persisted !== true is FALSE -- nothing else in the reply can
//     excuse it (a true denial about item B never launders a false claim about item A; a stray
//     "nothing failed" / "unable to find any conflicts" is not a denial of anything);
//   - a claim naming no item ("Done!", "All set", "it's in") is about the batch: false while any
//     not-saved item is left unacknowledged;
//   - a denial counts only as a NEGATED SAVE ("wasn't added", "couldn't save", "timed out"), and only
//     acknowledges the item(s) it names (or all of them when it names none).
// Any false claim -> the reply is REPLACED by a statement built from the per-item results. No false
// claim but an unacknowledged failure -> that failure's statement is appended. Duplicates are not
// failures. Teammate mode (a reply from an agent that did NOT make the write): only claims that NAME
// one of the writer's not-saved items are checked; such a sentence is dropped and the truth appended.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const CLAIM_RE =
  /(?:\b(?:added|saved|created|logged|updated|recorded|entered|stored|filed|uploaded|inserted|done|all set|taken care of|locked in|went through|gone through|landed|got (?:it|them|that) in|(?:it|that|they|those)['’]?(?:s| is| are|re)\s+in\b|(?:is|are|now)\s+(?:now\s+)?(?:in|on|into)\s+(?:nexus|your\s+(?:list|assignments|nexus|course|courses|coursework))|in nexus now|put\b[^.!?\n]{0,60}?\b(?:on|in|into)\b)\b|[✅✔☑])/i;
const DENIAL_RE =
  /(?:\b(?:not|never|no longer|unable to|failed to|fail to|cannot|can ?not)\b|n['’]t\b)[^.!?\n]{0,40}?\b(?:sav|add|updat|creat|logg|record|enter|stor|fil|upload|insert|writ|put|land|persist|go(?:ne)? through|went through|in nexus|in yet|there|confirm|sure)|\b(?:timed? out|time-?out|unconfirmed|may (?:or may not )?have|might have|not sure (?:if|whether)|(?:save|write|request|upload|insert|update|it|that|this|which)\s+(?:has\s+|have\s+)?failed|rejected|refused|nothing was (?:saved|added|written|changed))\b/i;

type ToolUseLike = { tool: string; ok: boolean; detail?: string };

/** Unicode-aware word set (so a non-Latin title can still be found in a reply). */
const wordsOf = (s: string) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const TITLE_STOP = new Set(["the", "a", "an", "of", "and", "for", "on", "to", "in", "my", "your", "test"]);

/** Every per-item result carried by write_nexus_assignments tool uses (tool-level errors -> one failed item). */
export function nexusWriteResultsFrom(toolUses: ToolUseLike[]): ItemResult[] {
  const results: ItemResult[] = [];
  for (const u of toolUses) {
    if (u.tool !== NEXUS_WRITE_TOOL_NAME || typeof u.detail !== "string") continue;
    try {
      const parsed = JSON.parse(u.detail) as { results?: ItemResult[]; ok?: boolean; error?: unknown; persisted?: unknown };
      if (Array.isArray(parsed.results)) results.push(...parsed.results);
      // V1 (docs/FIX-nexus-write-voice-gate.md): a write output with NO per-item results is a request-level
      // failure when it says ok:false OR carries an error (a thrown executor's `{error,tool}` has no `ok`).
      // `persisted:"unknown"` (a throw after the POST may have landed) is kept, never upgraded to false.
      else if (parsed && typeof parsed === "object" && (parsed.ok === false || (parsed.error != null && parsed.error !== "" && parsed.error !== false)))
        results.push({ index: 0, action: "failed", persisted: parsed.persisted === "unknown" ? "unknown" : false, error: String(parsed.error ?? "failed"), request_level: true });
    } catch {
      /* not ours */
    }
  }
  return results;
}

/** True when a write_nexus_assignments result (its JSON) holds any item that did NOT persist (duplicates excluded). */
export function nexusWriteHasUnsaved(detail: string): boolean {
  return nexusWriteResultsFrom([{ tool: NEXUS_WRITE_TOOL_NAME, ok: false, detail }]).some(
    (r) => r.persisted !== true && r.action !== "duplicate",
  );
}

export function nexusWriteOutcomeStatement(results: ItemResult[]): string {
  const name = (r: ItemResult) => `“${r.title ?? r.assignment_id ?? `item ${r.index + 1}`}”`;
  const lines: string[] = [];
  const saved = results.filter((r) => r.persisted === true);
  const dupes = results.filter((r) => r.action === "duplicate");
  const unknown = results.filter((r) => r.persisted === "unknown");
  const failed = results.filter((r) => (r.action === "rejected" || r.action === "failed") && r.persisted === false);
  if (failed.length) lines.push(`Not saved to Nexus: ${failed.map((r) => `${name(r)} (${r.error ?? r.reason ?? "failed"})`).join(", ")}.`);
  if (unknown.length) lines.push(`Unconfirmed — the request timed out, so I can't say yet whether it saved: ${unknown.map(name).join(", ")}. I'll check before treating it as added.`);
  if (saved.length) lines.push(`Saved to Nexus: ${saved.map(name).join(", ")}.`);
  if (dupes.length) lines.push(`Already in Nexus (nothing new added): ${dupes.map(name).join(", ")}.`);
  const undatedDupes = dupes.filter((r) => r.stored_undated);
  if (undatedDupes.length) lines.push(`The stored ${undatedDupes.map(name).join(", ")} has no due date, so the date was not saved — want me to add it?`);
  const pts = results.filter((r) => r.points_note);
  if (pts.length) lines.push(`Points not saved for ${pts.map(name).join(", ")} (points must be a whole number).`);
  return lines.join(" ");
}

type Clause = { text: string; words: Set<string>; claim: boolean; denial: boolean };
type Sentence = { text: string; clauses: Clause[] };

function parseReply(text: string): Sentence[] {
  const sentences = String(text || "")
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.map((s) => {
    const parts = s
      .split(/\s*(?:[,;:]|\s[—–-]{1,2}\s|—|\band\b|\bbut\b|\bso\b|\bwhile\b|\bthough\b|\bhowever\b|\bbecause\b)\s*/i)
      .map((c) => c.trim())
      .filter(Boolean);
    return {
      text: s,
      clauses: parts.map((c) => {
        const denial = DENIAL_RE.test(c);
        return { text: c, words: new Set(wordsOf(c)), denial, claim: !denial && CLAIM_RE.test(c) };
      }),
    };
  });
}

/** Does `words` (a clause or sentence) name this item? Every content word of its title must appear. */
function names(words: Set<string>, r: ItemResult): boolean {
  const tw = wordsOf(r.title ?? "").filter((w) => !TITLE_STOP.has(w));
  return tw.length > 0 && tw.every((w) => words.has(w));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE PRIMARY HONESTY RULE (loop 3, D10/D11 -- docs/FIX-nexus-write-loop3.md). NO WORD LISTS, NO PARSING.
// Loop 2 kept the model's text after a failed write and dropped only the sentences that matched a
// write-talk vocabulary (WRITE_TALK) or named the item -- and "It's in.", "Penciled it in", "Handled",
// "Listo, ya quedó guardado", full-width "Ａｄｄｅｄ" and even AC-F2-35's own "is on your list" survived.
// The rule is now decided by the RESULTS alone, for the whole TURN (every agent, every chunk):
//   (a) ANY write this turn did not persist (failed / rejected / duplicate -- nothing new written /
//       unknown): EVERY agent reply of the turn is replaced. ONE code-built message (per-item status +
//       a fixed closing line) is the writer's reply; every other reply becomes a fixed code-built
//       "held back" line. No model sentence survives -- nothing is filtered, so nothing can leak.
//   (b) every write persisted: the writer's reply gets a code-built "Saved in Nexus:" list appended
//       (title, due date in course-local time, course), so the owner always SEES exactly what was
//       written -- a model sentence that miscounts ("all 5") sits next to the list that contradicts it.
//   (c) the turn's write results ride the durable resume state (huddle.functions.ts), so a later chunk
//       or teammate is covered by (a)/(b) too.
// A write that is still IN FLIGHT counts as `unknown` (nexusWriteInFlightOutcome), so a reply persisted
// while it is pending can never claim it. `enforceNexusWriteHonesty` (below) is NOT on any runtime path;
// it is kept only for its pre-loop-3 tests (scripts/nexus-write-loop3.test.ts L3-H0 asserts no runtime
// caller exists).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Every other reply of a failed-write turn: fixed, code-built, claims nothing. */
export const NEXUS_WRITE_WITHHELD_REPLY =
  "(Held back: a Nexus write in this turn did not fully save, so this turn shows only the Nexus write status.)";
/** The fixed closing line of the failed-write message. */
export const NEXUS_WRITE_STATUS_CLOSING =
  "Nothing else from this turn is shown. Anything marked not saved is NOT in Nexus; check Nexus before relying on anything marked unknown.";

const plainReason = (r: ItemResult): string => {
  const why = String(r.reason ?? r.error ?? "failed");
  const map: Record<string, string> = {
    "meeting/session": "it is a meeting/session/class, not a graded deliverable",
    event: "it is an event, not a graded deliverable",
    administrative: "it is a holiday, break, payment or admin date, not a graded deliverable",
    reading: "it is a reading, not a graded deliverable",
    "not-a-deliverable": "the title names no graded deliverable",
    undated: "it has no due date",
    "ambiguous-date": "the date has no year or is not a real date",
    course_not_found: "no course matches that code",
    course_ambiguous: "that course code matches more than one course",
    course_required: "no course was given",
    title_required: "no title was given",
    not_found: "that assignment was not found",
    no_fields: "nothing to change was given",
    network_error: "Nexus could not be reached",
    no_row_id_in_response: "Nexus did not confirm a saved row",
    existing_unreadable: "the course's existing assignments could not be read to rule out a duplicate",
    batch_too_large: "too many items in one request",
    nexus_write_not_configured: "the Nexus write connection is not configured",
    not_reversible: "Nexus refused the change",
  };
  if (map[why]) return map[why];
  const http = /^http_(\d{3})$/.exec(why);
  if (http) return `Nexus returned an error (http ${http[1]})`;
  if (/^courses_unreadable/.test(why)) return "the course list could not be read";
  return why.replace(/_/g, " ");
};

const itemName = (r: ItemResult): string =>
  r.request_level ? "the whole write request" : `“${r.title ?? r.assignment_id ?? `item ${r.index + 1}`}”`;
const courseLabel = (r: ItemResult): string => {
  const c = r.course;
  const label = c ? (typeof c.code === "string" && c.code ? c.code : typeof c.name === "string" && c.name ? c.name : "") : "";
  return label ? ` — ${label}` : "";
};
const dueLabel = (r: ItemResult): string => (r.due_local ? ` — due ${r.due_local}` : "");

/** One code-built status line per item, from the results alone. */
export function nexusWriteStatusLine(r: ItemResult): string {
  let line: string;
  if (r.persisted === true) line = `${r.action === "updated" ? "Updated" : "Saved"}: ${itemName(r)}${dueLabel(r)}${courseLabel(r)}`;
  else if (r.persisted === "unknown") line = `Unknown — check Nexus: ${itemName(r)} (the request did not confirm whether it saved)`;
  else if (r.action === "duplicate")
    line = `Already in Nexus, nothing new added: ${itemName(r)}${dueLabel(r)}${courseLabel(r)}${r.stored_undated ? " — the stored one has no due date, so the date given was NOT saved" : ""}`;
  else line = `Not saved: ${itemName(r)} — ${plainReason(r)}`;
  if (r.points_note) line += " (points were not saved: they must be a whole number)";
  return line;
}

/** Same item reported twice (a resumed/suppressed copy) collapses to one line. */
function uniqueResults(results: ItemResult[]): ItemResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.index}|${r.title ?? r.assignment_id ?? ""}|${r.action}|${String(r.persisted)}|${r.error ?? r.reason ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** (a) THE message of a turn in which any write did not persist: per-item status + the fixed closing line. */
export function nexusWriteFailureMessage(results: ItemResult[]): string {
  const lines = uniqueResults(results).map((r) => `• ${nexusWriteStatusLine(r)}`);
  return ["Nexus write status:", ...lines, NEXUS_WRITE_STATUS_CLOSING].join("\n");
}

/** (b) The list appended to the writer's reply when every write persisted. */
export function nexusWriteSavedList(results: ItemResult[]): string {
  const lines = uniqueResults(results).map((r) =>
    r.action === "updated" ? `• Updated: ${itemName(r)}${dueLabel(r)}${courseLabel(r)}` : `• ${itemName(r)}${dueLabel(r)}${courseLabel(r)}`,
  );
  return ["Saved in Nexus:", ...lines].join("\n");
}

/** True when any result did not persist (failed, rejected, duplicate, unknown). */
export const nexusWriteAnyUnpersisted = (results: ItemResult[]): boolean => results.some((r) => r.persisted !== true);

/** A write this turn, as the runtime records it (huddle.functions.ts turnNexusWriteUses). */
export type TurnNexusWriteUse = { agentId: string; tool: string; ok: boolean; detail?: string; claimKey?: string };

/**
 * (a)+(b) for a whole turn: the replies the OWNER sees. Pure; the runtime keeps the raw replies (resume
 * state) and calls this at every point a reply leaves the server (stream, chunk save, final result, the
 * prior shown to later agents, memory). Same input -> same output, so re-applying it is safe.
 */
export function presentNexusWriteTurn<R extends { agentId: string; text: string }>(
  replies: R[],
  uses: TurnNexusWriteUse[],
): Array<R | { agentId: string; text: string }> {
  const writes = uses.filter((u) => u.tool === NEXUS_WRITE_TOOL_NAME);
  const results = nexusWriteResultsFrom(writes);
  if (!results.length) return replies;
  if (nexusWriteAnyUnpersisted(results)) {
    const message = nexusWriteFailureMessage(results);
    const failedWriters = writes.filter((u) => nexusWriteAnyUnpersisted(nexusWriteResultsFrom([u]))).map((u) => u.agentId);
    if (!replies.length) return [{ agentId: failedWriters[0] ?? writes[0].agentId, text: message }];
    let carrier = replies.findIndex((r) => failedWriters.includes(r.agentId));
    if (carrier < 0) carrier = 0;
    return replies.map((r, i) => ({ ...r, text: i === carrier ? message : NEXUS_WRITE_WITHHELD_REPLY }));
  }
  const out: Array<R | { agentId: string; text: string }> = replies.map((r) => ({ ...r }));
  const writers = [...new Set(writes.map((u) => u.agentId))];
  for (const w of writers) {
    const list = nexusWriteSavedList(nexusWriteResultsFrom(writes.filter((u) => u.agentId === w)));
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].agentId === w) { idx = i; break; }
    if (idx >= 0) {
      const text = String(out[idx].text ?? "").trim();
      out[idx] = { ...out[idx], text: text ? `${text}\n\n${list}` : list };
    } else out.push({ agentId: w, text: list });
  }
  return out;
}

/**
 * The single-reply view of the same rule (the voice gate and the pure tests): `toolUses` = this agent's
 * writes, `teammateUses` = other agents' writes this turn. A failed/unknown write anywhere -> the failure
 * message; everything persisted -> this agent's text + the list of ITS OWN writes (a teammate's list
 * belongs on the teammate's reply).
 */
export function nexusWriteGuardedReply(text: string, toolUses: ToolUseLike[], teammateUses: ToolUseLike[] = []): string {
  const uses: TurnNexusWriteUse[] = [
    ...toolUses.map((u) => ({ ...u, agentId: "self" })),
    ...teammateUses.map((u) => ({ ...u, agentId: "teammate" })),
  ];
  const shown = presentNexusWriteTurn([{ agentId: "self", text: text ?? "" }], uses);
  return shown.find((r) => r.agentId === "self")?.text ?? shown[0]?.text ?? text ?? "";
}

/**
 * The tool result recorded the moment a write call STARTS (D11): every item `unknown`, so a reply persisted
 * while the write is still in flight -- or a chunk that ends before it returns -- can never claim it. The
 * real result replaces it when it arrives.
 */
export function nexusWriteInFlightOutcome(args: Record<string, unknown>, error = "in_flight"): { [k: string]: unknown; results: ItemResult[] } {
  const raw: unknown[] = Array.isArray(args.items) ? (args.items as unknown[]) : [args];
  const results: ItemResult[] = raw.map((x, index) => {
    const it = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const title = typeof it.title === "string" && it.title.trim() ? it.title.trim() : undefined;
    const id = typeof it.assignment_id === "string" && it.assignment_id.trim() ? it.assignment_id.trim() : undefined;
    return { index, title, assignment_id: id, action: "failed", persisted: "unknown", error };
  });
  return { ok: true, persisted: "unknown", inserted: 0, updated: 0, duplicate: 0, rejected: 0, failed: results.length, results };
}
/**
 * STREAM HOLD for the 1:1 TEXT path (D4). `onDelta` publishes the growing reply to the durable row the
 * client polls; once a write tool call STARTS in this turn, nothing more is published for the rest of the
 * turn, so a forming "I've added it" can never be shown -- only the final, guarded reply is.
 */
export function createNexusWriteStreamHold() {
  let held = false;
  return {
    noteToolCall(name: string) {
      if (name === NEXUS_WRITE_TOOL_NAME) held = true;
    },
    get held(): boolean {
      return held;
    },
    wrap<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
      return (...a: A) => {
        if (!held) fn(...a);
      };
    },
  };
}

/**
 * VOICE (W18; loop 2 D3/D4; loop 3 D9 -- docs/FIX-nexus-write-loop3.md). On the Realtime voice surface the
 * model speaks its OWN words as they stream, so the client holds them here. Loop 2 held speech from the
 * call's start but RELEASED the raw reply at `text.done` while the write was still pending (finalize was a
 * pass-through with no results yet): "Done, I've added it" was spoken whenever a read tool returned first,
 * the user talked mid-write, or text followed the call. Loop 3, owner-specified:
 *   - while ANY write call is pending, `finalize` speaks / captions / persists NOTHING: every text.done is
 *     BUFFERED;
 *   - once every write result is in, the next `finalize` (or `flush` at response.done) DELIVERS once:
 *       any item not persisted -> ONLY the code-built failure message (the same text the text path shows);
 *       every item persisted   -> the buffered model text + this text, then the code-built saved list;
 *   - after a failed delivery, the rest of the exchange says nothing (no model sentence survives);
 *   - `reset()` at the next user utterance is DEFERRED until the delivery, so talking over the wait can
 *     never release anything early.
 * `finalize` returns { full, speak, mode }: `full` is what is captioned + persisted; `speak` is what to voice;
 * mode "whole" = voice `speak` on its own (nothing of this reply was streamed), "append" = the reply streamed
 * normally and `speak` (the saved list) is appended to the stream's tail, "none" = nothing to add.
 * A clean write with no buffered text releases the hold when its result arrives, so the happy path keeps
 * its streaming latency and the list is appended at text.done.
 */
export type NexusSpeech = { full: string; speak: string; mode: "whole" | "append" | "none" };

export function createNexusWriteSpeechGate() {
  let uses: ToolUseLike[] = [];
  let pending = 0;
  let buffer: string[] = [];
  let delivered = false;
  let resetRequested = false;
  const seenTurns: string[] = []; // user turns already reset (survives clear(): a late duplicate stays a no-op)
  const results = () => nexusWriteResultsFrom(uses);
  const failed = () => nexusWriteAnyUnpersisted(results());
  const clear = () => {
    uses = [];
    pending = 0;
    buffer = [];
    delivered = false;
    resetRequested = false;
  };
  const holdingNow = () => pending > 0 || (uses.length > 0 && (failed() || (!delivered && buffer.length > 0)));
  const deliver = (raw: string, wasHolding: boolean): NexusSpeech => {
    delivered = true;
    const rs = results();
    if (nexusWriteAnyUnpersisted(rs)) {
      buffer = [];
      const msg = nexusWriteFailureMessage(rs);
      return { full: msg, speak: msg, mode: "whole" };
    }
    const list = nexusWriteSavedList(rs);
    const body = [...buffer, raw].map((x) => x.trim()).filter(Boolean).join(" ");
    buffer = [];
    const full = body ? `${body}\n\n${list}` : list;
    return wasHolding ? { full, speak: full, mode: "whole" } : { full, speak: list, mode: "append" };
  };
  const settle = <T,>(out: T): T => {
    if (pending === 0 && delivered && resetRequested) clear();
    return out;
  };
  return {
    noteToolCall(name: string) {
      if (name !== NEXUS_WRITE_TOOL_NAME) return;
      pending += 1;
      delivered = false;
    },
    noteToolOutput(name: string, output: string) {
      if (name !== NEXUS_WRITE_TOOL_NAME || typeof output !== "string") return;
      pending = Math.max(0, pending - 1);
      delivered = false;
      uses.push({ tool: name, ok: false, detail: output });
    },
    /** Do not stream-synth deltas while true. */
    get holding(): boolean {
      return holdingNow();
    },
    get uses(): ToolUseLike[] {
      return uses;
    },
    /** On every text.done. */
    finalize(raw: string): NexusSpeech {
      const text = String(raw ?? "");
      const wasHolding = holdingNow();
      if (pending === 0 && uses.length === 0) return { full: text, speak: "", mode: "none" }; // no write: streamed as usual
      if (pending > 0) {
        if (text.trim()) buffer.push(text.trim());
        return { full: "", speak: "", mode: "none" }; // a write is in flight: say NOTHING yet
      }
      if (!delivered) return settle(deliver(text, wasHolding));
      if (failed()) return settle({ full: "", speak: "", mode: "none" }); // the failure message was the exchange's only words
      return settle(wasHolding ? { full: text, speak: text, mode: "whole" } : { full: text, speak: "", mode: "none" });
    },
    /** On response.done: deliver results that are in but were never delivered (the follow-up reply was cut
     *  short or carried no text) -- always for a failure, for a success only when model text is buffered. */
    flush(): NexusSpeech | null {
      if (pending > 0 || uses.length === 0 || delivered) return null;
      if (!failed() && buffer.length === 0) return null;
      return settle(deliver("", true));
    },
    /**
     * A NEW USER TURN (spoken or typed). Deferred while a write is pending or its result is undelivered.
     * `turnKey` (the Realtime user item id) makes it once per user turn: the hook resets at
     * `input_audio_buffer.committed` -- which precedes the reply to that audio -- AND at the async
     * `transcription.completed`, which can land AFTER that reply (V5). The second signal for the same
     * item is a no-op, so a late transcription can never reset a LATER exchange's write.
     */
    reset(turnKey?: string) {
      if (turnKey) {
        if (seenTurns.includes(turnKey)) return;
        seenTurns.push(turnKey);
        if (seenTurns.length > 64) seenTurns.shift();
      }
      if (pending > 0 || (uses.length > 0 && !delivered)) resetRequested = true;
      else clear();
    },
  };
}

/**
 * @param toolUses  THIS agent's own tool uses: every check applies.
 * @param teammateUses  write_nexus_assignments uses made by OTHER agents this turn: only a claim that
 *                      NAMES one of their not-saved items is checked (a teammate's "Done" is about
 *                      its own work), and nothing is appended when the reply is silent about them.
 */
export function enforceNexusWriteHonesty(text: string, toolUses: ToolUseLike[], teammateUses: ToolUseLike[] = []): string {
  const own = nexusWriteResultsFrom(toolUses);
  const mates = nexusWriteResultsFrom(teammateUses);
  const t = text ?? "";
  const unsaved = (r: ItemResult) => r.persisted !== true && r.action !== "duplicate";
  const ownUnsaved = own.filter(unsaved);
  const mateUnsaved = mates.filter(unsaved);
  if (!ownUnsaved.length && !mateUnsaved.length) return t;

  const sentences = parseReply(t);
  // Acknowledged = named by a denial clause (or every own unsaved item, by an unattributed denial).
  const acked = new Set<ItemResult>();
  for (const s of sentences) {
    for (const c of s.clauses) {
      if (!c.denial) continue;
      const named = ownUnsaved.filter((r) => names(c.words, r));
      const sentNamed = named.length ? named : ownUnsaved.filter((r) => names(new Set(wordsOf(s.text)), r));
      (sentNamed.length ? sentNamed : ownUnsaved).forEach((r) => acked.add(r));
    }
  }
  let ownFalse = false;
  const falseMateSentences = new Set<Sentence>();
  const falseMateItems = new Set<ItemResult>();
  for (const s of sentences) {
    for (const c of s.clauses) {
      if (!c.claim) continue;
      const namedOwn = own.filter((r) => names(c.words, r));
      if (namedOwn.some(unsaved)) ownFalse = true;
      else if (!namedOwn.length && ownUnsaved.some((r) => !acked.has(r))) ownFalse = true;
      const namedMate = mateUnsaved.filter((r) => names(c.words, r));
      if (namedMate.length) {
        falseMateSentences.add(s);
        namedMate.forEach((r) => falseMateItems.add(r));
      }
    }
  }
  if (ownFalse) return nexusWriteOutcomeStatement(own); // claims success it did not get: replace, never decorate
  let out = t.trim();
  if (falseMateSentences.size) {
    out = sentences.filter((s) => !falseMateSentences.has(s)).map((s) => s.text).join(" ");
    const truth = nexusWriteOutcomeStatement([...falseMateItems]);
    out = out ? `${out}\n\n${truth}` : truth;
  }
  const unacked = ownUnsaved.filter((r) => !acked.has(r));
  if (!unacked.length) return falseMateSentences.size ? out : t;
  const statement = nexusWriteOutcomeStatement(unacked);
  return out ? `${out}\n\n${statement}` : statement;
}
