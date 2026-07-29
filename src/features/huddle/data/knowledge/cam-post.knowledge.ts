import type { KnowledgePack } from "./types";

// Cam Post — Communications agent. Grounded in professional writing, audience-aware
// messaging, and channel norms. Crafts emails, Slack replies, social posts, and
// public-facing messaging while holding tone and clarity — not scheduling or finance.
export const camPostKnowledge: KnowledgePack = {
  agentId: "cam-post",
  discipline: "Professional communications & copywriting",
  frameworks: [
    "BLUF (bottom line up front): lead with the ask or conclusion, then support it — busy readers decide in the first line whether to act.",
    "Audience → purpose → channel → tone: decide who's reading and what you want them to DO, then match register and format to the channel (a Slack ping ≠ a client email ≠ a public post).",
    "AIDA / hook-value-CTA for persuasive and social copy: earn attention, deliver the value, make the single next action obvious.",
    "Pyramid principle: answer first, then group supporting points logically — one idea per paragraph, most important first.",
    "Plain-language editing: cut jargon, prefer active voice and concrete verbs, shorten sentences; clarity is a courtesy and a credibility signal.",
    "Tone calibration: warmth × directness to fit the relationship and stakes — an apology, a boundary, and a celebration each need a different register but the same clarity.",
  ],
  vocabulary: [
    "BLUF — bottom line up front; the conclusion/ask stated before the rationale.",
    "CTA (call to action) — the single, specific next step you want the reader to take.",
    "Subject line / preview — the email's headline; it determines open and response rate more than the body.",
    "Active vs passive voice — 'we shipped it' vs 'it was shipped'; active is clearer, shorter, and owns the action.",
    "Register / tone — the formality and warmth level; matched to audience and channel.",
    "Skimmable formatting — short paragraphs, bold key points, bullets — because people scan, they don't read.",
    "Voice — the consistent personality of the writing (brand or personal); tone flexes per message, voice stays.",
    "Framing — the angle a message is presented from; the same facts land differently depending on framing.",
  ],
  benchmarks: [
    "Lead with the ask/conclusion in the first 1–2 sentences; if the reader stops there, they still got the point.",
    "One email = one primary ask with one clear CTA; multiple buried asks get partial responses.",
    "Subject lines: specific and action-oriented (~a handful of words); vague subjects tank open rates.",
    "Keep paragraphs to ~2–4 lines and prefer bullets for lists — readers scan on every channel.",
    "Match length to channel: Slack is 1–3 tight sentences; a formal email is structured; a social post front-loads the hook.",
    "Read it once as the recipient before sending — especially for anything sensitive, public, or that could be forwarded.",
  ],
  decisionPatterns: [
    "Start from the outcome: what should the reader think, feel, or DO? Write backward from that single action.",
    "Match register and format to audience and channel before drafting — the same message is shaped differently for a boss, a teammate, and the public.",
    "Put the bottom line first, support it briefly, and make the one CTA unmistakable.",
    "Calibrate tone to the stakes and relationship; for tense or sensitive messages, be direct AND kind, and never send angry.",
    "Edit for clarity last: cut filler, kill jargon and passive voice, and make it skimmable.",
    "Stay in the comms lane — draft and shape the message; hand scheduling to the team lead and any numbers/finance to the finance strategist.",
  ],
  playbooks: [
    "Email draft: sharp subject → BLUF ask → brief context/support → single explicit CTA → sign-off matched to the relationship.",
    "Slack reply: 1–3 sentences, answer first, link or next step, tone matched to the channel's norms.",
    "Social/public post: hook in the first line → value/story → one clear CTA; front-load because feeds truncate.",
    "Sensitive/hard message: state the point kindly and directly, acknowledge the other side, offer a path forward, and re-read as the recipient before sending.",
    "Tone/clarity pass on existing copy: tighten to BLUF, cut jargon and passive voice, make it skimmable, and confirm the CTA is obvious.",
  ],
  antiPatterns: [
    "Burying the ask at the bottom of a long message — the reader skims, misses it, and nothing happens.",
    "One email with five different asks — you get a partial answer to whichever one they noticed.",
    "Vague subject lines ('quick question', 'following up') — low opens, slow replies.",
    "Wall-of-text with no formatting — unskimmable, so it goes unread on every channel.",
    "Wrong register for the channel — a formal essay in Slack, or a too-casual public post that reads as careless.",
    "Sending a reactive, emotional message in the moment — draft it, wait, and re-read as the recipient before it's irretrievable.",
  ],
};
