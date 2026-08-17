import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { AGENTS, AGENT_BY_ID, type Agent, type AgentId } from "../data/agents";
import { ownershipMarker } from "./capabilities";
import { resolveAddressedAgent } from "./addressedAgent";
import type { HuddleMessage, RoutingDecision } from "../data/seed";

// stem match — first 5 chars, word-boundary
function stem(w: string) {
  return w.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);
}
function tokens(text: string) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreAgentAgainst(text: string, agent: Agent): number {
  const textTokens = tokens(text);
  const textStems = new Set(textTokens.map(stem).filter((s) => s.length >= 3));
  let hits = 0;
  let total = 0;
  // domains carry more weight than themes/role
  const weighted: Array<{ kw: string; w: number }> = [
    ...agent.domains.map((kw) => ({ kw, w: 3 })),
    ...agent.themes.map((kw) => ({ kw, w: 1 })),
    { kw: agent.role, w: 1 },
  ];
  for (const { kw, w } of weighted) {
    for (const part of kw.split(/\s+/)) {
      const s = stem(part);
      if (s.length < 3) continue;
      total += w;
      if (textStems.has(s)) hits += w * 2;
    }
  }
  const raw = hits / Math.max(8, total);
  return Math.min(1, raw);
}

/**
 * Broadcast intent — the user is addressing the whole room ("everyone introduce
 * yourselves", "go around one by one"), so every member should respond, not just
 * the top-scored specialist.
 */
export function isBroadcast(text: string): boolean {
  return /\b(everyone|everybody|every one|each of you|all of you|y'?all|one by one|go around|round[- ]?robin|whole team|entire team|each of the agents|each person|introduce yoursel(f|ves)|say your name|share your name)\b/i.test(
    text,
  );
}

export function parseMentions(text: string, agents: Agent[]): AgentId[] {
  const found = new Set<AgentId>();
  const lower = text.toLowerCase();
  for (const a of agents) {
    const handle = `@${a.handle}`;
    const firstName = a.name.split(" ")[0].toLowerCase();
    if (lower.includes(handle)) found.add(a.id);
    else if (new RegExp(`@${firstName}\\b`, "i").test(text)) found.add(a.id);
  }
  return [...found];
}

export interface RouteInput {
  text: string;
  scope: "one-to-one" | "group" | "call";
  members: AgentId[];
  history: HuddleMessage[];
  targetAgentId?: AgentId;
  /**
   * Ceremony-barge context. When `ceremonyBarge` is set, routing runs the deterministic
   * barge quick-route FIRST (named agent → @mention → interlocutor), and only falls to the
   * semantic LLM route when nothing resolves. `interlocutorId` is who currently holds the
   * floor (the agent just speaking / most-recently spoke) — an un-named barge is directed at
   * THEM (the movie-pause model), never a topic/capability grab.
   */
  ceremonyBarge?: boolean;
  interlocutorId?: AgentId;
}

export interface RouteResult {
  decision: Omit<RoutingDecision, "id" | "messageId" | "ts">;
  winners: AgentId[]; // ordered; primary first
  /**
   * Agents who likely hold SPECIFIC, substantive value to add beyond the
   * primary's answer (a scheduling conflict, prep notes, a warning) — not mere
   * topical adjacency. Only used when the interjections toggle is on; each still
   * self-censors (passes) if it turns out it has nothing concrete.
   */
  interjectors?: AgentId[];
  /** LLM-router difficulty (1-4) for the latest message; drives per-turn model/effort. Absent on the
   *  keyword fallback (treat as 2 = standard downstream). */
  difficulty?: number;
}

/**
 * Deterministic ceremony-barge resolution — the UNIFIED quick track. Returns a single-responder
 * RouteResult with NO LLM call when it can, or null when the caller should run the full semantic
 * route. This is the one place the "quick vs complex" decision lives (it replaces the old
 * huddle.functions.ts fast-path bypass that skipped the router entirely). Order:
 *   1. A present agent NAMED anywhere in the barge (STT-tolerant, all tokens — via the shared
 *      resolveAddressedAgent, with the interlocutor as the fuzzy anchor/tiebreak). "…Finn, are you
 *      here?" → Finn, with zero LLM latency. This is the fix for "user says Finn, Terry answers".
 *   2. An explicit @mention.
 *   3. No name resolved → the interlocutor (whoever holds the floor). An un-named barge is a
 *      pause-and-continue directed at the current speaker — NEVER a topic/capability grab (the
 *      "why was Faith talking" regression guard).
 *   4. No name AND no known interlocutor (rare — a barge in the opening beat) → null, so the caller
 *      runs the full LLM route.
 * Returns null for any non-barge input, so normal group/1:1 routing is completely untouched.
 */
