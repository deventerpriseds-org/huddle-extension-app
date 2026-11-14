// WHAT:       Verifier loop 6: newTextOnly branch vs origin/main on two-line ("On ..." / "wrote:") wrapped attributions,
//             plus the (now report-only) isWrappedAttribution detector, on real-client stamps and English sentences.
// WHY:        Coordinator claim (a): after ddc7b55d the live screen must match main on every wrapped shape; and X3-X6:
//             the detector must still cut real stamps and keep English.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-6.md. All data synthetic (.example).
import { isWrappedAttribution, newTextOnly } from "../src/features/huddle/lib/email/inbound-email";
import { newTextOnly as mainNTO } from "./verify5-main/inbound-email";

const det = (body: string) => {
  const ls = body.replace(/\r/g, "").split("\n");
  return ls.some((l, i) => i + 1 < ls.length && isWrappedAttribution(l, ls[i + 1]));
};
const ASK = "Can you send the ledger by Friday?";
// [id, first line, second line, expected detector verdict]
const rows: [string, string, string, boolean][] = [
  ["gmail-email", "On Mon, Nov 10, 2025 at 9:14 AM Dana Kim <dana@corp.example>", "wrote:", true],
  ["gmail-name", "On Mon, Nov 10, 2025 at 9:14 AM Dana Kim", "wrote:", true],
  ["gmail-name-24h", "On Mon, 10 Nov 2025 at 21:14, Dana Kim", "wrote:", true],
  ["gmail-split-name", "On Mon, Nov 10, 2025 at 9:14 AM Dana", "Kim <dana@corp.example> wrote:", true],
  ["apple-email", "On Nov 10, 2025, at 9:14 AM, Dana Kim <dana@corp.example>", "wrote:", true],
  ["apple-name", "On Nov 10, 2025, at 9:14 AM, Dana Kim", "wrote:", true],
  ["apple-iphone", "On Nov 10, 2025, at 09:14, Dana Kim <dana@corp.example>", "wrote:", true],
  ["outlook-mobile", "On Mon, Nov 10, 2025 at 9:14 AM -0500, \"Dana Kim\" <dana@corp.example>", "wrote:", true],
  ["outlook-mobile-name", "On Mon, Nov 10, 2025 at 9:14 AM -0500, Dana Kim", "wrote:", true],
  ["thunderbird", "On 11/10/25 9:14 AM, Dana Kim", "wrote:", true],
  ["gmail-no-year-name", "On Mon, Nov 10 at 9:14 AM Dana Kim", "wrote:", false],
  ["gmail-no-time-name", "On Mon, Nov 10, 2025 Dana Kim", "wrote:", false],
  ["en-X3", "On the 12 open items from 2024 we may still owe Finance, and Dana", "wrote:", false],
  ["en-X4", "On the 3 invoices from 2025 it turns out Pat", "Kim wrote:", false],
  ["en-X5", "On Friday 14 at 10:30 the vendor called and Legal", "wrote:", false],
  ["en-X6", "On the 2 dates set for 2026 Ops", "wrote:", false],
  ["en-may-year-time", "On May 3 at 9:30 the 2024 board met and Legal", "wrote:", false],
  ["en-sat-year-time", "On Sat 4 at 10:15 for the 2025 audit our CFO", "wrote:", false],
  ["en-mar-time-year", "On Mar 9 the 2025 deadline moved to 17:00 and Finance", "wrote:", false],
  ["en-lowercase-name", "On Mon, Nov 10, 2025 at 9:14 AM the team", "wrote:", false],
  ["en-I", "On Mon, Nov 10, 2025 at 9:14 AM I", "wrote:", false],
  ["en-no-date", "On Friday after the board meeting,", "the vendor wrote:", false],
];
let bad = 0;
for (const [id, a, b, want] of rows) {
  const body = `Sounds good.\n\n${a}\n${b}\n${ASK}`;
  const br = newTextOnly(body);
  const mn = mainNTO(body);
  const d = det(body);
  const same = br === mn;
  const ok = same && d === want;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BAD "} ${id.padEnd(22)} live==main:${same} branchKeepsAsk:${br.includes("send the ledger")} mainKeepsAsk:${mn.includes("send the ledger")} detector:${d} (want ${want})`);
}
console.log(`rows=${rows.length} bad=${bad}`);
