// Resolve WHO a spoken ceremony barge is addressed to — tolerant of STT mangling ("Al"/"El" -> Elle),
// scoped to the agents actually PRESENT, with the recent speaker as a tiebreak. Pure + dependency-free
// so it is offline-unit-testable (bun/node) against the real mangled inputs from the live transcript.
//
// Returns:
//   { kind: "agent", agentId, isSummons }  — confidently one present agent. isSummons = just a name,
//                                            no substantive request (=> instant "Yes sir", no turn).
//   { kind: "ambiguous", candidates }       — two present agents genuinely too close (=> 1-line clarify).
//   { kind: "none" }                          — no agent clearly addressed (=> fall to the group router).

export interface AddressedMember {
  id: string;
  firstName: string;
}

export type AddressResult =
  | { kind: "agent"; agentId: string; isSummons: boolean }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

// Leading/trailing tokens that are never a name — greetings, fillers, hesitations.
const GREETINGS = new Set([
  "hey", "hi", "hello", "yo", "ok", "okay", "um", "uh", "er", "hmm", "so", "well", "excuse", "me", "sorry", "wait", "hold", "on",
]);

// Common English words that are NEVER an address, even when they're the first real token. Without this,
// a barge that OPENS with a pronoun/article ("I never mentioned…", "It's not…", "No, just continue…")
// had its first letter prefix-matched to a name — the single letter "i" scored a match to "Iris" (0.6 +
// length penalty ≈ 1.35, under the 3.0 gate), so EVERY barge starting with "I" hijacked to Iris. People
// address an agent by NAME first; if the opener is a function word, it's a content barge → none (which
// then pins to the interlocutor). This does NOT block real STT-mangled names ("Al"/"El" for Elle) —
// those aren't function words.
const STOPWORDS = new Set([
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours",
  "a", "an", "the", "this", "that", "these", "those",
  "and", "but", "or", "nor", "if", "then", "than", "as", "because", "just", "no", "not", "never",
  "yes", "yeah", "nah", "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "done",
  "can", "could", "will", "would", "should", "shall", "may", "might", "must",
  "to", "of", "in", "on", "at", "for", "with", "from", "by", "about", "up", "out", "off",
  "what", "why", "how", "when", "where", "who", "which", "let", "lets",
]);

// Words that make a barge a SUBSTANTIVE request rather than a bare summons (a question/command).
const SUBSTANTIVE_HINT = /[?]|\b(what|why|how|when|where|who|can|could|would|will|do|does|did|is|are|should|mark|add|create|update|search|look|find|check|show|tell|give|send|schedule|park|move|set|make|change|remove|delete|start|stop|the|a|an|that|this|it|my|your|for|about|blocked?|status|task|please)\b/i;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Crude but effective phonetic key: collapse vowels to one class, drop doubled letters, drop trailing
// silent-ish. "elle"->"al", "eli"->"ali"... (kept simple; the edit-distance below does the rest).
function phon(s: string): string {
  const t = s.toLowerCase();
  const out: string[] = [];
  for (const c of t) {
    const k = "aeiou".includes(c) ? "a" : c;
    if (out.length && out[out.length - 1] === k) continue;
    out.push(k);
  }
  return out.join("");
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[b.length];
}

// Lower score = better match of a candidate name to a spoken token.
function scoreName(token: string, name: string): number {
  const t = token.toLowerCase();
  const n = name.toLowerCase();
  if (t === n) return 0;
  if (n.startsWith(t) || t.startsWith(n)) return 0.6 + Math.abs(n.length - t.length) * 0.25;
  const raw = lev(t, n);
  const ph = lev(phon(t), phon(n)) + 0.5;
  return Math.min(raw, ph) + 1.5;
}

/**
 * Resolve the addressed agent for a ceremony barge.
 * @param text the (possibly STT-mangled) barge text
 * @param present the agents currently in the ceremony ({id, firstName})
 * @param recentSpeakerId the agent who was most recently speaking (tiebreak for close matches)
 */
export function resolveAddressedAgent(
  text: string,
  present: AddressedMember[],
  recentSpeakerId?: string | null,
): AddressResult {
  const norm = normalize(text);
  if (!norm || present.length === 0) return { kind: "none" };
  const words = norm.split(" ");
  // The name token is the first non-greeting word (people address at the START: "hey Sam, ...").
  let nameIdx = 0;
  while (nameIdx < words.length && GREETINGS.has(words[nameIdx])) nameIdx++;
  if (nameIdx >= words.length) return { kind: "none" };
  const token = words[nameIdx];
  // Guard against function-word false matches: a 1-char token, or a common English word, is NOT a name.
  // (This is the "I…" -> "Iris" hijack fix.) People address by NAME first; a function-word opener means
  // it's a content barge -> none -> pinned to the interlocutor by the caller.
  if (token.length < 2 || STOPWORDS.has(token)) return { kind: "none" };

  const scored = present
    .map((m) => ({ id: m.id, s: scoreName(token, m.firstName) }))
    .sort((a, b) => a.s - b.s);
  const best = scored[0];
  const second = scored[1];
  // Nothing close enough -> not an address (let the group router handle content-only barges).
  if (!best || best.s > 3.0) return { kind: "none" };

  // Is there a substantive request after the name? (=> not a bare summons)
  const rest = words.slice(nameIdx + 1).filter((w) => !GREETINGS.has(w)).join(" ");
  const isSummons = rest.length === 0 || (!SUBSTANTIVE_HINT.test(text) && rest.length <= 2);

  // Clear winner (well ahead of the runner-up) -> confident.
  if (!second || second.s - best.s >= 1.0) {
    return { kind: "agent", agentId: best.id, isSummons };
  }
  // Close call -> break the tie with the recent speaker if it is one of the close candidates.
  const close = scored.filter((c) => c.s - best.s < 1.0).map((c) => c.id);
  if (recentSpeakerId && close.includes(recentSpeakerId)) {
    return { kind: "agent", agentId: recentSpeakerId, isSummons };
  }
  // Genuinely ambiguous among present agents, no context signal -> ask a 1-line clarify.
  return { kind: "ambiguous", candidates: close };
}
