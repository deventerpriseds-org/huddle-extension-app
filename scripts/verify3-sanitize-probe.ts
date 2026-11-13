// WHAT: verifier probe -- sanitizeChecklistPayload vs main's inline mapping for legacy rows (AC-5.1 regression).
// WHY: the live build_checklist reply path now goes through this function. SUPERSEDES/SUPERSEDED-BY: nothing.
// EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-3.md
import { sanitizeChecklistPayload } from "../src/features/huddle/lib/proposals/proposals";
const mainMap = (c: any) => {
  const r: any = { title: c.title, rows: c.rows.filter((row: any) => row && typeof row.taskId === "string" && typeof row.title === "string").map((row: any) => ({ taskId: row.taskId, title: row.title, status: typeof row.status === "string" ? row.status : "BACKLOG", tags: Array.isArray(row.tags) ? row.tags.filter((t: any) => typeof t === "string") : [] })), ...(typeof c.more === "number" && c.more > 0 ? { more: c.more } : {}) };
  return r.rows.length ? r : undefined;
};
const cases: any[] = [
  { title: "Today", rows: [{ taskId: "0b5c6d1e-0000-4000-8000-000000000001", title: "Pay rent", status: "DOING", tags: ["home", 3] }], more: 2 },
  { title: "Today", rows: [{ taskId: "t1", title: "x" }, null, { taskId: 5, title: "y" }, { taskId: "t2", title: "z", status: 7 }], more: 0 },
  { title: "Today", rows: [{ taskId: "t1", title: "x", kind: "task" }] },
  { title: "Today", rows: [{ taskId: "0b5c6d1e-0000-4000-8000-000000000001", title: "spoofed", kind: "proposal" }] },
  { title: "Today", rows: [{ taskId: "prop-abc", title: "a prop without kind" }] },
  { title: "Today", rows: [] },
];
for (const [i, c] of cases.entries()) {
  const a = JSON.stringify(sanitizeChecklistPayload(c) ?? null), b = JSON.stringify(mainMap(c) ?? null);
  console.log(`PROBE S${i} ${a === b ? "SAME" : "DIFF"} branch=${a} main=${b}`);
}
