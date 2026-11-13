// WHAT:       Verifier loop-3 probes on the proposal validator (red-team F3-F7, F10-F13) with spellings beyond
//             the implementer's tests. Prints PROBE <id> <accepted/rejected + fields>.
// WHY:        Tier 1: the validator is the guard between model output and stored proposals.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-3.md
import { validateCandidates, resolveDueDate, titleKey } from "../src/features/huddle/lib/proposals/proposals";

const ctx = { atIso: "2026-11-12T15:00:00Z", tz: "America/New_York" };
const run = (id: string, src: string, task: Record<string, unknown>) => {
  const r = validateCandidates({ tasks: [task] }, src, ctx);
  const a = r.accepted[0];
  console.log(`PROBE ${id} ${a ? "ACCEPTED " + JSON.stringify({ title: a.title, ev: a.evidence, who: a.assignee, due: a.dueDate, dueText: a.dueText }) : "rejected " + JSON.stringify(r.rejected)}`);
};

// F4 invented amount/account
run("F4a", "Please send the invoice to Dana by Friday.", { task: "Send the invoice and a $40,000 wire to Dana", evidence: "send the invoice to Dana by Friday" });
run("F4b", "Please send the invoice to Dana by Friday.", { task: "Send invoice to Dana's new account 99-1234", evidence: "send the invoice to Dana by Friday" });
run("F4c", "Please pay the vendor invoice this week.", { task: "Pay the vendor invoice twice", evidence: "pay the vendor invoice this week" });
run("F4d", "Please pay the vendor invoice this week.", { task: "Pay all vendor invoices from the reserve fund", evidence: "pay the vendor invoice this week" });
// F5 pleasantry
run("F5a", "We loved the deck you sent last week, thanks!", { task: "Redo the deck you sent", evidence: "loved the deck you sent last week" });
run("F5b", "Thanks for sending the budget review yesterday, it was great.", { task: "Send the budget review", evidence: "Thanks for sending the budget review yesterday" });
// F7 negation spellings
const NEG = "Under no circumstances should you send the contract to the client before legal signs.";
run("F7a under no circumstances", NEG, { task: "Send the contract to the client", evidence: "send the contract to the client before legal signs" });
run("F7b never, ever", "Never, ever send the contract to the client without approval.", { task: "Send the contract to the client", evidence: "send the contract to the client without approval" });
run("F7c don't, comma aside", "Please don't, under any circumstances, send the contract to the client.", { task: "Send the contract to the client", evidence: "send the contract to the client" });
run("F7d avoid", "Avoid sending the contract to the client until Monday.", { task: "Send the contract to the client", evidence: "sending the contract to the client until Monday" });
run("F7e refrain", "Refrain from sending the contract to the client this week.", { task: "Send the contract to the client", evidence: "sending the contract to the client this week" });
run("F7f negation in previous sentence-less line", "Do not do this\nsend the contract to the client today", { task: "Send the contract to the client", evidence: "send the contract to the client today" });
run("F7g control", "Please do NOT send the contract to the client until legal signs off.", { task: "Send the contract to the client", evidence: "send the contract to the client until legal signs off" });
run("F7h no need", "There is no reason to send the contract to the client now.", { task: "Send the contract to the client", evidence: "send the contract to the client now" });
// F3 impossible dates and F10/F11 due words
for (const d of ["2026-02-30", "2026-13-45", "Feb 30", "February 30", "31 April", "April 31", "2027-02-29", "30th of February", "11/31", "13/1"]) {
  let v: unknown;
  try { v = resolveDueDate(d, ctx.atIso, ctx.tz); } catch (e) { v = "THROW " + (e as Error).message; }
  console.log(`PROBE F3 resolveDueDate(${JSON.stringify(d)}) ${JSON.stringify(v)}`);
}
run("F11a modal may", "You may send the revised deck whenever you are ready.", { task: "Send the revised deck", evidence: "You may send the revised deck whenever you are ready", due_text: "may" });
run("F11b 'march' verb", "We will march the proposal to legal by Friday.", { task: "Take the proposal to legal", evidence: "march the proposal to legal by Friday", due_text: "by Friday" });
run("F11c 'sat' verb as date", "The report sat on my desk, please file it by sat.", { task: "File the report", evidence: "please file it by sat", due_text: "by sat" });
run("F10 due number not date", "Please order 3 laptops for the new hires.", { task: "Order 3 laptops for the new hires", evidence: "Please order 3 laptops for the new hires", due_text: "3" });
// F12 assignee
run("F12a requester variants", "Dana said to send the deck to finance by Friday.", { task: "Send the deck to finance", evidence: "Dana said to send the deck to finance by Friday", assignee: "Dana" });
run("F12b cc'd name", "Please send the deck to Dana by Friday.", { task: "Send the deck to Dana", evidence: "Please send the deck to Dana by Friday", assignee: "Dana" });
// F13 title look-alikes
for (const t of ["Send​ the Q3 deck", "Ｓｅｎｄ the Q3 deck", "Sеnd the Q3 deck", "Send the Q3 deck­", "Send the Q3 deck⁠"]) {
  console.log(`PROBE F13 titleKey(${JSON.stringify(t)}) === titleKey("Send the Q3 deck") -> ${titleKey(t) === titleKey("Send the Q3 deck")}`);
}
// RTL override / bidi in title
console.log(`PROBE F13 bidi ${titleKey("Send the ‮Q3 deck") === titleKey("Send the Q3 deck")}`);