export function bargeQuickRoute(input: RouteInput): RouteResult | null {
  if (!input.ceremonyBarge) return null;
  const present = AGENTS.filter((a) => input.members.includes(a.id));
  if (present.length === 0) return null;

  const single = (id: AgentId, reason: string): RouteResult => ({
    winners: [id],
    interjectors: [],
    decision: {
      signal: "mention",
      scores: { [id]: 1 } as Partial<Record<AgentId, number>>,
      winnerId: id,
      runnerUpId: null,
      interjected: false,
      reason,
    },
  });

  // 1. Named agent — the authoritative addressed-by-name pick (shared resolver, all tokens).
  const presentMembers = present.map((a) => ({ id: a.id, firstName: a.name.split(" ")[0] }));
  const addressed = resolveAddressedAgent(input.text, presentMembers, input.interlocutorId ?? null);
  if (addressed.kind === "agent" && input.members.includes(addressed.agentId as AgentId)) {
    return single(addressed.agentId as AgentId, "ceremony barge → named agent (quick, no LLM)");
  }

  // 2. Explicit @mention.
  const mentioned = parseMentions(input.text, present).filter((id) => input.members.includes(id));
  if (mentioned.length > 0) {
    return single(mentioned[0], "ceremony barge → @mention (quick, no LLM)");
  }

  // 3. No name → hold the floor with the interlocutor (movie-pause model; anti-Faith-grab guard).
  if (input.interlocutorId && input.members.includes(input.interlocutorId)) {
    return single(input.interlocutorId, "ceremony barge → interlocutor (no name; hold the floor)");
  }

  // 4. No name, no interlocutor → let the caller run the full semantic route.
  return null;
}

export function routeMessage(input: RouteInput): RouteResult {
  const barge = bargeQuickRoute(input);
  if (barge) return barge;
  const { text, scope, members, history, targetAgentId } = input;
  const present = AGENTS.filter((a) => members.includes(a.id));

  // 1:1 — target always answers
  if (scope === "one-to-one" && targetAgentId) {
    return {
      winners: [targetAgentId],
      decision: {
        signal: "mention",
        scores: { [targetAgentId]: 1 },
        winnerId: targetAgentId,
        runnerUpId: null,
        interjected: false,
        reason: "1:1",
      },
    };
  }

  // 0. broadcast — the user addressed the whole room; everyone answers.
  if (scope === "group" && isBroadcast(text) && present.length > 0) {
    const all = present.map((a) => a.id);
    return {
      winners: all,
      decision: {
        signal: "mention",
        scores: Object.fromEntries(all.map((id) => [id, 1])) as Partial<
          Record<AgentId, number>
        >,
        winnerId: all[0],
        runnerUpId: all[1] ?? null,
        interjected: false,
        reason: "Broadcast — every member responds.",
      },
    };
  }

  // 1. explicit @mentions — all mentioned agents answer
  const mentions = parseMentions(text, present);
  if (mentions.length > 0) {
    return {
      winners: mentions.slice(0, 3),
      decision: {
        signal: "mention",
        scores: Object.fromEntries(mentions.map((m) => [m, 1])) as Partial<Record<AgentId, number>>,
        winnerId: mentions[0],
        runnerUpId: mentions[1] ?? null,
        interjected: false,
        reason: `Explicit mention.`,
      },
    };
  }

  // Score all present agents by topic
  const scores: Partial<Record<AgentId, number>> = {};
  const ranked: Array<{ id: AgentId; s: number }> = [];
  for (const a of present) {
    const s = scoreAgentAgainst(text, a);
    scores[a.id] = Number(s.toFixed(2));
    ranked.push({ id: a.id, s });
  }
  ranked.sort((a, b) => b.s - a.s);

  // 2. reply/thread stickiness — last agent turn keeps floor unless topic strongly points elsewhere
  const last = [...history].reverse().slice(0, 6);
  const lastAgentTurn = last.find((m) => m.author.kind === "agent");
  if (lastAgentTurn && lastAgentTurn.author.kind === "agent") {
    const holder = lastAgentTurn.author.agentId;
    const holderRank = ranked.find((r) => r.id === holder);
    const top = ranked[0];
    if (holderRank && top && (holderRank.s >= top.s - 0.1 || top.s < 0.1)) {
      const runner = ranked.find((r) => r.id !== holder);
      const winners: AgentId[] = [holder];
      if (runner && runner.s >= 0.2 && runner.s >= (holderRank.s - 0.15)) winners.push(runner.id);
      return {
        winners,
        decision: {
          signal: "reply",
          scores,
          winnerId: holder,
          runnerUpId: runner?.id ?? null,
          interjected: false,
          reason: "Thread continuation.",
        },
      };
    }
  }

  // 3. topic — take the top scorer plus any close runner-up
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (top && top.s > 0) {
    const winners: AgentId[] = [top.id];
    if (runnerUp && runnerUp.s >= 0.2 && top.s - runnerUp.s <= 0.15) {
      winners.push(runnerUp.id);
    }
    return {
      winners,
      decision: {
        signal: "topic",
        scores,
        winnerId: top.id,
        runnerUpId: runnerUp?.id ?? null,
        interjected: true,
        reason: `Topic match.`,
      },
    };
  }

  // 4. floor — the team lead (Iris, coordinator) picks it up as a person, not a
  // router; standup-host is kept as a higher-priority fallback if ever assigned.
  const lead =
    present.find((a) => a.special === "standup-host") ??
    present.find((a) => a.special === "coordinator") ??
    present[0];
  return {
    winners: lead ? [lead.id] : [],
    decision: {
      signal: "floor",
      scores,
      winnerId: lead?.id ?? null,
      runnerUpId: top?.id ?? null,
      interjected: false,
      reason: "Open floor.",
    },
  };
}

