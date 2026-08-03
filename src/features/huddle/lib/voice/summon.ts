// SUMMON (1:1 voice "buzz + greeting"): when a 1:1 voice meeting view loads, we play a short intercom
// "buzz" (as if paging the agent), then the agent answers with a canned, CLIENT-SIDE greeting spoken in
// its ElevenLabs cloned voice — no LLM turn, no server round-trip beyond the one TTS call. This mirrors
// the ceremony's summon feel and kills the dead air on open (something is voiced immediately, before the
// user has said anything). The real conversation still runs through the normal Realtime brain once the
// user speaks.

// Served from public/ at the site root (see public/sounds/summon-buzz.wav).
export const SUMMON_BUZZ_URL = "/sounds/summon-buzz.wav";

// Short, varied "picked up the call" greetings. Kept generic (not per-agent) and neutral — the point is
// an instant, natural acknowledgment of being summoned, not a full answer. Deliberately gender-neutral
// (no "sir"/"ma'am") so we never assume; add a preferred honorific here if the user wants one.
export const SUMMON_GREETINGS: readonly string[] = [
  "Hello.",
  "Hi there.",
  "Hey — how can I help?",
  "Yes? How can I help you?",
  "Hello, how can I help you?",
  "Hey, what can I do for you?",
  "I'm here — what's up?",
];

/** Pick a random summon greeting. Client-only (Math.random is fine here — this is UI, not a workflow). */
export function pickSummonGreeting(): string {
  return SUMMON_GREETINGS[Math.floor(Math.random() * SUMMON_GREETINGS.length)];
}

// Wait for the meeting WINDOW to actually be open (rendered/painted) + the audio pipeline to be ready
// before the buzz plays — otherwise the buzz fires on raw meeting-open and trails off before the user
// perceives the window as open. Tunable: raise if the buzz still lands too early, lower if it feels late.
export const SUMMON_OPEN_DELAY_MS = 650;

// Fallback cap: fire the greeting this long after the buzz STARTS even if its "ended" event never comes
// (e.g. autoplay blocked the buzz, or the element errored). Normally the greeting fires when the buzz ends.
export const SUMMON_GREETING_MAX_WAIT_MS = 1500;
