// Resolve WHO a spoken ceremony barge is addressed to — tolerant of STT mangling ("Al"/"El" -> Elle),
// scoped to the agents actually PRESENT, with the recent speaker as a tiebreak. Pure + dependency-free
// so it is offline-unit-testable (bun/node) against the real mangled inputs from the live transcript,
// AND importable by the SERVER router (routing.ts) — this is the ONE shared name-resolver both the
// client (instant summons ack / ambiguous clarify) and the server (authoritative barge routing) use.
//
// Returns:
//   { kind: "agent", agentId, isSummons }  — confidently one present agent. isSummons = just a name,
//                                            no substantive request (=> instant "Yes sir", no turn).
//   { kind: "ambiguous", candidates }       — two present agents genuinely too close (=> 1-line clarify).
//   { kind: "none" }                          — no agent clearly addressed (=> fall to the interlocutor).

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

// Common English words that are NEVER an address, even when they land where a name could. Without this,
// an ordinary word prefix-/fuzzy-matches a name — the single letter "i" matched "Iris", "same" matched
// "Sam". A name is a NAME; if a token is a function/filler word, it is not an address. This does NOT
// block real STT-mangled names ("Al"/"El" for Elle) — those aren't function words. Kept deliberately
// broad because a barge routed to the WRONG named agent is worse than one that falls to the interlocutor.
const STOPWORDS = new Set([
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours",
  "a", "an", "the", "this", "that", "these", "those",
  "and", "but", "or", "nor", "if", "then", "than", "as", "because", "just", "no", "not", "never",
  "yes", "yeah", "nah", "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "done",
  "can", "could", "will", "would", "should", "shall", "may", "might", "must",
  "to", "of", "in", "on", "at", "for", "with", "from", "by", "about", "up", "out", "off",
  "what", "why", "how", "when", "where", "who", "which", "let", "lets",
  // conversational-opener acknowledgments that frequently START a barge before the real content —
  // "Great, while you're doing that…", "Wait, …", "Perfect, …", "Right, …" — never an address.
  "great", "perfect", "right", "cool", "nice", "thanks", "thank", "here", "there", "now", "please",
  "while", "before", "after", "also", "actually", "really", "quick", "question", "quickly", "one",
  "youre",
]);

// Words that make a barge a SUBSTANTIVE request rather than a bare summons (a question/command).
const SUBSTANTIVE_HINT = /[?]|\b(what|why|how|when|where|who|can|could|would|will|do|does|did|is|are|should|mark|add|create|update|search|look|find|check|show|tell|give|send|schedule|park|move|set|make|change|remove|delete|start|stop|the|a|an|that|this|it|my|your|for|about|blocked?|status|task|please)\b/i;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Crude but effective phonetic key: collapse vowels to one class, drop doubled letters.
// "elle"->"al", "eli"->"ali" ... (kept simple; the edit-distance below does the rest).
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

// Is `token` a CLEAN (high-precision) match for `name` — exact or a real prefix either way?
// Returns a score (lower = better) or null when it isn't a clean match. Deliberately does NOT fuzzy-
// match here — fuzzy is reserved for the recent-speaker tiebreak below (the only STT case we trust).
function cleanNameScore(token: string, name: string): number | null {
  const t = token.toLowerCase();
  const n = name.toLowerCase();
  if (t === n) return 0;
  // Token is a TRUNCATION of the name ("fin"→"finn", "terr"→"terry", "col"→"cole") — a common STT/
  // speech clip. Require the token be ≥3 chars AND a real leading prefix of the NAME. We deliberately
  // do NOT accept the reverse (name is a prefix of the token) — that direction lets ordinary words that
  // merely START with a short name hijack it ("same"→Sam, "irish"→Iris, "coleman"→Cole), which is the
  // wrong-agent class of bug. A word that is a clean truncation of a name is far rarer and safer.
  if (t.length >= 3 && n.startsWith(t)) {
    return 0.3 + (n.length - t.length) * 0.15;
  }
  return null;
}

// Phonetic/edit closeness — used ONLY to disambiguate toward the RECENT SPEAKER (the documented
// "Al"/"El" -> Elle when Elle is the one talking case). Scoping fuzzy to the recent speaker keeps a
// common word from fuzzily hijacking some unrelated agent.
function fuzzyNameScore(token: string, name: string): number {
  const t = token.toLowerCase();
  const n = name.toLowerCase();
  if (t === n) return 0;
  const raw = lev(t, n);
  const ph = lev(phon(t), phon(n));
  return Math.min(raw, ph + 0.5);
}

