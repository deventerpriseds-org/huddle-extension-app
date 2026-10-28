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
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RUNTIME HONESTY (AC-F2-35). Code, not prompt -- the same precedent as the meta-task guard.
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
      const parsed = JSON.parse(u.detail) as { results?: ItemResult[]; ok?: boolean; error?: string };
      if (Array.isArray(parsed.results)) results.push(...parsed.results);
      else if (parsed.ok === false) results.push({ index: 0, action: "failed", persisted: false, error: String(parsed.error ?? "failed") });
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

/**
 * VOICE (W18). On the Realtime voice surface the model speaks its OWN words, sentence by sentence as
 * they stream, so there is no reply-assembly step to hook. This gate gives the voice client one: feed
 * it every tool output; while the exchange holds a write whose item did NOT persist, `holding` is true
 * and the client must buffer the reply instead of speaking it, then speak
 * `enforceNexusWriteHonesty(fullText, gate.uses)` -- the same guard the text path runs. A clean write
 * never holds, so the happy path keeps its streaming latency. `reset()` at the next user utterance.
 */
export function createNexusWriteSpeechGate() {
  let uses: ToolUseLike[] = [];
  return {
    noteToolOutput(name: string, output: string) {
      if (name === NEXUS_WRITE_TOOL_NAME && typeof output === "string") uses.push({ tool: name, ok: false, detail: output });
    },
    get holding(): boolean {
      return uses.some((u) => nexusWriteHasUnsaved(u.detail ?? ""));
    },
    get uses(): ToolUseLike[] {
      return uses;
    },
    reset() {
      uses = [];
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
