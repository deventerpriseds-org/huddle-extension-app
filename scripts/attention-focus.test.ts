// WHAT:       Offline checks for jumping from a bell item / phone alert to an email's reply card, and for
//             the bell's labelled Dismiss button (lib/attention/focus.ts + its wiring).
// WHY:        Owner, 2026-11-12: "The bell notifications were supposed to have a dismiss option ... Any
//             proposed draft reply should be deep linked so I can get to the place in the chat to approve,
//             copy or else." Run: npx -y tsx@4.19.2 scripts/attention-focus.test.ts
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:bell-dismiss-deeplink.
import { readFileSync } from "node:fs";
import {
  FOCUS_WAIT_MS,
  emailFocusTarget,
  focusStep,
  messageDeepLink,
  parseFocusParams,
  revealStartFor,
} from "../src/features/huddle/lib/attention/focus";
import { createFollowState } from "../src/features/huddle/lib/transcript-scroll";

let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const msgs = [
  { id: "m0" },
  { id: "m1", emailReply: { emailId: "e1" } },
  { id: "m2" },
  { id: "m3", emailReply: { emailId: "e2" } },
  { id: "m4", emailReply: { emailId: "e1" } }, // a revised reply for e1: a later card
  { id: "m5" },
];

t("F1 finds the card carrying that email's reply", emailFocusTarget(msgs, "e2"), { index: 3, id: "m3" });
t("F2 a revised reply wins: the NEWEST card for the email", emailFocusTarget(msgs, "e1"), { index: 4, id: "m4" });
t("F3 no card for the email -> null (bell falls back to opening the chat)", emailFocusTarget(msgs, "zz"), null);
t("F4 an empty id never matches a message without a card", emailFocusTarget([{ id: "a" }], ""), null);

const st = (found: boolean, hydrated: boolean, waitExpired: boolean, aboveWindow = false) =>
  focusStep({ found, hydrated, waitExpired, aboveWindow });
t("J1 card not loaded yet and history still loading -> wait", st(false, false, false), "waiting");
t("J2 history never finishes loading -> after the wait, say so (never a silent no-op)", st(false, false, true), "not-found");
t("J3 history loaded and no card -> say so at once", st(false, true, false), "not-found");
t("J4 card above the window -> reveal it first", st(true, true, false, true), "revealing");
t("J5 card in view -> land on it", st(true, false, false, false), "landing");
t("J6 the wait is a few seconds, not forever", FOCUS_WAIT_MS > 0 && FOCUS_WAIT_MS <= 10000, true);

t("R1 card above the window: open the window up to it", revealStartFor(3, 10), 3);
t("R2 card already shown: the window does not shrink", revealStartFor(12, 10), 10);
t("R3 never negative", revealStartFor(-1, 5), 0);

t("L1 deep link names the chat and the card", messageDeepLink("dm-iris-chase", "abc123"), "/?huddle=dm-iris-chase&email=abc123");
t("L2 no card -> the old chat-only link, unchanged", messageDeepLink("dm-iris-chase", ""), "/?huddle=dm-iris-chase");
t("L3 the link round-trips", parseFocusParams(messageDeepLink("dm-iris-chase", "abc123").slice(1)), { huddle: "dm-iris-chase", email: "abc123" });
t("L4 an email with no chat is ignored", parseFocusParams("?email=abc"), { huddle: null, email: null });
t("L5 encoding survives", parseFocusParams(messageDeepLink("dm-x y", "a&b").slice(1)), { huddle: "dm-x y", email: "a&b" });

{
  const f = createFollowState();
  f.open();
  f.release();
  t("S1 after a jump the transcript stops pinning to the newest message", f.shouldPin(false), false);
  t("S2 ...but a turn the user starts still pins", f.shouldPin(true), true);
}

// Wiring: each line is the call site whose removal reinstates the old behaviour.
const bell = readFileSync("src/features/huddle/components/AttentionBell.tsx", "utf8");
t("W1 tapping an email row asks the chat to focus its card", /if \(item\.kind === "email"\) store\.requestEmailFocus\(item\.huddleId, item\.id\);/.test(bell), true);
t("W2 the dismiss control is a labelled button, not an icon alone", /<X size=\{11\} \/>\s*\n\s*Dismiss\s*\n\s*<\/button>/.test(bell), true);
const app = readFileSync("src/features/huddle/components/HuddleApp.tsx", "utf8");
t("W3 a `?email=` deep link requests the focus", /if \(email\) useHuddleStore\.getState\(\)\.requestEmailFocus\(target, email\);/.test(app), true);
const fns = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
t("W4 the phone alert for an email links to its card", /deepLink: messageDeepLink\(huddleId, focusEmailId\)/.test(fns), true);
const view = readFileSync("src/features/huddle/components/HuddleView.tsx", "utf8");
t("W5 the transcript consumes the focus request and scrolls to the card", /const target = emailFocusTarget\(messages, focusRequest\.emailId\);/.test(view) && /el\.scrollIntoView\(\{ block: "center" \}\);/.test(view), true);
t("W6 the wait timer feeds the step (a stuck load cannot hang the jump)", /waitExpired: focusWaitExpired,/.test(view) && /setTimeout\(\(\) => setExpiredNonce\(nonce\), FOCUS_WAIT_MS\)/.test(view), true);
t("W7 the outcome is visible to a browser check", /data-focus-state=\{focusState \?\? undefined\}/.test(view), true);

if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
