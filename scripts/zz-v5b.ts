import { joinOpenerAndBlock, openerOnly, stripRepeatedDraft, parseChatBlocks } from "../src/features/huddle/lib/chat-format";
const block = "Meetings and classes:\n• 9:00 AM — Standup\n• 1:00 PM — Review\n\nWant me to move anything?";
const cases = [
  "Good morning Sir, here's today.",
  "Good morning Sir, +1 for the early start.\n+ 9:00 AM — Standup\n+ 1:00 PM — Review",
  "Morning! *Busy* day ahead.\n* 9:00 AM — Standup",
  "Morning.\n```\n• 9:00 AM — Standup\n```",
  "(fallback: openai 429) couldn't reach the model — sorry",
];
for (const c of cases) {
  const out = joinOpenerAndBlock(c, block);
  const n = (out.match(/9:00 AM — Standup/g) || []).length;
  console.log(JSON.stringify(c).slice(0, 60).padEnd(62), "standup x", n, "=>", JSON.stringify(out).slice(0, 140));
}
// C1: draft strip full-match only
const draft = "Hi Sam,\n\nthanks for reaching out. Tuesday works.\n\nBest,\nVon";
console.log("C1 full:", JSON.stringify(stripRepeatedDraft(`Here's a draft.\n\nSuggested reply:\n\n${draft}`, draft)));
console.log("C1 partial:", JSON.stringify(stripRepeatedDraft(`Here's a draft.\n\nHi Sam,\n\nthanks for reaching out. Tuesday works.`, draft)));
console.log("C1 italic-draft:", JSON.stringify(stripRepeatedDraft(`Draft below.\n\n*Suggested reply:*\n\n${draft}`, draft)));
console.log("A2 list nums:", JSON.stringify(parseChatBlocks("5. *a*\n7. _b_\n2. c").map((b: any) => b.nums ?? b.t)));
