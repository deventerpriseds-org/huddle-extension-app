// WHAT:       Reads what the open-items report needs from Azure PG: every stored correspondence row with content
//             (email, teams, sent, transcript) for the owner, and the owner's RESOLUTION signals (task proposals in a
//             decided state with their source refs; dismissed bell rows). Read-only, no writes, no DDL.
// WHY:        Owner 2026-11-16: the report must run "against the table that has everything since Monday" and leave out
//             only what he signalled ignored / added as a task. Pure rules: report-from-ledger.ts.
//             THIS REPO'S LOGS ARE PUBLIC: this module returns rows to the caller and never logs; the caller prints
//             counts only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-report-from-ledger.md.
import { getSharedPool } from "../db/shared-pool.server";
import type { BellSignalRow, LedgerReportRow, ProposalSignalRow } from "./report-from-ledger";
import { RESOLVED_BELL_STATUSES, RESOLVED_PROPOSAL_STATES } from "./report-from-ledger";

export interface LedgerReportData {
  rows: LedgerReportRow[];
  proposals: ProposalSignalRow[];
  bell: BellSignalRow[];
  /** A signal store that could not be read (its table absent or the query failed): NOTHING is excluded on its
   *  account, and the caller says so in the report. */
  unavailable: ("task_proposals" | "bell")[];
  /** A signal store whose tables do not exist yet (never used): no signals from it, which is not a failure. */
  notCreated: "task_proposals"[];
}

/** Read every stored row (content not purged) for these owner logins. Transcripts from the minutes flow may be stored
 *  under the minutes owner, so transcripts are read for every owner (single-owner deployment). The window is applied
 *  in code (report-from-ledger.ts inReportWindow), so an in-window conversation keeps its older messages as context. */
export async function loadLedgerReportData(ownerLogins: readonly string[]): Promise<LedgerReportData> {
  const pool = getSharedPool();
  const owners = [...new Set(ownerLogins.map((o) => String(o ?? "").trim().toLowerCase()).filter(Boolean))];
  const r = await pool.query<{ source: LedgerReportRow["source"]; source_item_id: string; thread_id: string | null; item_at: Date | null; content: LedgerReportRow["content"] }>(
    `SELECT source, source_item_id, thread_id, item_at, content FROM chat.correspondence_ledger
      WHERE content IS NOT NULL AND content_purged_at IS NULL
        AND (owner_email = ANY($1::text[]) OR source = 'transcript')`,
    [owners],
  );
  const rows: LedgerReportRow[] = r.rows.map((x) => ({
    source: x.source,
    sourceItemId: x.source_item_id,
    threadId: x.thread_id,
    at: x.item_at ? x.item_at.toISOString() : null,
    content: x.content,
  }));
  const unavailable: LedgerReportData["unavailable"] = [];
  let proposals: ProposalSignalRow[] = [];
  const notCreated: LedgerReportData["notCreated"] = [];
  try {
    // Measured 2026-11-16: the proposals tables do not exist on the live DB yet (the feature has never run), which
    // is "no signals", not a read failure. Checked first so the report says the true thing.
    const ex = await pool.query<{ ok: boolean }>(
      `SELECT (to_regclass('chat.task_proposals') IS NOT NULL AND to_regclass('chat.task_proposal_refs') IS NOT NULL) AS ok`,
    );
    if (!ex.rows[0]?.ok) notCreated.push("task_proposals");
  } catch {
    /* fall through: the read below reports unavailable */
  }
  if (!notCreated.includes("task_proposals")) try {
    const p = await pool.query<{ source: string; source_item_id: string; norm_title: string; state: string; decided_at: Date | null }>(
      `SELECT rf.source, rf.source_item_id, rf.norm_title, p.state, COALESCE(p.decided_at, p.updated_at) AS decided_at
         FROM chat.task_proposal_refs rf JOIN chat.task_proposals p ON p.id = rf.proposal_id
        WHERE rf.owner_email = ANY($1::text[]) AND p.state = ANY($2::text[])`,
      [owners, [...RESOLVED_PROPOSAL_STATES]],
    );
    proposals = p.rows.map((x) => ({ source: x.source, sourceItemId: x.source_item_id, normTitle: x.norm_title, state: x.state, decidedAt: x.decided_at ? x.decided_at.toISOString() : null }));
  } catch {
    unavailable.push("task_proposals");
  }
  let bell: BellSignalRow[] = [];
  try {
    const b = await pool.query<{ kind: string; graph_message_id: string; conversation_id: string | null; status: string; received_at: Date | null }>(
      `SELECT kind, graph_message_id, conversation_id, status, received_at FROM chat.email_replies
        WHERE owner_email = ANY($1::text[]) AND kind IN ('email','chat') AND status = ANY($2::text[])`,
      [owners, [...RESOLVED_BELL_STATUSES]],
    );
    bell = b.rows.map((x) => ({ kind: x.kind, graphMessageId: x.graph_message_id, conversationId: x.conversation_id, status: x.status, receivedAt: x.received_at ? x.received_at.toISOString() : null }));
  } catch {
    unavailable.push("bell");
  }
  return { rows, proposals, bell, unavailable, notCreated };
}
