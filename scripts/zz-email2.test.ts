import { inboundEmailDirective, DIRECTIVE_MAX } from "../src/features/huddle/lib/email/inbound-email";
import { parseChatBlocks } from "../src/features/huddle/lib/chat-format";
const email: any = { fromAddress: "sam@acme.com", fromName: "Sam Lee", subject: "Meet?", bodyText: "x ".repeat(5000), receivedDateTime: "2026-11-05T12:00:00Z", id: "e1" };
for (const ctx of [{}, { emailId: "e1", owed: 5, settledToday: 1 }] as any[]) {
  let d: string;
  try { d = inboundEmailDirective(email, "Thu 8:00 AM", ctx); } catch (e) { d = "THROW " + e; }
  console.log(J(ctx), "len", d.length, "<=max", d.length <= DIRECTIVE_MAX, "has '.,'", d.includes(".,"), "has 'ONLY in propose_email_reply'", d.includes("ONLY in propose_email_reply"));
}
function J(x: unknown) { return JSON.stringify(x); }
// B3 + B2 representative
import { briefDeliveryPlan } from "../src/features/huddle/lib/tasks/schedule-brief-run.server";
const base: any = { ok: true, edition: "morning", forDate: "2026-10-15", errors: [] };
const re = briefDeliveryPlan({ ...base, items: [], errors: ["classes: http_500"] }, "America/New_York");
console.log("B3 read-error kind", re.kind, "block", re.appendBlock ?? "(none)");
const win = briefDeliveryPlan({ ...base, window: { name: "evening", start: 17, end: 22 }, items: [{ sourceId: "c", kind: "class", title: "MGT-782-W1", startIso: "2026-10-15T23:00:00Z", endIso: "2026-10-16T02:00:00Z", location: null }], upcoming: [{ sourceId: "u", kind: "meeting", title: "Sync", startIso: "2026-10-16T14:00:00Z", endIso: "2026-10-16T14:30:00Z", day: "2026-10-16", location: null }] }, "America/New_York");
console.log("B2 window block", J(win.appendBlock));
const empty = briefDeliveryPlan({ ...base, items: [], tasks: [], upcoming: [] }, "America/New_York");
console.log("B2 empty day block", J(empty.appendBlock), "kind", empty.kind);
console.log("A3 bold-lead not a bullet", J(parseChatBlocks("**Up next** is the dentist at 3.").map((b) => b.t)));
