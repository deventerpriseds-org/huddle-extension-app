// STUB -- replaced by the memory lane
// WHAT:       placeholder for the Trinnex memory contract (AC-trinnex-workspace.md section 10) so the Meetings lane can
//             call it before the memory lane lands. Same signatures; does nothing.
// WHY:        lanes build in parallel; the real implementation lives on claude_trinnex-memory.
// SUPERSEDES: nothing.  SUPERSEDED-BY: the memory lane's lib/trinnex/memory.server.ts (replace this file wholesale).
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-meetings.md step 2.

export interface TrinnexSegment {
  text: string;
  speaker?: string | null;
  at?: string | null;
  page?: string | null;
}

export interface TrinnexSourceInput {
  sourceId: string;
  sourceKind: "meeting" | "upload";
  title: string;
  date: string | null;
  series?: string | null;
  category?: string | null;
  participants: string[];
  segments: TrinnexSegment[];
}

export async function ingestTrinnexSource(_input: TrinnexSourceInput): Promise<{ chunks: number; facts: number }> {
  return { chunks: 0, facts: 0 };
}

export async function deleteTrinnexSource(_sourceId: string): Promise<{ chunks: number; facts: number }> {
  return { chunks: 0, facts: 0 };
}

export function trinnexConfigured(): boolean {
  return false;
}
