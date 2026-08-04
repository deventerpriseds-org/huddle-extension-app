// Ceremony Phase 1 — "current-optimized" engine (ACT-huddle-18). Server-only.
//
// The CURRENT ceremony engine runs a per-agent server round-robin: one enqueueHuddleTurn turn per
// speaker, sequentially, each a full model call — so the user waits through repeated 25–40s gaps.
// This module is the optimized alternative (selected by config.ceremonyEngine === "current-optimized"):
//
//  1. CACHE-FRESH: read a per-agent standup-update TEXT cache keyed to backlogSignature(open tasks) —
//     the SAME signature grooming stamps in tasks.groom_state. If every slot for the current board
//     signature is cached, the ceremony speaks it straight to TTS with NO server round-robin.
//  2. CACHE-COLD: generate ALL slots in ONE parallel fan-out (concurrent Promise.all, the same shape as
//     dispatchGroomBacklog's Promise.all(chunks.map(classifyChunk))), grounded in the SAME lane facts the
//     round-robin uses — buildCeremonyReport + opener/owner/closer directives. On FULL success the cache
//     is filled (keyed to the signature); on ANY failure we return ok:false so the client degrades to the
//     round-robin — a failed slot is NEVER cached (no poisoning).
//
// TEXT only, never audio: the cloned ElevenLabs voice is picked at synth time by agentId, so the same
// cached line speaks in the right voice regardless of who reads it.

import { AGENTS, AGENT_BY_ID, type AgentId } from "../../data/agents";
import {
  buildCeremonyReport,
  lanesByOwner,
  roundRobinParticipants,
  ownerDirective,
  openerDirective,
  closerDirective,
  narrateDirective,
  CEREMONY_WINDOW_HOURS,
  CEREMONY_HOST,
  type CeremonyType,
  type CeremonyReport,
} from "./ceremonies";
import { getAssistantSnapshot } from "../openai-assistants.server";

type Caller = { entra_object_id?: string; entra_email?: string };

/** One spoken slot in the ceremony script, in speaking order. `slot` is the stable cache key. */
export interface CeremonySlot {
  slot: string; // "opener" | "owner:<agentId>" | "closer" | "narrate"
  agentId: AgentId;
  text: string;
}

export interface CeremonyScriptResult {
  ok: boolean;
  engine?: "cache" | "generated";
  slots?: { agentId: AgentId; text: string }[];
  reason?: string;
}

const GEN_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);
}

/** The ordered slots + their grounding directives for a ceremony, mirroring huddle.functions.ts's
 *  round-robin assembly (opener → lane owners → closer, or a single narrate turn when no lanes). */
function planSlots(
  type: CeremonyType,
  report: CeremonyReport,
  members: AgentId[],
): { slot: string; agentId: AgentId; directive: string }[] {
  const hostPresent = members.includes(CEREMONY_HOST);
  // Participant set is derived from the SHARED roundRobinParticipants (identical to huddle.functions.ts's
  // round-robin), so both engines yield the SAME who-speaks / order / handoff / closer (AC-R1). F9 —
  // speakingOwners drops truly-nothing owners (and done-only owners for a stand-up).
  const participants = roundRobinParticipants(report, members);
  const speakingOwners = participants.filter((p) => p !== CEREMONY_HOST);
  // No owner with live work → the scrum master narrates the whole thing solo (same as the round-robin's
  // narrate branch). Falls back to the first member if the host isn't in the room.
  if (speakingOwners.length === 0) {
    const host = hostPresent ? CEREMONY_HOST : members[0];
    if (!host) return [];
    return [{ slot: "narrate", agentId: host, directive: narrateDirective(type, report) }];
  }
  const owners = lanesByOwner(report);
  const handoffNames = participants
    .filter((p) => p !== CEREMONY_HOST)
    .map((p) => AGENT_BY_ID[p]?.name ?? p);
  const out: { slot: string; agentId: AgentId; directive: string }[] = [];
  for (const p of participants) {
    if (p === CEREMONY_HOST) {
      out.push({ slot: "opener", agentId: p, directive: openerDirective(type, report, handoffNames) });
    } else {
      const lane = owners.get(p);
      if (lane) out.push({ slot: `owner:${p}`, agentId: p, directive: ownerDirective(type, lane) });
    }
  }
  // The host closes after every owner has spoken (only when present AND at least one owner reported —
  // participants = [host, ...owners], so length > 1). Mirrors ceremonyCloser in huddle.functions.ts.
  if (hostPresent && participants.length > 1) {
    out.push({ slot: "closer", agentId: CEREMONY_HOST, directive: closerDirective(type, report) });
  }
  return out;
}

/** Generate ONE agent's spoken line for its ceremony directive. System = the agent's canonical snapshot
 *  instructions (fallback: in-repo persona) so it sounds like that agent; the directive already carries
 *  the real board facts + the "1–2 natural spoken sentences" framing. Throws on any failure so the caller
 *  can treat the slot as failed (and NOT cache it). */