/**
 * Deterministic lane-owner detection for a single message, scored over the FULL roster (not just a
 * huddle's members). Makes 1:1 hand-off systematic by DOMAIN/THEME — not only exclusive tools: if the
 * addressed agent isn't the best-fit lane for the ask, name who is (e.g. "tighten my budget" → Finn),
 * so the agent can defer + bring them in. Returns null when the addressed agent is the (or a close)
 * owner, so in-lane asks never hand off. Driven entirely by agents.ts domains/themes — no hardcoding.
 */
export function laneOwnerFor(text: string, selfId: AgentId): { id: AgentId; score: number } | null {
  const ranked = AGENTS.map((a) => ({ id: a.id, s: scoreAgentAgainst(text, a) })).sort((x, y) => y.s - x.s);
  const top = ranked[0];
  if (!top) return null;
  const selfScore = ranked.find((r) => r.id === selfId)?.s ?? 0;
  // Hand off ONLY when another agent clearly owns the topic and the addressed agent does not.
  if (top.id !== selfId && top.s >= 0.25 && top.s - selfScore >= 0.15) {
    return { id: top.id, score: Number(top.s.toFixed(2)) };
  }
  return null;
}

/**
 * PURE winner-assembly — turns the LLM router's raw pick ({primary, supporting, explicitlyRequested})
 * plus the parsed @mentions into the final ordered winner set. Extracted so it can be unit-tested
 * OFFLINE with mocked router outputs (no OpenAI spend). The only external reads are AGENT_BY_ID +
 * scoreAgentAgainst (deterministic keyword scoring), so this is fully self-contained.
 */
