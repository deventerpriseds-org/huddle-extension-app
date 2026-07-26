// ACT-5 gate 1 — agent auto-work (research). On a cadence (the same every-minute scheduler that drives
// grooming/reminders), for each of a user's OPEN, ASSIGNED, non-blocked backlog tasks that hasn't been
// researched yet, the assigned agent runs a Tavily web search and DEPOSITS a documented artifact linked
// to the task (status 'review' — "delivered, awaiting your response"). A single detailed summary is then
// posted in the coordinator's DM as a durable turn — which rides the existing send_push away-notification
// (no new sender). Bounded per pass, idempotent (a task already backed by an artifact is skipped, so the
// backlog rotates through across fires), and a no-op when there's nothing new to do.
//
// This is the CORE loop only. The triage/channel layer (urgency → call/push/chat/standup/email) is a
// separate increment; today the summary rides the standard durable-turn → send_push path like grooming.

import { backlogSignature } from "./grooming.server";
import { AGENT_BY_ID, type AgentId } from "../../data/agents";
import type { BoardTaskRow } from "./tasks.server";

type Caller = { entra_object_id?: string; entra_email?: string };

export interface AutoWorkRunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  researched?: number; // artifacts deposited this pass
  blocked?: number; // grooming-flagged blocked items surfaced
  remaining?: number; // candidates left for the next fire
  runId: string;
}

// Live web calls + blob writes per task, and the summary turn runs inline — keep the pass small so it
// stays well under the function ceiling and can't rate-limit Tavily; the rest rotates in next fire.
const AUTOWORK_MAX = 6;
const COORDINATOR: AgentId = "terry-locke"; // hosts the consolidated summary (scrum master)

function agentName(id: string | null): string {
  return (id && AGENT_BY_ID[id as AgentId]?.name) || id || "An agent";
}

interface Researched {
  taskId: string;
  title: string;
  agentId: string | null;
  finding: string; // Tavily's synthesized answer (the substance of the chat summary)
  sourceCount: number;
  deepLink: string;
}

/** Build the markdown document deposited as the artifact for a researched task. */
function buildResearchMarkdown(
  task: BoardTaskRow,
  answer: string,
  results: { title: string; url: string; content: string }[],
): string {
  const lines: string[] = [
    `# ${task.title}`,
    ``,
    `> Auto-research by ${agentName(task.assigned_agent)}${task.category ? ` · ${task.category}` : ""}. ` +
      `Draft for your review — reply or approve to act on it.`,
    ``,
    `## Findings`,
    ``,
    answer.trim() || "_No synthesized answer was returned._",
    ``,
    `## Sources`,
    ``,
  ];
  if (results.length) {
    for (const r of results) {
      const snippet = (r.content || "").replace(/\s+/g, " ").trim().slice(0, 320);
      lines.push(`- [${r.title || r.url}](${r.url})${snippet ? ` — ${snippet}` : ""}`);
    }
  } else {
    lines.push("_No sources returned._");
  }
  lines.push("");
  return lines.join("\n");
}

// The durable-turn payload `text` is capped at 4000 chars (turn schema). The brief is EMBEDDED in the
// directive prose (~700 chars), so keep the brief itself well under that; the full detail lives in each
// artifact, which the message links to. Per-finding excerpt is bounded, and the whole brief is truncated.
const MAX_FINDING = 240;
const MAX_BRIEF = 2600;

/** Compact, detail-rich brief handed to the coordinator to relay (full detail is in the linked docs). */
function buildBrief(done: Researched[], blocked: { title: string }[], remaining: number): string {
  const lines: string[] = [];
  if (done.length) {
    lines.push(`Research completed this pass (${done.length}) — each saved as a document for review:`);
    for (const d of done) {
      const finding = d.finding.replace(/\s+/g, " ").trim().slice(0, MAX_FINDING);
      lines.push(`- "${d.title}" (owner: ${agentName(d.agentId)}) — ${finding} [${d.sourceCount} sources; doc: ${d.deepLink}]`);
    }
  }
  if (blocked.length) {
    lines.push("");
    lines.push(`Blocked pending your input (${blocked.length}) — the team can't proceed without you:`);
    for (const b of blocked) lines.push(`- "${b.title.slice(0, 120)}"`);
  }
  if (remaining > 0) lines.push("", `${remaining} more assigned task(s) queued for the next pass.`);
  const brief = lines.join("\n");
  return brief.length > MAX_BRIEF ? `${brief.slice(0, MAX_BRIEF)}\n…(trimmed; full detail in the linked docs)` : brief;
}

/**
 * Post ONE consolidated, detailed summary in the coordinator's DM as a durable turn and run it inline so
 * send_push fires now. Idempotent id so a retried cadence fire can't double-post. REPORT-ONLY directive —
 * the research is already saved; the coordinator must not call any tool.
 */