async function generateSlot(agentId: AgentId, directive: string, apiKey: string): Promise<string> {
  const snap = getAssistantSnapshot(agentId);
  const persona = snap?.instructions?.trim() || AGENT_BY_ID[agentId]?.systemPrompt || "";
  const system =
    persona +
    "\n\nYou are speaking OUT LOUD in a live scrum ceremony. Reply with ONLY the words you would say — " +
    "no markdown, no headers, no bullet lists, no stage directions. 1–2 natural spoken sentences.";
  const res = await withTimeout(
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.CEREMONY_MODEL || "gpt-4o-mini",
        temperature: 0.6,
        messages: [
          { role: "system", content: system },
          { role: "user", content: directive },
        ],
      }),
    }),
    GEN_TIMEOUT_MS,
    `ceremony gen (${agentId})`,
  );
  if (!res.ok) throw new Error(`ceremony gen ${res.status}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("ceremony gen empty");
  return text;
}

/** Resolve the canonical journey email + the two task views the ceremony needs, and derive the report +
 *  the board signature (over open tasks — identical to grooming's key so a grooming payoff hits here). */
async function loadCeremonyState(
  caller: Caller,
  type: CeremonyType,
): Promise<{ email: string; signature: string; report: CeremonyReport }> {
  const { resolveTaskEmail } = await import("../journey/identity");
  const email = (await resolveTaskEmail(caller)) ?? caller.entra_email!;
  const { getStandupTasks, getTasksForUser } = await import("./tasks.server");
  const { backlogSignature } = await import("./grooming.server");
  // Signature over the SAME open-task set grooming hashes (getTasksForUser), so the grooming payoff and
  // this read compute the same key. The report needs done/blocked too, so it uses getStandupTasks (which
  // already filters parking-lot at the source).
  const [openTasks, standupTasks] = await Promise.all([
    getTasksForUser(email),
    getStandupTasks(email, CEREMONY_WINDOW_HOURS[type]),
  ]);
  const signature = backlogSignature(openTasks);
  const report = buildCeremonyReport(type, standupTasks);
  return { email, signature, report };
}

/**
 * The client entry point (via the getCeremonyScript server fn): return the ready-to-speak ceremony
 * script for the current-optimized engine — cache-fresh if available, else a fan-out generation that
 * fills the cache. Returns ok:false on anything the client should fall back to the round-robin for
 * (no account, no participants, not configured, or a partial/failed generation).
 */
export async function resolveCeremonyScript(
  caller: Caller | undefined,
  type: CeremonyType,
  members: AgentId[],
): Promise<CeremonyScriptResult> {
  if (!caller?.entra_email) return { ok: false, reason: "no_account" };
  const { email, signature, report } = await loadCeremonyState(caller, type);
  const planned = planSlots(type, report, members);
  if (!planned.length) return { ok: false, reason: "no_participants" };

  // 1) Cache-fresh: every planned slot present at the current signature → speak it straight to TTS.
  const { getStandupCache, setStandupCache } = await import("./tasks.server");
  const cached = await getStandupCache(email, type, signature).catch(() => []);
  const bySlot = new Map(cached.map((c) => [c.slot, c]));
  if (planned.every((p) => bySlot.has(p.slot))) {
    return {
      ok: true,
      engine: "cache",
      slots: planned.map((p) => {
        const c = bySlot.get(p.slot)!;
        return { agentId: c.agent_id as AgentId, text: c.update_text };
      }),
    };
  }

  // 2) Cache-cold: ONE parallel fan-out over all slots.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, reason: "not_configured" };
  const results = await Promise.all(
    planned.map(async (p) => {
      try {
        return { ...p, text: await generateSlot(p.agentId, p.directive, apiKey) };
      } catch {
        return { ...p, text: null as string | null };
      }
    }),
  );
  // Any slot failed → do NOT cache a partial script (no poisoning); degrade to the round-robin so no
  // agent is dropped.
  if (results.some((r) => !r.text)) return { ok: false, reason: "partial_generation" };
  await setStandupCache(
    email,
    type,
    signature,
    results.map((r) => ({ slot: r.slot, agentId: r.agentId, text: r.text! })),
  ).catch(() => {});
  return { ok: true, engine: "generated", slots: results.map((r) => ({ agentId: r.agentId, text: r.text! })) };
}

/**
 * Grooming payoff (called from runScheduledGrooming in the SAME pass that stamps setGroomSignature):
 * pre-generate + cache the FULL standup script keyed to the signature grooming just computed, so the
 * next current-optimized stand-up is cache-fresh (~1s to first voice, no fan-out). Best-effort — the
 * caller wraps it non-fatally, and a miss just means the ceremony cold-path regenerates. Uses the whole
 * agent roster as members (a stand-up's default room); only a FULLY successful script is cached.
 */
export async function refreshStandupCacheFromGroom(email: string, signature: string): Promise<void> {
  const type: CeremonyType = "standup";
  const { getStandupTasks, setStandupCache } = await import("./tasks.server");
  const standupTasks = await getStandupTasks(email, CEREMONY_WINDOW_HOURS[type]);
  const report = buildCeremonyReport(type, standupTasks);
  const members = AGENTS.map((a) => a.id);
  const planned = planSlots(type, report, members);
  if (!planned.length) return;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  const results = await Promise.all(
    planned.map(async (p) => {
      try {
        return { ...p, text: await generateSlot(p.agentId, p.directive, apiKey) };
      } catch {
        return { ...p, text: null as string | null };
      }
    }),
  );
  if (results.some((r) => !r.text)) return; // don't cache a partial script
  await setStandupCache(
    email,
    type,
    signature,
    results.map((r) => ({ slot: r.slot, agentId: r.agentId, text: r.text! })),
  );
}