export interface WinnerAssemblyInput {
  primary: AgentId;
  supporting: AgentId[];
  explicitlyRequested: AgentId[];
  mentions: AgentId[];
  memberIds: AgentId[];
  text: string;
  soloOnCoverage: boolean;
  /** Number of explicitly-labeled lanes the user enumerated (from countLaneLabels). Raises the winner
   * cap so every lane owner the router picked is kept on a genuine multi-lane list. 0 on normal turns. */
  explicitLaneCount?: number;
}
export interface WinnerAssemblyResult {
  winners: AgentId[];
  soloApplied: boolean;
  explicitKept: number;
  mentionedWinners: AgentId[];
}
export function assembleWinners(input: WinnerAssemblyInput): WinnerAssemblyResult {
  const { primary, supporting, mentions, memberIds, text, soloOnCoverage } = input;
  const explicitlyRequested = new Set(
    input.explicitlyRequested.filter((id) => memberIds.includes(id)),
  );
  const mentionSet = mentions.filter((id) => memberIds.includes(id));

  let winners: AgentId[];
  let soloApplied = false;
  let explicitKept = 0;
  const mentionedWinners: AgentId[] = [];

  if (mentionSet.length > 0) {
    // MENTION TURN: semantic PRIMARY (main-task owner) + @mentioned agents + any explicitly-NAMED
    // supporting agent. Adjacency (unnamed supporting) is dropped. Handoff "Tess, scope X, then @cole"
    // → primary tess + mention cole; bare "@cole how long?" → primary cole == mention → just Cole.
    winners = [primary];
    for (const id of supporting) {
      if (explicitlyRequested.has(id) && !winners.includes(id) && winners.length < 4) {
        winners.push(id);
        explicitKept++;
      }
    }
    for (const id of mentionSet) {
      if (!winners.includes(id) && winners.length < 4) winners.push(id);
    }
    mentionedWinners.push(...mentionSet.filter((id) => id !== primary));
  } else {
    // NORMAL TURN: semantic primary + supporting. soloOnCoverage drops adjacency when the primary
    // already covers the topic — but never a user-named collaborator (explicitlyRequested).
    winners = [primary];
    if (soloOnCoverage) {
      const primaryAgent = AGENT_BY_ID[primary];
      const primaryScore = primaryAgent ? scoreAgentAgainst(text, primaryAgent) : 0;
      if (primaryScore >= 0.15) soloApplied = true;
    }
    // Winner cap. Default 3 (kills adjacency pile-ons). For an explicit MULTI-LANE list — where the
    // user enumerated several lanes and the router marked each lane's owner explicitlyRequested — raise
    // the cap so every enumerated lane owner is kept (primary + N explicit owners), bounded at 6 for
    // latency. explicitlyRequested is ~0-1 on ordinary turns, so this never widens a normal turn.
    const cap = Math.min(
      6,
      Math.max(3, Math.max(explicitlyRequested.size, input.explicitLaneCount ?? 0) + 1),
    );
    for (const id of supporting) {
      if (
        !memberIds.includes(id) ||
        id === primary ||
        winners.includes(id) ||
        winners.length >= cap
      ) {
        continue;
      }
      if (soloApplied && !explicitlyRequested.has(id)) continue; // drop adjacency only
      if (soloApplied) explicitKept++;
      winners.push(id);
    }
  }
  return { winners, soloApplied, explicitKept, mentionedWinners };
}

/**
 * DETERMINISTIC multi-lane-list detector. Counts how many distinct labeled lanes the user enumerated —
 * lines shaped like a short label followed by a dash/colon then content ("Career - …", "Finance: …").
 * This is a purely structural signal (no keyword→agent guessing, which is unreliable because the user's
 * labels — "Finance", "Education" — don't match the owners' domain words), used to decide a message is a
 * genuine multi-lane brain-dump. When it is, the caller turns soloOnCoverage OFF for that turn so the
 * specialists the LLM router picked fan out (instead of being collapsed to the primary), and raises the
 * winner cap to fit every lane. A single-topic message returns <2 and is unaffected — soloOnCoverage
 * still kills adjacency pile-ons there. Pure + exported so it is unit-tested offline.
 */
export function countLaneLabels(text: string): number {
  let n = 0;
  for (const line of (text || "").split(/\r?\n/)) {
    // 1-3 words (letters, spaces, &, /) at line start, then - – — or :, then real content.
    if (/^\s*[A-Za-z][A-Za-z&/]*(?:\s+[A-Za-z&/]+){0,2}\s*[-–—:]\s+\S/.test(line)) n++;
  }
  return n;
}

/**
 * Resolve each enumerated lane of a multi-lane list to its OWNER, so the RIGHT specialists are guaranteed
 * to respond instead of being left to the LLM's inconsistent selection. For every labeled lane line, score
 * the whole line against each present agent with `scoreAgentAgainst` (the SAME roster-driven scorer the
 * router already uses — no hardcoded label→agent map, no parallel system) and take the best match above a
 * floor. Returns the distinct owner ids in lane order. Roster-driven and auto-scaling: a new agent with a
 * matching domain/theme is picked automatically, and mapping a new label word is done by enriching that
 * agent's `themes` in agents.ts. Returns [] when the message is not a multi-lane list (<2 labeled lanes).
 * Pure + exported for offline unit testing against the real roster.
 */
export function detectLaneOwners(text: string, present: readonly Agent[]): AgentId[] {
  const lines = (text || "")
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Za-z][A-Za-z&/]*(?:\s+[A-Za-z&/]+){0,2}\s*[-–—:]\s+\S/.test(l));
  if (lines.length < 2) return [];
  const owners: AgentId[] = [];
  for (const line of lines) {
    let bestId: AgentId | null = null;
    let best = 0;
    for (const a of present) {
      const s = scoreAgentAgainst(line, a);
      if (s > best) {
        best = s;
        bestId = a.id;
      }
    }
    if (bestId && best > 0 && !owners.includes(bestId)) owners.push(bestId);
  }
  return owners;
}