/**
 * Resolve the addressed agent for a ceremony barge. Scans EVERY token (not just the first) for a
 * present agent's name — a name spoken mid-sentence ("Great, while you're doing that, Finn, are you
 * here?", "is Finn here", "something for Finn") is caught, which the old first-token-only logic missed
 * (the live "I keep calling Finn but Terry answers" bug). Precision-biased: clean exact/prefix match on
 * any token, plus a recent-speaker-scoped fuzzy pass for STT mangling — a wrong-agent match is worse
 * than falling through to the interlocutor.
 * @param text the (possibly STT-mangled) barge text
 * @param present the agents currently in the ceremony ({id, firstName})
 * @param recentSpeakerId the agent who was most recently speaking (tiebreak / STT-fuzzy anchor)
 */
export function resolveAddressedAgent(
  text: string,
  present: AddressedMember[],
  recentSpeakerId?: string | null,
): AddressResult {
  const norm = normalize(text);
  if (!norm || present.length === 0) return { kind: "none" };
  const words = norm.split(" ");

  // Best (lowest) CLEAN score per present agent across all eligible tokens.
  const byAgent = new Map<string, number>();
  for (const w of words) {
    // A 1-char token, greeting/filler, or common English function word is never a name.
    if (w.length < 2 || GREETINGS.has(w) || STOPWORDS.has(w)) continue;
    for (const m of present) {
      const s = cleanNameScore(w, m.firstName);
      if (s === null) continue;
      const cur = byAgent.get(m.id);
      if (cur === undefined || s < cur) byAgent.set(m.id, s);
    }
  }

  // Recent-speaker STT rescue: if NO clean match landed on the recent speaker, allow a phonetically-
  // close token to resolve to THEM (only them). This is the "Al"/"El" -> Elle case, disambiguated by
  // who is actually holding the floor — so it can't hijack an unrelated agent.
  if (recentSpeakerId && !byAgent.has(recentSpeakerId)) {
    const speaker = present.find((m) => m.id === recentSpeakerId);
    if (speaker) {
      for (const w of words) {
        if (w.length < 2 || GREETINGS.has(w) || STOPWORDS.has(w)) continue;
        const s = fuzzyNameScore(w, speaker.firstName);
        if (s <= 1.5) {
          byAgent.set(recentSpeakerId, Math.min(byAgent.get(recentSpeakerId) ?? Infinity, 0.9));
          break;
        }
      }
    }
  }

  if (byAgent.size === 0) return { kind: "none" };
  const scored = [...byAgent.entries()].map(([id, s]) => ({ id, s })).sort((a, b) => a.s - b.s);
  const best = scored[0];
  const second = scored[1];

  // Bare summons (a name with no real request) => instant ack, no model turn. `rest` = the content
  // words OTHER than the winner's name (greetings/stopwords already excluded). A lone name ("Sam?",
  // "hey Terry") has rest = [] and is a summons regardless of a trailing "?"; a name plus real content
  // ("Terry, what is blocked?") is not. Mirrors the committed rest-based rule (a whole-text `?` check
  // wrongly demoted "Sam?").
  const winnerName = present.find((m) => m.id === best.id)?.firstName ?? "";
  const contentWords = words.filter((w) => w.length >= 2 && !GREETINGS.has(w) && !STOPWORDS.has(w));
  const rest = contentWords.filter((w) => cleanNameScore(w, winnerName) === null);
  const isSummons = rest.length === 0 || (!SUBSTANTIVE_HINT.test(text) && rest.length <= 2);

  // Clear winner (well ahead of the runner-up) -> confident.
  if (!second || second.s - best.s >= 0.5) {
    return { kind: "agent", agentId: best.id, isSummons };
  }
  // Close call -> break the tie with the recent speaker if it is one of the close candidates.
  const close = scored.filter((c) => c.s - best.s < 0.5).map((c) => c.id);
  if (recentSpeakerId && close.includes(recentSpeakerId)) {
    return { kind: "agent", agentId: recentSpeakerId, isSummons };
  }
  // Genuinely ambiguous among present agents, no context signal -> ask a 1-line clarify.
  return { kind: "ambiguous", candidates: close };
}
