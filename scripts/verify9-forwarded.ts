// WHAT:       Verifier loop 9, claim 3: forwardedText / FORWARD_SUBJECT (lib/correspondence/forwarded.ts) -- a subject
//             spelling table with over-match negatives, the two forward body shapes (Outlook marker; plain From/Sent
//             header) and realistic variants, plus hostile-input bounds (never throws, bounded time and length).
// WHY:        forwarded.ts is new preview-only code; its own suite covers 17 hand-picked cases.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-9.md
// Run: bun scripts/verify9-forwarded.ts. All data synthetic.
import { forwardedText, FORWARD_SUBJECT } from "../src/features/huddle/lib/correspondence/forwarded";

const ASK = "Please complete the risk assessment by November 12.";
let bad = 0;
const row = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "DIFF"} ${name.padEnd(58)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

console.log("--- subject spelling table (want = what a reader would call a forward) ---");
const subjects: [string, boolean, string][] = [
  ["FW: Q4 budget", true, "Outlook en"],
  ["Fw: Q4 budget", true, "Outlook en (new Outlook casing)"],
  ["Fwd: Q4 budget", true, "Gmail en"],
  ["FWD: Q4 budget", true, "upper"],
  ["RE: FW: Q4 budget", true, "reply to a forward"],
  ["Re: Re: Fwd: Q4 budget", true, "Gmail chain"],
  ["TR: Q4 budget", true, "Outlook fr (transfert)"],
  ["WG: Q4 budget", true, "Outlook de (weitergeleitet)"],
  ["AW: WG: Q4 budget", true, "de reply to forward"],
  ["RV: Q4 budget", true, "Outlook es (reenviado)"],
  ["Doorst: Q4 budget", true, "Outlook nl"],
  ["Fw : Q4 budget", true, "space before colon"],
  ["  FW: Q4 budget", true, "leading space"],
  ["[EXTERNAL] FW: Q4 budget", true, "corporate external tag"],
  ["EXT: FW: Q4 budget", true, "external prefix"],
  ["ENC: Q4 budget", true, "Outlook pt (encaminhada)"],
  ["I: Q4 budget", true, "Outlook it (inoltrato)"],
  ["VS: Q4 budget", true, "Outlook da/no (videresendt)"],
  ["VB: Q4 budget", true, "Outlook sv (vidarebefordrat)"],
  ["VL: Q4 budget", true, "Outlook fi (valitettu)"],
  ["PD: Q4 budget", true, "Outlook pl (przekazanie dalej)"],
  ["Antw: Fw: Q4 budget", true, "nl reply prefix"],
  ["FW：Q4 budget", true, "full-width colon (CJK clients)"],
  ["Re[2]: Fw: Q4 budget", true, "counted reply prefix"],
  // over-match negatives
  ["Re: Q4 budget", false, "reply only"],
  ["Q4 budget fw: notes", false, "fw later"],
  ["Fwiw: the budget", false, "word starting fw"],
  ["Trial: Q4 budget", false, "word starting tr"],
  ["RV: cabin for sale", false, "RV = recreational vehicle (collides with es prefix)"],
  ["TR: tax return question", false, "TR abbreviation (collides with fr prefix)"],
  ["WG: flat share keys", false, "WG = Wohngemeinschaft (collides with de prefix)"],
];
for (const [s, want, note] of subjects) row(`subject "${s}" (${note})`, FORWARD_SUBJECT.test(s), want);

console.log("--- body shapes ---");
const fwdHeader = '<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Compliance Team &lt;team@corp.example&gt;<br><b>Sent:</b> Monday, November 9, 2026 9:00 AM<br><b>To:</b> All<br><b>Subject:</b> REMINDER</font><div>&nbsp;</div></div>';
const shapes: [string, string, boolean, string | null][] = [
  ["outlook classic: divRplyFwdMsg only", `<div>Thanks,<br>Pat<br>555-0100</div><hr>${fwdHeader}<div>${ASK}</div>`, true, ASK],
  ["OWA / new Outlook: appendonsend THEN divRplyFwdMsg", `<div>Thanks,<br>Pat<br>555-0100</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%">${fwdHeader}<div>${ASK}</div>`, true, ASK],
  ["prefixed id (x_divRplyFwdMsg, as Outlook re-forwards)", `<div>Thanks, Pat</div><div id="x_divRplyFwdMsg"><b>From:</b> Compliance Team<br><b>Sent:</b> Monday<br><b>Subject:</b> R</div><div>${ASK}</div>`, true, ASK],
  ["Gmail forward: ---------- Forwarded message ---------", `<div dir="ltr">FYI<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <b>Compliance Team</b> &lt;team@corp.example&gt;<br>Date: Mon, Nov 9, 2026 at 9:00 AM<br>Subject: REMINDER<br>To: All<br></div><br><div>${ASK}</div></div></div>`, true, ASK],
  ["plain From/Sent header, no marker", `<div>Pat<br>555-0100</div><hr><div><b>From:</b> Compliance Team<br><b>Sent:</b> Monday<br><b>Subject:</b> R</div><div>${ASK}</div>`, true, ASK],
  ["plain text, LF, Original Message", `See below.\n\n-----Original Message-----\nFrom: A\nSent: Monday\n${ASK}`, false, ASK],
  ["plain text, CRLF, Original Message", `See below.\r\n\r\n-----Original Message-----\r\nFrom: A\r\nSent: Monday\r\n${ASK}`, false, ASK],
  ["plain text, a '>' line before the forward", `See below.\n> earlier note\n\n-----Original Message-----\nFrom: A\nSent: Monday\n${ASK}`, false, ASK],
  ["plain text Gmail: Begin forwarded message", `FYI\n\nBegin forwarded message:\n\nFrom: A\nDate: Monday\n${ASK}`, false, ASK],
];
for (const [name, body, isHtml, want] of shapes) {
  const got = forwardedText("FW: REMINDER", body, isHtml);
  row(name, got !== null && got.includes(want!) ? "has ask" : got, "has ask");
}

console.log("--- hostile input: never throws, bounded ---");
const hostile: [string, unknown, unknown, boolean][] = [
  ["re: x100k then no fw", "re:".repeat(100_000), "<div>x</div>", true],
  ["spaces x100k", " ".repeat(100_000) + "x", "y", false],
  ["fw: + 2 MB of markers", "FW: x", '<div id="divRplyFwdMsg">a</div>'.repeat(60_000), true],
  ["fw: + unclosed marker div x100k", "FW: x", '<div id="divRplyFwdMsg"'.repeat(100_000), true],
  ["fw: + 1 MB plain lines", "FW: x", "line\n".repeat(200_000), false],
  ["fw: + 1 MB plain From/Sent pairs", "FW: x", "From: a\nSent: b\n".repeat(60_000), false],
  ["non-string subject/body", 12345 as unknown, { toString: () => "FW: x" } as unknown, true],
  ["null / undefined", null, undefined, false],
];
for (const [name, s, b, h] of hostile) {
  const t0 = performance.now();
  let res: string;
  try {
    const out = forwardedText(s as string, b as string, h);
    res = out === null ? "null" : `len=${out.length}`;
  } catch (e) {
    res = `THREW ${(e as Error).message}`;
    bad++;
  }
  const ms = performance.now() - t0;
  console.log(`${res.startsWith("THREW") ? "BAD " : "ok  "} ${name.padEnd(40)} -> ${res.padEnd(12)} ${ms.toFixed(0)} ms`);
}
console.log(`rows-differing-from-expectation=${bad}`);
