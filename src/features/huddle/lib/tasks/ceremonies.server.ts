// Server-side ceremony runner. Invokes the grounded scrum ceremony via the shared
// runHuddleTurn core (same path the keyword trigger uses) and persists the transcript so an
// auto-run or past run is reviewable later. Called by the scheduled-ceremony public route.

import { AGENTS, type AgentId } from "../../data/agents";
import type { CeremonyType } from "./ceremonies";
import { runHuddleTurn } from "../huddle.functions";
import { recordCeremonyRun } from "./tasks.server";

export type CeremonyRunType = CeremonyType | "review_retro";
export type CeremonyMode = "round-robin" | "narrate";

// Phrases that detectCeremony() matches — this is how a scheduled run triggers the ceremony
// path inside runHuddleTurn without a human message.
const TRIGGER: Record<CeremonyType, string> = {
  standup: "let's run the daily stand-up",
  retro: "let's run the sprint retrospective",
  planning: "let's do sprint planning",
  review: "let's run the sprint review",
};

export interface CeremonyReply {
  agentId: string;
  text: string;
}
export interface CeremonyRunResult {
  ceremonyType: CeremonyRunType;
  mode: CeremonyMode;
  transcript: CeremonyReply[];
  summary: string;
}

function activeMembers(): AgentId[] {
  return AGENTS.map((a) => a.id);
}

function agentsConfig(members: AgentId[]): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  for (const id of members) cfg[id] = { backend: "openai", journey: { enabled: true } };
  return cfg;
}

async function runOne(
  type: CeremonyType,
  userEmail: string,
  mode: CeremonyMode,
  timeZone: string,
): Promise<CeremonyReply[]> {
  const members = activeMembers();
  const result = await runHuddleTurn({
    text: TRIGGER[type],
    huddleId: "ceremony",
    scope: "group",
    members,
    history: [],
    router: {
      backend: "openai",
      model: "gpt-4o-mini",
      soloOnCoverage: false,
      interjections: false,
      ceremonyMode: mode,
    },
    agents: agentsConfig(members),
    caller: { entra_email: userEmail },
    timeZone,
  } as Parameters<typeof runHuddleTurn>[0]);
  return (result.replies ?? []).map((r) => ({ agentId: String(r.agentId), text: String(r.text) }));
}

/**
 * Run a scheduled/triggered ceremony end-to-end and persist it. `review_retro` runs the review
 * section then the retro in one thread (the Friday combined meeting).
 */
export async function runScheduledCeremony(opts: {
  runId: string;
  ceremonyType: CeremonyRunType;
  userEmail: string;
  mode?: CeremonyMode;
  autoRun?: boolean;
  timeZone?: string;
}): Promise<CeremonyRunResult> {
  const mode = opts.mode ?? "round-robin";
  const tz = opts.timeZone ?? "America/New_York";
  let transcript: CeremonyReply[];
  if (opts.ceremonyType === "review_retro") {
    const review = await runOne("review", opts.userEmail, mode, tz);
    const retro = await runOne("retro", opts.userEmail, mode, tz);
    transcript = [...review, ...retro];
  } else {
    transcript = await runOne(opts.ceremonyType, opts.userEmail, mode, tz);
  }
  // The host's closing turn (last) is the natural summary; fall back to a placeholder.
  const summary = transcript.length
    ? transcript[transcript.length - 1].text.slice(0, 500)
    : "No activity to report this ceremony.";
  await recordCeremonyRun({
    id: opts.runId,
    user_email: opts.userEmail,
    ceremony_type: opts.ceremonyType,
    mode,
    status: "completed",
    summary,
    transcript,
    auto_run: !!opts.autoRun,
  });
  return { ceremonyType: opts.ceremonyType, mode, transcript, summary };
}
