// WHAT:  loop 7 C8 probe -- drives the REAL matchOpenTitle with realistic journey-style descriptions
// WHY:   loop 4 refuted the prefix rule; fix 83e1eb30 adds a description-overlap test. Hunt over/under-matches.
// RUN:   bun docs/qc-evidence/verify-handoff-confirm-flow-7-c8-probe.ts
import { matchOpenTitle, normalizeTaskTitle as n } from "../../src/features/huddle/lib/tasks/create-task-core";

// [label, open title, open description, new title, SAME task? (ground truth argued in the report)]
const rows: [string, string, string | null, string, boolean][] = [
  // --- loop 4 rows re-run, descriptions = what journey would plausibly store for the SHORT ask ---
  ["L4-umflint-real", "Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold.", "Obtain official transcript and send it directly to UM-Flint to remove the registration hold", true],
  ["L4-call-mom", "Call mom", "Give mom a call.", "Call mom about the trip", false],
  ["L4-blog", "Draft blog post", "Write a first draft of the blog post.", "Draft blog post on onboarding", false],
  ["L4-gift", "Buy birthday gift", "Purchase a birthday gift.", "Buy birthday gift for Sarah", false],
  ["L4-ai-tools", "Research AI tools", "Look into AI tools that could help.", "Research AI tools for legal contract review", false],
  ["L4-denver", "Book flight to Denver", "Book a flight to Denver.", "Book flight to Denver for the June wedding", false],
  ["L4-bill", "Pay the bill", "Pay the outstanding bill.", "Pay the bill for the dentist", false],
  ["L4-john", "Email John Smith", "Send an email to John Smith.", "Email John Smith the signed lease", false],
  ["L4-meeting", "Schedule a meeting", "Set up a meeting.", "Schedule a meeting with the landlord", false],
  ["L4-review", "Write a review", "Write the review.", "Write a review of Q3 sales numbers", false],
  ["L4-exact", "Walk the dog", null, "walk the dog", true],
  // --- task (2): UNSAFE over-match hunt (distinct ask whose extras happen to be in the open desc) ---
  ["OV-john-subset", "Email John Smith", "Send John the signed lease and the deposit receipt", "Email John Smith the deposit receipt", true /* subset of open email: arguably same */],
  ["OV-meeting-budget", "Schedule a meeting", "Schedule a meeting with the team to review the project timeline.", "Schedule a meeting with the team to review the budget", false],
  ["OV-electric-rental", "Pay the electric bill", "Pay the electric bill online before the due date to avoid a late fee.", "Pay the electric bill for the rental property before the due date", false],
  ["OV-doctor-sarah", "Call the doctor", "Call Dr. Patel's office to schedule an appointment about the persistent cough.", "Call the doctor to schedule an appointment for Sarah", false],
  ["OV-gift-generic", "Buy birthday gift", "Buy a birthday gift for Mom and have it delivered before Saturday.", "Buy birthday gift for Sarah and have it delivered before Saturday", false],
  ["OV-stem-pres", "Pick up prescription", "Pick up the prescription at CVS.", "Pick up prescription for the presentation", false],
  ["OV-long-generic", "Follow up", "Follow up with the client, send the proposal, schedule the review call and update the budget spreadsheet before the end of the week.", "Follow up with the landlord to schedule the review", false],
  ["OV-report-q4", "Send the report", "Send the quarterly sales report to the leadership team by Friday.", "Send the report to the leadership team by Monday", false],
  // --- task (3): UNDER-match hunt on the real UM-Flint shape ---
  ["UN-umflint-paraphrase", "Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold.", "Obtain official transcript and have it mailed straight to UM-Flint so the hold is cleared", true],
  ["UN-umflint-plural", "Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold.", "Obtain official transcripts and send them to UM-Flint", true],
  ["UN-umflint-reword-head", "Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold.", "Request official transcript be sent directly to UM-Flint", true],
  ["UN-umflint-short-extra", "Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold.", "Obtain official transcript for UM-Flint", true],
  ["UN-umflint-sent", "Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold.", "Obtain official transcript and send to UM-Flint", true],
];

let unsafe = 0, missed = 0;
for (const [label, open, desc, req, same] of rows) {
  const titles = new Set([n(open)]);
  const descs = desc ? new Map([[n(open), desc]]) : new Map<string, string>();
  const got = matchOpenTitle(n(req), titles, descs) !== null;
  const tag = got === same ? "ok      " : got ? "UNSAFE  " : "UNDER   ";
  if (got && !same) unsafe++;
  if (!got && same) missed++;
  console.log(`${tag} ${label.padEnd(24)} blocked=${got} same=${same} | open=${JSON.stringify(open)} new=${JSON.stringify(req)}`);
}
console.log(`TOTAL rows=${rows.length} unsafe_overmatch=${unsafe} under_match=${missed}`);
