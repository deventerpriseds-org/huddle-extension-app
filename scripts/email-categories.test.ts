// WHAT:       Proves the email-alert category toggles and the stronger "already replied" check:
//             real senders measured 2026-11-05 land in the right category, each toggle flips its
//             verdict, bulk mail stays out even when its category is ON, the no-reply fix catches
//             microsoft-noreply@/azure-noreply@ without catching look-alikes, and answeredRowIds settles
//             a reply by conversation OR by recipient, only when sent AFTER the email arrived.
// WHY:        Owner, 2026-11-05: newsletters/invoices on the owed list; "they need toggles because the
//             evite reminder was helpful"; "self clear by checking if i replied before including for sure".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:owed-digest; dry run run-inbound-email.yml 42110379642.
import {
  categorizeMessage,
  isAutomatedAddress,
  resolveEmailCategoryPolicy,
  screenMessage,
  type InboundMessage,
} from "../src/features/huddle/lib/email/inbound-email";
import { answeredRowIds } from "../src/features/huddle/lib/email/reply-match";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failed++;
}
const MAILBOX = "owner@example.com";
const msg = (
  fromAddress: string,
  subject: string,
  extra: Partial<InboundMessage> = {},
): InboundMessage => ({
  id: fromAddress + subject,
  fromAddress,
  subject,
  bodyText: "Please let me know.",
  headerNames: ["from", "to"],
  inferenceClassification: "focused",
  ...extra,
});

// 1. The spelling table: real senders from the 2026-11-05 owed list -> category.
const table: [string, string, string | null][] = [
  ["info@mailva.evite.com", "Reminder: Abel and Grishma's 50th is coming up", "events"],
  ["info@mailva.evite.com", "Grishma Joy sent you a new message", "events"],
  ["terra.92920@emailrelay.com", "Guest Parking Information!", "community"],
  ["terra@clsliving.com", "Pay Your Rent Online", "community"],
  ["microsoft-noreply@microsoft.com", "Your Microsoft invoice G193334924 is ready", "bills"],
  [
    "microsoft-noreply@microsoft.com",
    "Your Windows 365 Business subscription is renewing",
    "bills",
  ],
  [
    "azure-noreply@microsoft.com",
    "Retirement Notice: Transition Azure Database for PostgreSQL",
    "service",
  ],
  [
    "confirmations@travel.guestreservations.com",
    "Guest Reservations - Reservation Confirmation #R6633759295",
    "bookings",
  ],
  // Over-match negatives: real people stay uncategorised.
  ["wentink@umich.edu", "UM-Flint Required Admission Document(s) Follow-up", null],
  ["sinhar@cdmsmith.com", "New Hire Missing Paperwork", null],
  ["amy.corriveau@trinnex.io", "Invoice question for the Q3 work", null],
  ["sarah@example.com", "Your order of cookies is ready to pick up?", null],
];
for (const [from, subject, want] of table) {
  const got = categorizeMessage({ fromAddress: from, subject });
  check(`categorize ${from} "${subject.slice(0, 30)}" -> ${want}`, got === want, got);
}

// 2. Default toggles: events ON, everything else OFF.
const def = resolveEmailCategoryPolicy();
const evite = msg("info@mailva.evite.com", "Reminder: Abel and Grishma's 50th is coming up");
const terra = msg("terra.92920@emailrelay.com", "Guest Parking Information!");
const msInvoice = msg("microsoft-noreply@microsoft.com", "Your Microsoft invoice is ready");
check(
  "default: Evite reminder kept",
  screenMessage(evite, "needs-reply", MAILBOX, def).keep === true,
);
const tv = screenMessage(terra, "needs-reply", MAILBOX, def);
check(
  "default: Terra notice screened (category-off: community)",
  !tv.keep && tv.reason === "category-off" && tv.category === "community",
  tv,
);
check(
  "default: Microsoft invoice screened",
  screenMessage(msInvoice, "needs-reply", MAILBOX, def).keep === false,
);
check(
  "default: real person still kept",
  screenMessage(msg("wentink@umich.edu", "Follow-up"), "needs-reply", MAILBOX, def).keep === true,
);

