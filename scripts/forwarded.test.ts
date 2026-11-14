// WHAT:          Offline suite for lib/correspondence/forwarded.ts (the forwarded email inside a "Fw:" message).
// WHY:           Owner 2026-11-14: two "Fw: ... Due ..." emails were judged "only a name and phone number" because the
//                live text path cuts at Outlook's forward header. Also PINS that the live path (htmlToText) still cuts.
// SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/reply-scan-preview.ts step=action.
// Run: bun scripts/forwarded.test.ts        ALL DATA SYNTHETIC.
import { forwardedText, FORWARD_SUBJECT } from "../src/features/huddle/lib/correspondence/forwarded";
import { htmlToText } from "../src/features/huddle/lib/external-feeds/onedrive-feed";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name} :: ${JSON.stringify(got)}`);
  }
};

const fwdHtml =
  '<div>Thanks,<br>Pat Example<br>555-0100</div>' +
  '<div id="divRplyFwdMsg"><b>From:</b> Compliance Team<br><b>Sent:</b> Monday<br><b>Subject:</b> REMINDER</div>' +
  "<div>Please complete the Risk Assessment by November 12.</div>" +
  '<div id="divRplyFwdMsg"><b>From:</b> Older<br>older history text</div>';

t("F1 subject Fw: is a forward", FORWARD_SUBJECT.test("Fw: REMINDER: thing"));
t("F2 subject FWD: is a forward", FORWARD_SUBJECT.test("FWD: x"));
t("F3 subject RE: FW: is a forward", FORWARD_SUBJECT.test("RE: FW: x"));
t("F4 subject Re: only is NOT a forward", !FORWARD_SUBJECT.test("Re: Fw stuff"));
t("F5 subject with Fw later is NOT a forward", !FORWARD_SUBJECT.test("Notes on the Fw: topic"));

const f = forwardedText("Fw: REMINDER", fwdHtml, true) ?? "";
t("F6 forwarded body is kept", f.includes("Please complete the Risk Assessment by November 12."), f);
t("F7 forwarded header kept", f.includes("Compliance Team"), f);
t("F8 the forward's OWN older history is still cut", !f.includes("older history text"), f);
t("F9 the forwarder's signature is not in the forwarded part", !f.includes("555-0100"), f);
t("F10 not a forward -> null even with a marker", forwardedText("Re: REMINDER", fwdHtml, true) === null);
t("F11 forward with no marker -> null", forwardedText("Fw: x", "<div>just text</div>", true) === null);
t("F12 empty body -> null", forwardedText("Fw: x", "", true) === null);

const plain = "See below.\n\n-----Original Message-----\nFrom: A\nPlease send the timesheet today.";
const p = forwardedText("FW: timesheet", plain, false) ?? "";
t("F13 plain-text forward keeps the forwarded part", p.includes("Please send the timesheet today.") && !p.startsWith("See below"), p);
t("F14 plain-text forward with nothing forwarded -> null", forwardedText("FW: x", "only new words here", false) === null);
t("F15 cap respected", (forwardedText("Fw: x", '<div id="divRplyFwdMsg">' + "y".repeat(9000) + "</div>", true, 100) ?? "").length <= 100);

// PIN: the live path is unchanged -- htmlToText still drops everything from the forward header on.
const live = htmlToText(fwdHtml);
t("P1 LIVE htmlToText still cuts the forwarded part (Iris unchanged)", !live.includes("Risk Assessment") && live.includes("555-0100"), live);

console.log(`forwarded: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
