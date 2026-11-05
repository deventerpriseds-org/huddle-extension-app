import { stripRepeatedDraft, noticeText } from "../src/features/huddle/lib/chat-format";
const card = "Hi Sam,\n\nThursday at 2 PM works for me (a placeholder, happy to move it).\n\nBest,\nVon";
const P = (l: string, v: unknown) => console.log(l, JSON.stringify(v));
// loop-1 partial case
const partial = "Sam Lee from Acme wants to meet this week.\n\nSuggested reply:\n\nHi Sam,\n\nThursday at 2 PM works for me — happy to move it if needed.\n\nBest,\nVon\n\nTap Save to Drafts, or tell me what to change.";
P("partial unchanged:", stripRepeatedDraft(partial, card) === partial);
// 2-para card only sign-off matches
const card2 = "Thanks Sam, Thursday works.\n\nBest,\nVon";
const t2 = "Sam wrote in.\n\nI'd say yes.\n\nBest,\nVon";
P("2para signoff-only unchanged:", stripRepeatedDraft(t2, card2) === t2);
// FULL match with label + trailing spaces
const full = "Sam Lee from Acme wants to meet this week.\n\nSuggested reply:\n\nHi Sam,\n\nThursday at 2 PM works for me (a placeholder, happy to move it).\n\nBest,  \nVon\n\nTap Save to Drafts.";
P("full:", stripRepeatedDraft(full, card));
// label inline with first para
const full2 = "Sam wants to meet.\n\nSuggested reply: Hi Sam,\n\nThursday at 2 PM works for me (a placeholder, happy to move it).\n\nBest,\nVon";
P("full label-inline:", stripRepeatedDraft(full2, card));
// **bold** label
const full3 = "Sam wants to meet.\n\n**Suggested reply:**\n\nHi Sam,\n\nThursday at 2 PM works for me (a placeholder, happy to move it).\n\nBest,\nVon";
P("full bold label:", stripRepeatedDraft(full3, card));
// duplicate-paragraph count edge: generic para twice + paraphrased middle
const dup = "Hi Sam,\n\nSam wants to meet.\n\nHi Sam,\n\nThursday works, happy to move it.\n\nBest,\nVon";
const dr = stripRepeatedDraft(dup, card);
P("dup-generic (should be unchanged):", dr === dup ? "UNCHANGED" : dr);
P("empty body:", stripRepeatedDraft(full, "  ") === full);
// notices
for (const s of [
  "(couldn't respond — OpenAI is out of API quota — agent routing.)",
  "(fallback: model call failed: OpenAI Responses 500: {\"error\":{\"message\":\"x\"}}) couldn't reach the model — OpenAI Responses 500: ...",
  "(fallback: model call failed: OpenAI Responses 429: Rate limit reached for gpt-4o (TPM): Limit) couldn't reach the model — x",
  "(fallback: AI gateway unconfigured) AI gateway is not configured yet.",
  "Sorry, I couldn't respond — the calendar was down.",
  "Done.\n\n_(fallback: x)_",
  "I checked (fallback: none) and it's fine.",
]) P("notice:", [s.slice(0, 60), noticeText(s)]);