// 3. Each toggle flips.
const eventsOff = resolveEmailCategoryPolicy({ events: { on: false } });
check(
  "events OFF: Evite screened",
  screenMessage(evite, "needs-reply", MAILBOX, eventsOff).keep === false,
);
const communityOn = resolveEmailCategoryPolicy({ community: { on: true } });
check(
  "community ON: Terra kept",
  screenMessage(terra, "needs-reply", MAILBOX, communityOn).keep === true,
);
const billsOn = resolveEmailCategoryPolicy({ bills: { on: true } });
check(
  "bills ON: Microsoft invoice kept even from no-reply",
  screenMessage(msInvoice, "needs-reply", MAILBOX, billsOn).keep === true,
);
const extra = resolveEmailCategoryPolicy({ community: { domains: ["@MyHOA.org"] } });
check(
  "extra domain (normalised) categorises",
  categorizeMessage({ fromAddress: "board@mail.myhoa.org", subject: "x" }, extra) === "community",
);

// 4. Bulk stays out even when its category is ON.
const eviteBulk = { ...evite, headerNames: ["from", "list-unsubscribe"] };
check(
  "events ON but bulk header: screened",
  screenMessage(eviteBulk, "needs-reply", MAILBOX, def).keep === false,
);
check("all mode still keeps everything", screenMessage(terra, "all", MAILBOX, def).keep === true);

// 5. No-reply segment fix, with look-alike negatives.
for (const a of [
  "microsoft-noreply@microsoft.com",
  "azure-noreply@microsoft.com",
  "billing.no-reply@x.com",
  "noreply@x.com",
  "do-not-reply_us@x.com",
])
  check(`automated: ${a}`, isAutomatedAddress(a) === true);
for (const a of ["snoreplyx@x.com", "noreplyhenry@x.com", "sarah@x.com", "team.lead@x.com"])
  check(`not automated: ${a}`, isAutomatedAddress(a) === false);

// 6. Already-replied matching.
const rows = [
  {
    id: "conv",
    conversation_id: "C1",
    from_address: "a@x.com",
    received_at: "2026-11-01T10:00:00Z",
  },
  { id: "to", conversation_id: "C2", from_address: "B@x.com", received_at: "2026-11-01T10:00:00Z" },
  {
    id: "before",
    conversation_id: "C3",
    from_address: "c@x.com",
    received_at: "2026-11-03T10:00:00Z",
  },
  {
    id: "none",
    conversation_id: "C4",
    from_address: "d@x.com",
    received_at: "2026-11-01T10:00:00Z",
  },
  { id: "undated", conversation_id: "C5", from_address: "e@x.com", received_at: null },
];
const sent = [
  { sentDateTime: "2026-11-02T09:00:00Z", conversationId: "C1", recipients: ["someone@else.com"] },
  { sentDateTime: "2026-11-02T09:00:00Z", conversationId: "NEW", recipients: ["b@x.com"] },
  { sentDateTime: "2026-11-02T09:00:00Z", conversationId: "C3", recipients: ["c@x.com"] },
  { sentDateTime: null, conversationId: "C4", recipients: ["d@x.com"] },
  { sentDateTime: "2026-11-02T09:00:00Z", conversationId: "C5", recipients: ["e@x.com"] },
];
const ans = answeredRowIds(rows, sent).sort().join(",");
check("replied: same conversation after arrival", ans.includes("conv"), ans);
check("replied: new email to the sender (case-insensitive)", ans.includes("to"), ans);
check("not replied: sent BEFORE the email arrived", !ans.includes("before"), ans);
check("not replied: sent item with no timestamp", !ans.includes("none"), ans);
check("not replied: undated owed row never settles", !ans.includes("undated"), ans);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
