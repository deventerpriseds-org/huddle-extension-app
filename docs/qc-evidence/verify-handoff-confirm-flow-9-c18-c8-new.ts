// WHAT: loop 9 C18 NEW C8 over-match hunt against the real matchOpenTitle at e45abd80
// WHY:  loop 8 refuted short-word collisions; fix 0ea0a387. Hunt the 5-letter prefix rule + numbers/dates.
// RUN:  bun docs/qc-evidence/verify-handoff-confirm-flow-9-c18-c8-new.ts
import { matchOpenTitle, normalizeTaskTitle as n } from "../../src/features/huddle/lib/tasks/create-task-core";
const rows: [string, string, string, string, boolean][] = [
  ["N-grandpa", "Buy birthday gift", "Buy a birthday gift for grandma.", "Buy birthday gift for grandpa", false],
  ["N-christopher", "Send invoice", "Send the invoice to Christina.", "Send invoice to Christopher", false],
  ["N-danielle", "Email the contract", "Email the contract to Daniel.", "Email the contract to Danielle", false],
  ["N-alexandra", "Call about lease", "Call Alexander about the lease renewal.", "Call about lease with Alexandra", false],
  ["N-dec-day", "Schedule dentist", "Schedule the dentist on Dec 12.", "Schedule dentist Dec 5", false],
  ["N-party-size", "Book table", "Book a table at Nobu for 4.", "Book table for 2 at Nobu", false],
  ["N-time", "Book massage", "Book a massage at the spa at 3pm.", "Book massage at the spa at 5pm", false],
  ["N-room", "Reserve hotel", "Reserve a hotel room in Austin for two nights.", "Reserve hotel room in Austin for three nights", false],
  ["N-manager-mgmt", "Email the report", "Email the report to the management team.", "Email the report to my manager", false],
  ["N-photo", "Order prints", "Order prints from the photographer.", "Order prints of the photo", false],
  ["N-train", "Sign up", "Sign up for the training course.", "Sign up for the train pass", false],
  ["N-same-time", "Book massage", "Book a massage at the spa at 5pm.", "Book massage at the spa at 5pm", true],
];
let unsafe = 0;
for (const [label, open, desc, req, same] of rows) {
  const got = matchOpenTitle(n(req), new Set([n(open)]), new Map([[n(open), desc]])) !== null;
  const tag = got === same ? "ok      " : got ? "UNSAFE  " : "UNDER   ";
  if (got && !same) unsafe++;
  console.log(`${tag} ${label.padEnd(16)} blocked=${got} same=${same} | open=${JSON.stringify(open)} desc=${JSON.stringify(desc)} new=${JSON.stringify(req)}`);
}
console.log(`TOTAL rows=${rows.length} unsafe_overmatch=${unsafe}`);