/**
 * LLM-based router. Picks a primary agent + optional supporting agents based
 * on the user's message and recent history. Falls back to the keyword
 * routeMessage() on any failure so we never block a reply.
 *
 * 1:1 and explicit @mentions short-circuit before this is called.
 */
export interface RouterInvocation {
  backend: "openai" | "lovable";
  model: string;
  fastMode?: boolean;
  /** #1 — tighten the router prompt to prefer a single primary agent. */
  strictPrompt?: boolean;
  /** #2 — drop supporting agents when the primary already covers the message. */
  soloOnCoverage?: boolean;
  /** When on, the router also nominates interjectors (substantive cross-domain value). */
  interjections?: boolean;
  /** Member ids that have journey tools (calendar/tasks/contacts) enabled. */
  journeyEnabledIds?: AgentId[];
  /** Lovable AI SDK model instance — required when backend === "lovable". */
  lovableModel?: Parameters<typeof generateText>[0]["model"];
}

/**
 * Lightweight, dedicated DIFFICULTY scorer (1-4) for turns that do NOT go through routeMessageLLM —
 * chiefly 1:1 DMs, which route deterministically (the responder is fixed) and so never get the router's
 * `difficulty`. Deep asks happen in DMs too, so the difficulty-driven model tier + Sol confirm-gate need
 * this signal there. This is an LLM call (dynamic, no keyword list — the same principle as the router),
 * kept tiny (one integer out) and cheap (runs on the router's model). Returns null on any failure so the
 * caller can fall back to a heuristic. Mirrors the router's LLM-primary / keyword-fallback split.
 */
export async function scoreDifficultyLLM(
  text: string,
  invocation: { backend: "openai" | "lovable"; model: string; fastMode?: boolean },
): Promise<number | null> {
  try {
    if (invocation.backend !== "openai") return null; // 1:1 difficulty only needed on the OpenAI path
    const { callOpenAIRouter } = await import("./openai-responses.server");
    const raw = await callOpenAIRouter<{ difficulty: number }>({
      model: invocation.model,
      system:
        "You rate how much reasoning rigor the BEST answer to a user's message needs — independent of who answers or how long the reply is.",
      prompt:
        "Rate difficulty 1-4 for the message below. 1 = routine (ack, quick fact, single simple action). " +
        "2 = standard (a normal substantive reply, a short draft, a simple plan). 3 = deep (multi-constraint " +
        "strategy, financial/analytical modeling, real research → a rigorous written deliverable). 4 = " +
        'exceptional rigor (rare). Return only {"difficulty": N}.\n\nMessage:\n"""' +
        (text || "").slice(0, 1500) +
        '"""',
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { difficulty: { type: "integer", enum: [1, 2, 3, 4] } },
        required: ["difficulty"],
      },
      schemaName: "difficulty_score",
      fastMode: invocation.fastMode,
    });
    const d = Math.round(raw?.difficulty ?? 0);
    return d >= 1 && d <= 4 ? d : null;
  } catch {
    return null;
  }
}

