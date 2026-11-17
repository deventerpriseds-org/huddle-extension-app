// WHAT:       Verify loop 6 C8 adversarial probe of matchOpenTitle (row 7 "one request makes one task").
// WHY:        Loop 4 refuted the prefix rule; this probes the description-backed replacement at 83e1eb30.
// SUPERSEDES: verify-handoff-confirm-flow-4-c8-probe.ts (loop 4).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-handoff-confirm-flow-6-C8.md
import { test } from "bun:test";
import { matchOpenTitle, normalizeTaskTitle as n } from "../src/features/huddle/lib/tasks/create-task-core.ts";

type Row = { id: string; open: [string, string][]; ask: string; want: "dup" | "new"; why: string };
const rows: Row[] = [
  // (1) loop-4 C8 rows, now with realistic descriptions
  { id: "L4-gift", open: [["Buy birthday gift", "Buy a birthday gift"]], ask: "Buy birthday gift for Sarah", want: "new", why: "loop4 refuting row" },
  { id: "L4-gift-desc-sarah", open: [["Buy birthday gift", "Buy a birthday gift for Sarah"]], ask: "Buy birthday gift for Sarah", want: "dup", why: "journey shortened" },
  { id: "UMF-exact", open: [["Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold."]], ask: "Obtain official transcript and send it directly to UM-Flint to remove the registration hold", want: "dup", why: "real bug" },
  // (2) UNSAFE over-match hunt
  { id: "john-receipt", open: [["Email John Smith", "Send John the signed lease and the deposit receipt"]], ask: "Email John Smith the deposit receipt", want: "dup", why: "subset of the open task (argued same)" },
  { id: "bill-next-month", open: [["Pay electric bill", "Pay the October electric bill before it is due November 5."]], ask: "Pay electric bill for November", want: "new", why: "recurring: Nov bill is a different task" },
  { id: "gift-other-person", open: [["Buy birthday gift", "Buy a birthday gift for Sarah; ask Tom what she likes."]], ask: "Buy birthday gift for Tom", want: "new", why: "Tom named in a different role" },
  { id: "flight-return", open: [["Book flight to Chicago", "Book flight to Chicago for the conference, flying back to Denver Sunday."]], ask: "Book flight to Chicago for Denver team offsite in March", want: "new", why: "different trip" },
  { id: "call-bank-fraud", open: [["Call the bank", "Call the bank to dispute the duplicate charge on the credit card."]], ask: "Call the bank about credit card fraud", want: "new", why: "fraud report vs dispute" },
  { id: "stem-collide", open: [["Email the registrar", "Email the registrar about the transfer credits from community college."]], ask: "Email the registrar the transcript request", want: "new", why: "tran-stem: transfer vs transcript" },
  { id: "call-mom-later", open: [["Call mom", "Call mom about Thanksgiving and the doctor appointment next week."]], ask: "Call mom about the doctor appointment results", want: "new", why: "follow-up after appointment" },
  // (3) UNDER-match hunt of the real UM-Flint shape
  { id: "UMF-para-mail", open: [["Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold."]], ask: "Obtain official transcript and have it mailed to UM-Flint", want: "dup", why: "paraphrase" },
  { id: "UMF-para-short", open: [["Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold."]], ask: "Obtain official transcript for UM-Flint", want: "dup", why: "paraphrase short" },
  { id: "UMF-reword-verb", open: [["Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold."]], ask: "Get official transcript sent to UM-Flint", want: "dup", why: "different verb, no prefix" },
];

for (const r of rows) {
  test(`${r.id}`, () => {
    const titles = new Set(r.open.map(([t]) => n(t)));
    const descriptions = new Map(r.open.map(([t, d]) => [n(t), d] as [string, string]));
    const m = matchOpenTitle(n(r.ask), titles, descriptions);
    const got = m ? "dup" : "new";
    console.log(`ROW ${r.id} want=${r.want} got=${got} ${got === r.want ? "OK" : r.want === "new" ? "UNSAFE-OVERMATCH" : "under-match"} | ${r.why}`);
  });
}
