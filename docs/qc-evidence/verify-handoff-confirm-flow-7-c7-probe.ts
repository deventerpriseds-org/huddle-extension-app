// WHAT:  Loop-7 C7 probe: NEW unsafe-direction (U7-*) and under-match (M7-*) rows against board-claims.ts @ 28d0ab3b.
//        Summaries are the REAL strings from huddle.functions.ts recordToolUse calls (line numbers in comments).
// WHY:   C7 claims F6 never rewrites a true statement and catches false claims. Run: bun <this file>
// SUPERSEDES: nothing (loop-5 probe re-run unchanged alongside)  SUPERSEDED-BY: nothing -- current
import { presentBoardClaims } from "../../src/features/huddle/lib/tasks/board-claims.ts";
const A = "ezra";
const U = (tool: string, summary: string, ok = true, detail?: string, agentId = A) => ({ agentId, tool, summary, ok, detail });
const REM = U("schedule_reminder", "reminder scheduled"); // real summary at :4712-4715
const CAL = U("create_calendar_event", "journey-voice · ok"); // journey proxy :5233 records every journey tool this way
const DRAFT = U("create_email_draft", "draft saved in ezra@x (id abc123…)"); // :5027
const SENT = U("send_email", "sent from ezra@x → sam@y"); // :4972
const cases: [string, string, any[], "keep" | "rewrite"][] = [
  // ---- unsafe direction: TRUE statements that must be KEPT ----
  ["U7-1 reminder for the review", "I set a reminder for the review at 3pm.", [REM], "keep"],
  ["U7-2 reminder for when done", "I've set a reminder for when you're done.", [REM], "keep"],
  ["U7-3 calendar set aside for review", "I've set aside an hour for the review.", [CAL], "keep"],
  ["U7-4 calendar marked as blocked", "I've marked 2-4pm as blocked on your calendar.", [CAL], "keep"],
  ["U7-5 draft put in for review", "I've put it in drafts for your review.", [DRAFT], "keep"],
  ["U7-6 started a draft", "I've started a draft for you.", [DRAFT], "keep"],
  ["U7-7 started the email", "I've started the email to Sam — it's in your drafts.", [DRAFT], "keep"],
  ["U7-8 email sent, marked done", "I sent it and marked the thread as done in your inbox.", [SENT], "keep"],
  ["U7-9 teammate did the move (passive)", "It's been moved to Done by Finn.", [U("update_task", "journey-voice · ok", true, undefined, "finn-reid")], "keep"],
  ["U7-10 pre-existing state", "That task is marked done already — since Sept 1.", [], "keep"],
  ["U7-11 report is done", "The report is done and attached.", [], "keep"],
  ["U7-12 meeting set for 3", "Your meeting is set for 3.", [], "keep"],
  ["U7-13 draft is complete", "The draft is complete.", [], "keep"],
  ["U7-14 calendar moved meeting", "I moved your dentist appointment to Thursday.", [CAL], "keep"],
  ["U7-15 updated doc to complete", "I updated the doc to complete the analysis.", [U("nexus_write", "1 row(s) written")], "keep"],
  ["U7-16 working on it after search", "I'm working on it — here's what I found so far.", [U("tavily_web_search", "“x” · 5 results")], "keep"],
  // ---- under-matches: FALSE claims (no tool) that must be REWRITTEN ----
  ["M7-1 and marked", "I wrapped it up and marked it done.", [], "rewrite"],
  ["M7-2 Just marked", "Just marked it done!", [], "rewrite"],
  ["M7-3 Got it, marked", "Got it, marked it done.", [], "rewrite"],
  ["M7-4 Happy to help,", "Happy to help, I've marked it done.", [], "rewrite"],
  ["M7-5 Since you asked", "Since you asked, I moved it to Done.", [], "rewrite"],
  ["M7-6 Once you confirmed", "Once you confirmed, I marked it done.", [], "rewrite"],
  ["M7-7 It's now in Done", "It's now in Done.", [], "rewrite"],
  ["M7-8 archived both", "I've archived both.", [], "rewrite"],
  ["M7-9 closed it out", "I've closed it out.", [], "rewrite"],
  ["M7-10 Sure thing", "Sure thing, moved it to Review.", [], "rewrite"],
];
let bad = 0;
for (const [name, text, uses, want] of cases) {
  const out = presentBoardClaims([{ agentId: A, text }], uses)[0].text;
  const got = out === text ? "keep" : "rewrite";
  const flag = got === want ? "ok  " : "MISS";
  if (got !== want) bad++;
  console.log(`${flag} [${want}->${got}] ${name}: ${JSON.stringify(text)} => ${JSON.stringify(out)}`);
}
console.log("misses:", bad);