async function surfaceSummary(opts: {
  email: string;
  tz: string;
  caller: Caller;
  brief: string;
  runId: string;
}): Promise<void> {
  const directive =
    `You (Terry Locke, coordinator) are relaying the results of an AUTOMATIC work pass — the team ` +
    `researched several of the user's assigned tasks on a schedule; the user did NOT ask just now. ` +
    `Here is exactly what happened:\n\n${opts.brief}\n\n` +
    `Relay this to the user in your own voice as a single message with AS MUCH USEFUL DETAIL as the ` +
    `findings above contain — summarize each item's key takeaway (don't just say "done, see doc"), ` +
    `name who did it, and point to the saved document. Then clearly flag anything blocked pending their ` +
    `input and ask them to weigh in. This is a REPORT-ONLY turn: the work and documents are already ` +
    `saved, so under NO circumstances call any tool (no research, no task writes), and do not paste raw JSON.`;

  const payload = {
    text: directive,
    huddleId: `dm-${COORDINATOR}`,
    scope: "one-to-one",
    members: [COORDINATOR],
    targetAgentId: COORDINATOR,
    history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { [COORDINATOR]: { backend: "openai", journey: { enabled: true } } },
    timeZone: opts.tz,
    caller: opts.caller,
  };
  const id = `autowork-summary-${opts.runId}`;
  const { enqueueTurn } = await import("./turns.server");
  const fresh = await enqueueTurn(id, `dm-${COORDINATOR}`, opts.email, payload);
  if (fresh) {
    const { runTurnById } = await import("../huddle.functions");
    await runTurnById(id); // run inline to completion so send_push fires now
  }
}

/**
 * Run one auto-work pass for a user. Selects open, assigned, non-blocked tasks that don't yet have an
 * artifact, researches up to AUTOWORK_MAX of them (Tavily → documented artifact), surfaces the grooming-
 * flagged blocked items, and posts one detailed summary + push. A no-op when there's nothing new to do
 * (unless force'd). Never throws — returns a result the route/scheduler reports.
 */
export async function runScheduledAutoWork(
  caller: Caller | undefined,
  opts: { timeZone?: string; force?: boolean; runId?: string } = {},
): Promise<AutoWorkRunResult> {
  const runId =
    opts.runId?.trim() || `autowork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!caller?.entra_email) return { ok: false, skipped: true, reason: "missing_caller_email", runId };

  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller)) ?? caller.entra_email;
  const tz = opts.timeZone ?? "America/New_York";

  const { getOpenAssignedTasks, getBoardTasks, setAutoWorkSignature } = await import("./tasks.server");
  const { listArtifacts, createArtifact } = await import("../artifacts/artifacts.server");
  const { tavilySearch } = await import("../tavily-search.functions");

  const assigned = await getOpenAssignedTasks(email);
  const signature = backlogSignature(assigned);

  // Idempotency + rotation: a task already backed by an artifact is "done" — skip it. This is what makes
  // the bounded pass rotate through the backlog across fires WITHOUT a coarse signature gate (which would
  // strand the tail of a large-but-unchanged backlog). One artifact list read, not one-per-task.
  const existing = await listArtifacts(email);
  const withArtifact = new Set(existing.map((a) => a.task_id).filter(Boolean) as string[]);
  const candidates = assigned.filter((t) => !withArtifact.has(t.id));

  // Grooming-flagged blocked items (it TAGS blocked, doesn't set status), surfaced so they're never dropped.
  const board = await getBoardTasks(email);
  const blocked = board.filter(
    (t) => !t.completed_at && (t.tags ?? []).includes("blocked-on-capability"),
  );

  if (!candidates.length && !opts.force) {
    await setAutoWorkSignature(email, signature);
    // If there are blocked items still pending, we already surfaced them in prior passes; don't re-ping.
    return { ok: true, skipped: true, reason: assigned.length ? "nothing_new" : "empty", researched: 0, blocked: blocked.length, remaining: 0, runId };
  }

  const batch = candidates.slice(0, AUTOWORK_MAX);
  const done: Researched[] = [];
  for (const task of batch) {
    let res;
    try {
      res = await tavilySearch({ query: task.title, search_depth: "advanced", max_results: 5 });
    } catch {
      continue; // soft failure — leave the task for a later pass (a search error is NOT a blocked-capability)
    }
    if (!res.success) continue; // e.g. TAVILY_API_KEY unset → the whole pass is a no-op for everyone
    const results = (res.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content }));
    const markdown = buildResearchMarkdown(task, res.answer, results);
    try {
      const { deepLink } = await createArtifact({
        userEmail: email,
        agentId: task.assigned_agent,
        taskId: task.id,
        folder: task.category || "Research",
        name: `${task.title.slice(0, 80)} — research.md`,
        mime: "text/markdown",
        bytes: Buffer.from(markdown, "utf8"),
      });
      done.push({
        taskId: task.id,
        title: task.title,
        agentId: task.assigned_agent,
        finding: res.answer,
        sourceCount: results.length,
        deepLink,
      });
    } catch {
      continue; // deposit failed — leave the task (no artifact means it's retried next pass)
    }
  }

  await setAutoWorkSignature(email, signature);
  const remaining = Math.max(0, candidates.length - done.length);

  // Nothing produced and nothing blocked → no ping (avoid "nothing happened" noise).
  if (!done.length && !blocked.length) {
    return { ok: true, skipped: false, researched: 0, blocked: 0, remaining, runId };
  }

  await surfaceSummary({ email, tz, caller, brief: buildBrief(done, blocked, remaining), runId });
  return { ok: true, skipped: false, researched: done.length, blocked: blocked.length, remaining, runId };
}
