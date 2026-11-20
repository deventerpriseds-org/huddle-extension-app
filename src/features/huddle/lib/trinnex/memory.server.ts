// STUB -- replaced by the memory lane
//
// WHAT:       placeholder for the Trinnex memory contract (AC-trinnex-workspace.md section 10), so the Library
//             lane can build and test against the exact signatures before the memory lane lands.
// WHY:        the three lanes run in parallel; the Library calls only these three functions.
// SUPERSEDES: nothing.  SUPERSEDED-BY: the memory lane's memory.server.ts (take THEIRS on merge).
// EVIDENCE:   docs/qc-evidence/AC-trinnex-workspace.md section 10; docs/qc-evidence/BUILD-trinnex-library.md.
//
// Behaviour of the stub: nothing is stored, every count is zero, and trinnexConfigured() is false, so the
// Library marks items "Waiting for Trinnex memory" instead of pretending they are searchable.

export interface TrinnexIngestInput {
  sourceId: string;
  sourceKind: "meeting" | "upload";
  title: string;
  date: string | null;
  series?: string | null;
  category?: string | null;
  participants: string[];
  segments: Array<{ text: string; speaker?: string | null; at?: string | null; page?: string | null }>;
}

export async function ingestTrinnexSource(_input: TrinnexIngestInput): Promise<{ chunks: number; facts: number }> {
  return { chunks: 0, facts: 0 };
}

export async function deleteTrinnexSource(_sourceId: string): Promise<{ chunks: number; facts: number }> {
  return { chunks: 0, facts: 0 };
}

export function trinnexConfigured(): boolean {
  return false;
}
