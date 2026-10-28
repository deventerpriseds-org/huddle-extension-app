// WHAT:       Proves the instant-email-alert plumbing: only notifications carrying OUR clientState are
//             trusted, the subscription is created/renewed/kept at the right times, quiet hours hold,
//             and the email-alert push names the sender and is sticky (other pushes unchanged).
// WHY:        2026-10-27: an email waited 3m23s for the 5-minute poll, and its push read "Iris Chase
//             replied" — the owner asked for instant, clearly-labelled alerts that stay until dismissed.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:instant-email-alerts. Run: bun scripts/mail-subscription.test.ts

import {
  mailClientState,
  subscriptionAction,
  trustedSubscriptionIds,
  withinAlertHours,
} from "../src/features/huddle/lib/email/mail-subscription";
import { inboundEmailPush } from "../src/features/huddle/lib/email/inbound-email";
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const cs = mailClientState("secret-token");
check(
  "S1 clientState is derived, never the raw token",
  cs !== "secret-token" && !cs.includes("secret") && cs.length === 64,
);
check(
  "S2 clientState is stable",
  cs === mailClientState("secret-token") && cs !== mailClientState("other"),
);

const body = {
  value: [
    { subscriptionId: "sub-1", clientState: cs, changeType: "created" },
    { subscriptionId: "sub-1", clientState: cs, changeType: "created" },
    { subscriptionId: "sub-forged", clientState: "wrong", changeType: "created" },
    { subscriptionId: "sub-nocs", changeType: "created" },
    { subscriptionId: "sub-2", clientState: cs },
  ],
};
const ids = trustedSubscriptionIds(body, cs);
check(
  "S3 only our clientState is trusted, deduped",
  JSON.stringify(ids) === '["sub-1","sub-2"]',
  JSON.stringify(ids),
);
check(
  "S4 garbage body -> nothing",
  trustedSubscriptionIds({ value: "x" }, cs).length === 0 &&
    trustedSubscriptionIds(null, cs).length === 0,
);
check(
  "S5 empty expected clientState trusts nothing",
  trustedSubscriptionIds(body, "").length === 0,
);

const now = Date.parse("2026-10-27T18:00:00Z");
const url = "https://app.example/api/public/graph-mail-notify";
const row = (expiresInH: number, ageH: number, u = url) => ({
  subscription_id: "s",
  expires_at: new Date(now + expiresInH * 3_600_000).toISOString(),
  updated_at: new Date(now - ageH * 3_600_000).toISOString(),
  notification_url: u,
});
check("S6 no row -> create", subscriptionAction(null, url, now) === "create");
check("S7 fresh row -> keep", subscriptionAction(row(60, 1), url, now) === "keep");
check("S8 <24h left -> renew", subscriptionAction(row(10, 1), url, now) === "renew");
check("S9 older than 12h -> renew", subscriptionAction(row(60, 13), url, now) === "renew");
check("S10 expired -> create", subscriptionAction(row(-1, 1), url, now) === "create");
check(
  "S11 host changed -> create",
  subscriptionAction(row(60, 1, "https://old/x"), url, now) === "create",
);

const hours = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
check(
  "S12 1:43pm ET is inside alert hours",
  withinAlertHours(hours, "America/New_York", Date.parse("2026-10-27T17:43:00Z")),
);
check(
  "S13 2am ET is outside alert hours",
  !withinAlertHours(hours, "America/New_York", Date.parse("2026-10-27T06:00:00Z")),
);
check("S14 bad time zone fails open", withinAlertHours(hours, "Not/AZone", now));

const p = inboundEmailPush({ fromName: "Corriveau, Amy", fromAddress: "Amy.Corriveau@trinnex.io" });
check(
  "P1 title names the sender, First Last",
  p?.title === "New email from Amy Corriveau — draft reply ready",
  p?.title,
);
check("P2 email alert is sticky", p?.sticky === true);
check(
  "P3 falls back to the address",
  inboundEmailPush({ fromAddress: "a@b.co" })?.title ===
    "New email from a@b.co — draft reply ready",
);
check("P4 any other turn keeps the old push", inboundEmailPush(undefined) === null);

const fns = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
check(
  "P5 push delivery uses the email title (via turnPushStyle, which defers to inboundEmailPush)",
  /stylePush = turnPushStyle\(record\.payload\);/.test(fns) &&
    /const title = stylePush\?\.title \?\? `\$\{name\} replied`;/.test(fns),
);
check(
  "P6 push delivery forwards sticky",
  /\.\.\.\(stylePush\?\.sticky \? \{ sticky: "true" \} : \{\}\)/.test(fns),
);

const route = readFileSync("src/routes/api/public/graph-mail-notify.ts", "utf8");
check(
  "R1 route echoes the validation token as text/plain",
  /new Response\(validationToken,[\s\S]*?text\/plain/.test(route),
);
check(
  "R2 route only acts on trusted subscription ids",
  route.includes("trustedSubscriptionIds(body, mailClientState(token))"),
);
check("R3 route honours alert hours", route.includes("withinAlertHours(cadence.hours, cadence.tz"));
const watch = readFileSync("src/features/huddle/lib/email/inbound-email.server.ts", "utf8");
check(
  "R4 the 5-minute check keeps the subscription alive (non-dry runs)",
  /if \(!opts\.dryRun\) \{\s*const \{ ensureMailSubscription \}/.test(watch),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
