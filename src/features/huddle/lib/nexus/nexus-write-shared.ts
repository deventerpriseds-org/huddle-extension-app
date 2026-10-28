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
  reason?: string;
  error?: string;
  detail?: string;
  candidates?: unknown[];
  courses?: unknown[];
  note?: string;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RUNTIME HONESTY (AC-F2-35). Code, not prompt -- the same precedent as the meta-task guard: when an
// item this agent tried to write did NOT persist, its reply may not claim it was saved. A reply that
// claims success without admitting the failure is REPLACED by a statement built from the tool result;
// a reply that is silent about it gets that statement appended. Duplicates are not failures.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const CLAIM_RE =
  /\b(added|saved|created|logged|updated|recorded|entered|done|all set|(?:is|are) (?:now )?on your (?:list|assignments)|put (?:it|them|that) (?:on|in|into))\b/i;
const DENIAL_RE =
  /\b(not (?:been )?(?:saved|added|updated|created|logged)|(?:was|were)n'?t (?:saved|added|updated|created|logged)|did ?n(?:o|')t (?:save|add|update|go through)|could ?n(?:o|')t (?:save|add|update|be saved)|cannot (?:save|add|update)|can'?t (?:save|add|update)|failed|unable to|may (?:or may not )?have (?:been )?(?:saved|landed|gone through)|unconfirmed|nothing was (?:saved|added|written|changed))\b/i;

type ToolUseLike = { tool: string; ok: boolean; detail?: string };

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
  return lines.join(" ");
}

export function enforceNexusWriteHonesty(text: string, toolUses: ToolUseLike[]): string {
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
  const notSaved = results.filter((r) => r.persisted !== true && r.action !== "duplicate");
  if (!notSaved.length) return text;
  const statement = nexusWriteOutcomeStatement(results);
  const t = text ?? "";
  if (DENIAL_RE.test(t)) return t; // already admits the failure in its own words
  if (CLAIM_RE.test(t)) return statement; // claims success it did not get: replace, never decorate
  return t.trim() ? `${t.trim()}\n\n${statement}` : statement;
}