export async function routeMessageLLM(
  input: RouteInput,
  invocation: RouterInvocation,
): Promise<RouteResult> {
  // Ceremony barge → deterministic quick track FIRST (named agent / @mention / interlocutor), no LLM
  // call. Only a barge that resolves to NOTHING (no name, no interlocutor) falls through to the
  // semantic route below. Non-barge input returns null here and routes exactly as before.
  const barge = bargeQuickRoute(input);
  if (barge) return barge;

  const { text, scope, members, history, targetAgentId } = input;
  const present = AGENTS.filter((a) => members.includes(a.id));

  if (scope === "one-to-one" && targetAgentId) return routeMessage(input);
  const mentions = parseMentions(text, present);
  // Group + @mention: AUGMENT, don't replace. A mentioned agent is a hard request to include it (unioned
  // into winners below, never dropped), but we STILL run the semantic router so a prose-named work-owner
  // ("Tess, scope the MVP, then hand to @cole …") isn't dropped just because someone else was @mentioned.
  // Only a non-group mention short-circuits to the deterministic mention-only route; a group mention flows
  // through to the LLM router. Roster-driven → auto-scales as agents are added.
  if (mentions.length > 0 && scope !== "group") return routeMessage(input);
  // Broadcast → everyone answers; no need to ask the LLM who.
  if (scope === "group" && isBroadcast(text)) return routeMessage(input);

  const memberIds = present.map((a) => a.id) as [AgentId, ...AgentId[]];
  if (memberIds.length === 0) return routeMessage(input);

  const journeySet = new Set(invocation.journeyEnabledIds ?? []);
  const roster = present
    .map(
      (a) =>
        `- ${a.id} (${a.name}, ${a.role}): ${a.domains.join(", ")}${
          journeySet.has(a.id) ? " [has live calendar/tasks/contacts tools]" : ""
        }${ownershipMarker(a)}`,
    )
    .join("\n");

  const transcript = history
    .slice(-8)
    .filter((m) => m.author.kind !== "system")
    .map((m) => {
      if (m.author.kind === "user") return `User: ${m.text}`;
      const a =
        AGENT_BY_ID[(m.author as { kind: "agent"; agentId: AgentId }).agentId];
      return `${a.name}: ${m.text}`;
    })
    .join("\n");

  const baseSystem = `You are the router for a multi-agent huddle. Choose which agents should respond to the user's latest message based on intent and context — not just keywords. Prefer a single primary agent; add supporting agents only when their expertise is clearly needed. Never invent agent ids — only choose from the roster.
ADDRESSED BY NAME: if the user addresses an agent by name (e.g. "Cole, how long…", "Finn — …"), that agent IS the primary. Do NOT hand the lead to a different agent because the topic superficially fits another lane.
DELEGATION (overrides ADDRESSED BY NAME): if the user tells the addressed agent to have / ask / get / assign ANOTHER named agent to do something ("Finn, have Iris create the task", "Sam, ask Cole to estimate it"), the DELEGATE — the agent who should actually perform the action (Iris / Cole) — is the primary, because they must be the one to do it (create the task, run the tool). Add the addressed agent as supporting only if they also contribute.
CAPABILITY OWNERSHIP: some jobs are exclusive to one agent, shown as [owns: …] on their roster line (e.g. [owns: backlog grooming, triage & sprint/board assignment]). A request for an exclusively-owned job belongs to its owner. If the user did NOT address a specific agent, route the owner as primary. If they DID address a different agent (e.g. "Tess, groom the backlog"), keep that agent as primary — they will hand off to the owner themselves; do not silently swap them out.
TIME IS NOT ALWAYS THE CALENDAR: how long a piece of WORK will take (a build estimate, a task's effort) belongs to the lane that owns that work — NOT the schedule/itinerary agent. The schedule agent is ONLY for the user's OWN calendar (their meetings, appointments, personal deadlines). Do not pull in the calendar agent just because a duration or the word "time" appears.
MULTI-LANE LIST / BRAIN-DUMP: when the user's latest message ENUMERATES several distinct task areas at once — a list with lane labels ("Career - …", "Finance - …", "Errands - …") or clearly separate domains each carrying their own item(s) — do NOT funnel it all to one agent. Pick the owner of the most prominent lane as primary, and return the owner of EACH other enumerated lane in BOTH supporting AND explicitlyRequested (the user asked for that lane by listing it). Map each lane to its owner via the roster domains. Each owner captures only its own lane's items. This applies ONLY to an actual multi-area enumeration — a single-topic message that merely touches an adjacent domain still gets ONE primary.`;

  const strictSystem = `You are the router for a multi-agent huddle. Pick exactly ONE primary agent for the user's latest message. Return supporting = [] UNLESS the message explicitly asks for a second, non-overlapping specialty (e.g. "and also budget it" or "then draft the email"). Adjacency is not enough — a workout question does NOT need a life-strategist just because habits are related. When in doubt, return supporting = []. Never invent agent ids — only choose from the roster.
ADDRESSED BY NAME: if the user addresses an agent by name ("Cole, how long…"), that agent IS the primary — never hand the lead to another agent because the topic superficially fits their lane. DELEGATION (overrides that): if the user tells the addressed agent to have/ask/get ANOTHER named agent do something ("Finn, have Iris create the task"), the DELEGATE who must perform the action (Iris) is the primary. TIME IS NOT ALWAYS THE CALENDAR: how long WORK takes (a build/effort estimate) belongs to the lane that owns the work, not the schedule agent; the schedule agent is only for the user's OWN calendar.

Example — user: "what workouts do i usually go for?" → primary: flex-grimes, supporting: [], reason: single-lane fitness question.
Example — user: "Finn, have Iris create the venue task" → primary: iris-chase, supporting: [], reason: delegation — Iris is the one who must create it.
Example — user: "plan tomorrow's workout and also budget my gym membership" → primary: flex-grimes, supporting: [finn-reid], reason: two distinct lanes explicitly named.
EXCEPTION — MULTI-LANE LIST: if the message ENUMERATES several distinct task areas at once (a labeled list "Career - …, Finance - …, Errands - …" or clearly separate domains each with their own items), this is the ONE case where multiple primaries are correct: return the owner of EACH enumerated lane in supporting AND explicitlyRequested (map each lane to its owner via the roster domains). A single-topic message that merely touches an adjacent domain is NOT this case — stay solo.`;

  const system = invocation.strictPrompt ? strictSystem : baseSystem;

  const wantInterject = !!invocation.interjections;
  const supportingHint = invocation.strictPrompt
    ? "Pick the best primary agent. Return supporting = [] unless the message explicitly requires a second specialty."
    : "Pick the best primary agent, up to 2 supporting agents, and a one-line reason.";

  // Distinguish user-REQUESTED collaborators from adjacency the model volunteered. Only the
  // latter should ever be dropped by the caller's solo-on-coverage guard, so the router reports
  // which supporting agents the user actually asked for. Roster-driven (ids only) → auto-scales.
  const explicitRequestHint = `\n\nAlso return "explicitlyRequested": the subset of your supporting agents that the user NAMED (e.g. "pull in Finn and Tess", "loop in Cole"), whose distinct deliverable the user explicitly asked for (e.g. "and also draft the email"), OR who own a lane the user explicitly enumerated in a multi-area list/brain-dump. Do NOT include an agent you merely judged helpful — only ones the user actually asked for. Return [] if none.`;

  const interjectHint = wantInterject
    ? `\n\nAlso list "interjectors": agents (other than the primary/supporting) who might hold something URGENT the primary will MISS. Nominate ONLY for one of these two reasons — never for topical relevance, a second opinion, or to add color:
1. MISSING PIECE — another lane owns a specific fact/number/constraint/check the primary needs to get this right and would plausibly omit or get wrong (e.g. the finance lane knows the pricing math the GTM answer skipped).
2. BLOCKING RISK / CONFLICT — another lane can see a clash or risk the primary can't (a schedule conflict, a budget/deadline/dependency/compliance blocker, a commitment already made).
You can't see their data — nominate on the ANGLE; each nominee checks and PASSES silently if it has nothing concrete. The calendar/tasks/contacts agent is a good nominee ONLY when the message touches the user's OWN schedule/commitments (a real meeting, appointment, or personal deadline) — NOT for a generic duration like "how long will the build take." Nothing urgent is the COMMON case → return interjectors = [].`
    : "";

  // Difficulty (1-4): how much reasoning/rigor the BEST answer needs. Drives per-turn reasoning effort
  // (escalating effort on the cheap model is the proven cost-effective lever). Semantic, not keyword.
  const difficultyHint = `\n\nAlso return "difficulty" (integer 1-4) = how much reasoning/rigor the best answer to the LATEST message needs, independent of who answers:
1 = routine: a quick read, status lookup, acknowledgement, or a single create/update op.
2 = standard: planning, prioritization, judgment, or a short draft.
3 = structured-rigor: a substantive deliverable or analysis that must be correct and well-structured (financial model, full essay, product/GTM strategy, deep multi-step analysis).
4 = exceptional: rare, exceptionally complex multi-constraint synthesis where small errors are very costly.`;

  const prompt = `Roster (available agents in this huddle):
${roster}

Recent transcript:
${transcript || "(no prior messages)"}

Latest user message:
${text}

${supportingHint}${interjectHint}${explicitRequestHint}${difficultyHint}`;

  const zodSchema = z.object({
    primary: z.enum(memberIds),
    supporting: z.array(z.enum(memberIds)),
    explicitlyRequested: z.array(z.enum(memberIds)).optional().default([]),
    interjectors: z.array(z.enum(memberIds)).optional().default([]),
    reason: z.string(),
    difficulty: z.number().int().min(1).max(4).optional().default(2),
  });

  try {
    let output: {
      primary: AgentId;
      supporting: AgentId[];
      explicitlyRequested?: AgentId[];
      interjectors?: AgentId[];
      reason: string;
      difficulty?: number;
    };

    if (invocation.backend === "openai") {
      const { callOpenAIRouter } = await import("./openai-responses.server");
      // Build a strict JSON schema mirroring the Zod shape.
      const jsonSchema = {
        type: "object",
        additionalProperties: false,
        properties: {
          primary: { type: "string", enum: memberIds },
          supporting: {
            type: "array",
            items: { type: "string", enum: memberIds },
          },
          explicitlyRequested: {
            type: "array",
            items: { type: "string", enum: memberIds },
          },
          interjectors: {
            type: "array",
            items: { type: "string", enum: memberIds },
          },
          reason: { type: "string" },
          difficulty: { type: "integer", enum: [1, 2, 3, 4] },
        },
        required: ["primary", "supporting", "explicitlyRequested", "interjectors", "reason", "difficulty"],
      } as Record<string, unknown>;

      const raw = await callOpenAIRouter<{
        primary: string;
        supporting: string[];
        explicitlyRequested: string[];
        interjectors: string[];
        reason: string;
        difficulty: number;
      }>({
        model: invocation.model,
        system,
        prompt,
        schema: jsonSchema,
        schemaName: "huddle_route",
        fastMode: invocation.fastMode,
      });
      output = zodSchema.parse(raw);
    } else {
      if (!invocation.lovableModel) throw new Error("Lovable model not initialized");
      const result = await generateText({
        model: invocation.lovableModel,
        system,
        prompt,
        output: Output.object({ schema: zodSchema }),
      });
      output = result.output;
    }

    const { primary, supporting, reason } = output;

    if (!memberIds.includes(primary)) {
      console.error(
        "[huddle-router] LLM returned primary not in roster, using keyword fallback:",
        { primary, memberIds },
      );
      const fallback = routeMessage(input);
      return {
        ...fallback,
        decision: {
          ...fallback.decision,
          reason: `LLM fallback: primary "${primary}" not in roster. ${fallback.decision.reason}`,
        },
      };
    }

    // Deterministic multi-lane-list detection: an enumerated brain-dump ("Career - …, Finance - …") is a
    // genuine multi-lane request, so soloOnCoverage must NOT collapse it to the primary. Turn solo OFF for
    // that turn (the specialists the LLM picked fan out) and pass the lane count so the cap fits them all.
    // A single-topic message scores <2 and is untouched — solo still kills adjacency pile-ons there.
    const laneCount = countLaneLabels(text);
    const isMultiLaneList = laneCount >= 2;
    // Resolve each labeled lane to its OWNER and FORCE those owners into the responder set, so the exact
    // right specialists respond every time (not left to the LLM's inconsistent supporting selection —
    // which dropped the education/errands owners and substituted the scheduler). Lane owners go FIRST so
    // the winner cap can never truncate them. Roster-driven (scoreAgentAgainst), no parallel system.
    const laneOwners = isMultiLaneList
      ? detectLaneOwners(text, present).filter((id) => id !== primary)
      : [];
    const supportingUnion = Array.from(new Set([...laneOwners, ...supporting]));
    const explicitUnion = Array.from(
      new Set([...laneOwners, ...(output.explicitlyRequested ?? [])]),
    );
    // Deterministic winner assembly (pure, unit-tested offline — see routing.winners.test.ts).
    const { winners, soloApplied, explicitKept, mentionedWinners } = assembleWinners({
      primary,
      supporting: supportingUnion,
      explicitlyRequested: explicitUnion,
      mentions,
      memberIds,
      text,
      soloOnCoverage: !!invocation.soloOnCoverage && !isMultiLaneList,
      explicitLaneCount: Math.max(laneCount, laneOwners.length),
    });
    const scores = Object.fromEntries(
      winners.map((id, i) => [id, Number((1 - i * 0.2).toFixed(2))]),
    ) as Partial<Record<AgentId, number>>;

    // Interjectors: substantive cross-domain voices, distinct from the primary
    // and supporting agents. Only surfaced when the toggle is on.
    const interjectors = wantInterject
      ? (output.interjectors ?? []).filter(
          (id) => memberIds.includes(id) && !winners.includes(id),
        )
      : [];

    return {
      winners,
      interjectors,
      difficulty: output.difficulty ?? 2,
      decision: {
        signal: "topic",
        scores,
        winnerId: primary,
        runnerUpId: winners[1] ?? null,
        interjected: interjectors.length > 0,
        reason: `LLM router (${invocation.backend}/${invocation.model})${soloApplied ? (explicitKept > 0 ? ` [solo+${explicitKept}req]` : " [solo]") : ""}${mentionedWinners.length ? ` +${mentionedWinners.length}@mention` : ""}${interjectors.length ? ` +${interjectors.length} interject` : ""}: ${reason}`.slice(0, 220),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (NoObjectGeneratedError.isInstance(err)) {
      console.error(
        "[huddle-router] LLM router failed (NoObjectGenerated), using keyword fallback:",
        msg,
        "raw:",
        err.text,
      );
    } else {
      console.error(
        "[huddle-router] LLM router failed, using keyword fallback:",
        msg,
      );
    }
    const fallback = routeMessage(input);
    return {
      ...fallback,
      decision: {
        ...fallback.decision,
        reason: `LLM fallback: ${msg.slice(0, 120)}. ${fallback.decision.reason}`,
      },
    };
  }
}

