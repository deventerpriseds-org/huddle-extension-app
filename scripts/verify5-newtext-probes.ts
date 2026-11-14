// WHAT:       Verifier loop 5: newTextOnly branch vs origin/main on X1/X2 and NEW spellings, both directions.
// WHY:        Claims 4 and 12 (D2). SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-5.md. All data synthetic.
import { newTextOnly as branch } from "../src/features/huddle/lib/email/inbound-email";
import { newTextOnly as main } from "./verify5-main/inbound-email";
const C: [string, string][] = [
  ["X1", "Status below.\nOn Nov 12 the auditor sent these questions and Pat\nalso wrote:\nCan you send the ledger by Monday?"],
  ["X2", "On 3 occasions the client\ncomplained, and today she wrote:\nCan you call her back?"],
  // NEW English content that satisfies every isWrappedAttribution test (DATE_NAME matches English 'may'/'out'/'set').
  ["X3-may", "Quick note.\nOn the 12 open items from 2024 we may still owe Finance, and Dana\nwrote:\nCan you send the ledger by Monday?"],
  ["X4-out", "On the 3 invoices from 2025 it turns out Pat\nKim wrote:\nCan you approve the PO by Friday?\nThanks"],
  ["X5-time", "On Friday 14 at 10:30 the vendor called and Legal\nwrote:\nCan you sign the NDA today?"],
  ["X6-set", "On the 2 dates set for 2026 Ops\nwrote:\nCan you confirm the venue?"],
  // Real Gmail wraps (must cut).
  ["G1-gmail", "Sounds good.\nOn Mon, Nov 10, 2025 at 9:14 AM Dana Kim <dana@example.com>\nwrote:\n> Can you send the ledger?"],
  ["G2-gmail-name", "Sounds good.\nOn Tue, 11 Nov 2025 at 09:14, Dana Kim\nwrote:\nCan you send the ledger?"],
  // Non-English headers: English sentences that look like them (must keep).
  ["N-van", "Logistics plan.\nVan: 12-seat, booked\nDatum: tbd\nCan you confirm pickup at 9?"],
  ["N-da", "Da: the team\nData: attached below\nCan you review it today?"],
  ["N-de", "De: rien\nDate: Friday\nCan you confirm?"],
  // Real translated headers (must cut).
  ["T-fr", "Merci.\nDe : Dana <dana@example.com>\nEnvoyé : lundi 10 novembre 2025 09:14\nÀ : Pat\nObjet : budget\nPouvez-vous signer ?"],
  ["T-de-attr", "Danke.\nAm Mo., 10. Nov. 2025 um 09:14 Uhr schrieb Dana Kim <dana@example.com>:\nKannst du das signieren?"],
];
for (const [id, body] of C) {
  const b = branch(body), m = main(body);
  console.log(`${id.padEnd(14)} ${b === m ? "same" : "DIFF"}\n   branch=${JSON.stringify(b)}\n   main  =${JSON.stringify(m)}`);
}
