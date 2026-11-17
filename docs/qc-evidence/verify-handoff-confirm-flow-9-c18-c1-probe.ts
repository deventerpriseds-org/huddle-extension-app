// WHAT: loop 9 C18 C1 strip probe -- rebuilds the loop-8 8-rest strip rows and hunts NEW under- and OVER-strips
//       against the real stripTeammateDeferral at e45abd80.
// RUN:  bun docs/qc-evidence/verify-handoff-confirm-flow-9-c18-c1-probe.ts
import { stripTeammateDeferral } from "../../src/features/huddle/lib/capabilities";

// [label, addressed agent, input, expectation]
//  "strip"  = must no longer promise a teammate (output must differ AND not contain the deferral)
//  "keep"   = no deferral present; output must equal input (an over-strip = UNSAFE)
//  "whole"  = the reply is only a deferral; kept by design
type Exp = "strip" | "keep" | "whole";
const rows: [string, string, string, Exp][] = [
  // --- loop 8 (8-rest) rows, rebuilt ---
  ["L8-fullname", "terry-locke", "I've drafted it. Finn Reid will handle the rest.", "strip"],
  ["L8-comma", "terry-locke", "I booked the flight, and Finn will handle the receipts.", "strip"],
  ["L8-semicolon", "terry-locke", "I booked the flight; Finn will handle the receipts.", "strip"],
  ["L8-hyphen", "terry-locke", "I booked the flight - Finn will handle the receipts.", "strip"],
  ["L8-bold", "terry-locke", "I've drafted it. **Finn** will handle the rest.", "strip"],
  ["L8-takecare", "terry-locke", "I booked it. Finn will take care of the budget.", "strip"],
  ["L8-sortout", "terry-locke", "I booked it. Finn will sort out the budget.", "strip"],
  ["L8-pickup", "terry-locke", "I booked it. Finn will pick that up.", "strip"],
  ["L8-getfinnto", "terry-locke", "I booked it. I'll get Finn to look at the numbers.", "strip"],
  ["L8-asked", "terry-locke", "I booked it. I've asked Finn.", "strip"],
  ["L8-leave", "terry-locke", "I booked it. I'll leave the budget with Finn.", "strip"],
  ["L8-overto", "terry-locke", "I booked it. Over to Finn for the numbers.", "strip"],
  ["L8-should", "terry-locke", "I booked it. Finn should take the budget part.", "strip"],
  ["L8-flagged", "terry-locke", "I booked it. I've flagged it for Finn.", "strip"],
  ["L8-guy", "terry-locke", "I booked it. Finn's your guy for the budget.", "strip"],
  ["L8-paren", "terry-locke", "I booked it. (Finn will review the budget)", "strip"],
  ["L8-whole", "terry-locke", "Finn will handle the receipts.", "whole"],
  ["L8-nostrip-numbers", "terry-locke", "Finn's numbers look great, so I booked it.", "keep"],
  ["L8-nostrip-notes", "terry-locke", "I checked with Finn's notes and booked it.", "keep"],
  // --- NEW under-strip hunt (still promises a teammate) ---
  ["N-goingto", "terry-locke", "I booked the flight. Finn is going to handle the receipts.", "strip"],
  ["N-goingto2", "terry-locke", "I booked the flight. Finn's going to sort the budget.", "strip"],
  ["N-draft", "terry-locke", "I booked the flight. I'll have Finn draft the budget.", "strip"],
  ["N-willdo", "terry-locke", "I booked the flight. Finn will do the budget.", "strip"],
  ["N-email", "terry-locke", "I booked the flight. Finn will email you the numbers.", "strip"],
  ["N-takeover", "terry-locke", "I booked the flight. Finn will take it from here.", "strip"],
  ["N-colon", "terry-locke", "I booked the flight. Next step: Finn handles the receipts.", "strip"],
  ["N-reid-only", "terry-locke", "I booked the flight. Reid will handle the receipts.", "strip"],
  ["N-italic-star", "terry-locke", "I booked the flight. *Finn* will handle the receipts.", "strip"],
  ["N-at", "terry-locke", "I booked the flight. @Finn will handle the receipts.", "strip"],
  // --- NEW OVER-strip hunt (names a teammate, NOT a deferral) ---
  ["O-charleston-city", "troy-lennox", "Done. Flights over to Charleston are booked for Friday.", "keep"],
  ["O-charleston-city2", "troy-lennox", "I booked the hotel. Over to Charleston on Friday, back Sunday.", "keep"],
  ["O-gotthisweek", "terry-locke", "Finn's got this week off, so I booked it myself.", "keep"],
  ["O-onthattrip", "terry-locke", "Finn is on that trip too, so I booked two seats.", "keep"],
  ["O-dontletknow", "terry-locke", "I booked the venue. Don't let Finn know about the surprise party.", "keep"],
  ["O-outsidelane", "terry-locke", "This is outside Finn's area, so I handled it myself.", "keep"],
  ["O-couldntget", "terry-locke", "I couldn't get Finn to respond, so I booked it myself.", "keep"],
  ["O-pingadvice", "terry-locke", "I booked it. Ping Finn anytime if you want a second opinion.", "keep"],
  ["O-sendcopy", "terry-locke", "I booked it and I'll send it to Finn too so he has a copy.", "keep"],
  ["O-finnreview-past", "terry-locke", "Since Finn will review budgets in Q1 anyway, I booked the cheaper fare.", "keep"],
  ["O-faith", "terry-locke", "I booked it in good faith. Loop in Faith's... no, kidding.", "keep"],
  ["O-cam", "terry-locke", "I ordered the dash cam. Pass it to Cam Post's address? No, I shipped it to yours.", "keep"],
  ["O-asked-user", "terry-locke", "You asked Finn. I booked it anyway.", "keep"],
];
let bad = 0;
for (const [label, who, input, exp] of rows) {
  const out = stripTeammateDeferral(input, who);
  const changed = out !== input;
  let ok: boolean;
  if (exp === "keep") ok = !changed;
  else if (exp === "whole") ok = !changed;
  else ok = changed;
  const tag = ok ? "ok    " : exp === "keep" ? "OVER  " : "UNDER ";
  if (!ok) bad++;
  console.log(`${tag} ${label.padEnd(20)} exp=${exp.padEnd(5)} | in=${JSON.stringify(input)} -> out=${JSON.stringify(out)}`);
}
console.log(`TOTAL rows=${rows.length} failing=${bad}`);
