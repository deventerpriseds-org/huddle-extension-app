import { briefDeliveryPlan, SCHEDULE_NAV_LINK, scheduleBriefPush } from "../src/features/huddle/lib/tasks/schedule-brief-run.server";
import { Input } from "../src/features/huddle/lib/zz-hf";
import { priorityCheckDirective } from "../src/features/huddle/lib/tasks/priority-check.server";
import { inboundEmailDirective } from "../src/features/huddle/lib/email/inbound-email";

const tz = "America/New_York";
const mk = (n: number, tlen: number, llen: number, day?: string, base = "2026-11-06") =>
  Array.from({ length: n }, (_, i) => ({
    kind: i % 3 ? "meeting" : "class",
    title: ("T" + i + "-").padEnd(tlen, "x"),
    startIso: `${day ?? base}T${String(13 + (i % 10)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
    endIso: `${day ?? base}T${String(14 + (i % 9)).padStart(2, "0")}:00:00Z`,
    location: llen ? ("L" + i + "-").padEnd(llen, "y") : null,
    ...(day ? { day } : {}),
  }));
const days = ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"];
function brief(n: number, tlen: number, llen: number, edition: "morning" | "evening", extra: any = {}) {
  return {
    ok: true, edition, forDate: "2026-11-06",
    items: mk(n, tlen, llen),
    errors: [],
    upcoming: days.flatMap((d) => mk(n, tlen, llen, d)),
    upcomingErrors: [],
    tasks: Array.from({ length: n }, (_, i) => ({ id: "t" + i, title: ("Task" + i).padEnd(tlen, "z"), startIso: `2026-11-06T15:${String(i % 60).padStart(2, "0")}:00Z` })),
    ...extra,
  } as any;
}
function payloadFor(plan: any, edition: any) {
  return {
    text: plan.directive, huddleId: "dm-iris-chase", scope: "one-to-one", members: ["iris-chase"],
    targetAgentId: "iris-chase", history: [],
    router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false },
    agents: { "iris-chase": { backend: "openai", journey: { enabled: false } } },
    timeZone: tz, caller: { entra_email: "von.ellis@enterpriseds.io" }, notify: "push", internal: true,
    navLink: SCHEDULE_NAV_LINK, ...(plan.appendBlock ? { appendBlock: plan.appendBlock } : {}),
    pushStyle: scheduleBriefPush(edition),
  };
}
const rows: any[] = [];
const cases: [string, number, number, number][] = [
  ["19/day 58ch", 19, 58, 0], ["25/day 58ch", 25, 58, 0], ["40/day 58ch", 40, 58, 0],
  ["5/day 255+255", 5, 255, 255], ["40/day 255+255", 40, 255, 255],
  ["200/day 255+255", 200, 255, 255],
];
for (const [name, n, t, l] of cases)
  for (const ed of ["morning", "evening"] as const) {
    const plan = briefDeliveryPlan(brief(n, t, l, ed), tz);
    const r = Input.safeParse(payloadFor(plan, ed));
    rows.push({ name, ed, kind: plan.kind, text: plan.directive.length, block: plan.appendBlock?.length ?? 0, parse: r.success ? "OK" : r.error.issues.map((i: any) => i.path.join(".") + ":" + i.message).join("|") });
  }
// window edition
{
  const plan = briefDeliveryPlan(brief(40, 255, 255, "morning", { window: { name: "business_hours", start: 9, end: 17 } }), tz);
  const r = Input.safeParse(payloadFor(plan, "morning"));
  rows.push({ name: "window 40/day 255", ed: "morning", kind: plan.kind, text: plan.directive.length, block: plan.appendBlock?.length ?? 0, parse: r.success ? "OK" : "FAIL" });
}
// nothing-scheduled with week
{
  const b = brief(0, 255, 255, "morning"); b.upcoming = days.flatMap((d) => mk(40, 255, 255, d));
  const plan = briefDeliveryPlan(b, tz);
  const r = Input.safeParse(payloadFor(plan, "morning"));
  rows.push({ name: "empty day + 40/day week 255", ed: "morning", kind: plan.kind, text: plan.directive.length, block: plan.appendBlock?.length ?? 0, parse: r.success ? "OK" : "FAIL" });
}
// attack: long error strings (external error text is not bounded by capFacts)
for (const elen of [500, 5000, 20000]) {
  const big = "E".repeat(elen);
  const b = brief(0, 58, 0, "morning", { errors: [`meetings: ${big}`, `classes: ${big}`], tasks: undefined, tasksError: big, upcoming: [], upcomingErrors: [`meetings: ${big}`] });
  const plan = briefDeliveryPlan(b, tz);
  const r = Input.safeParse(payloadFor(plan, "morning"));
  rows.push({ name: `read-error, error text ${elen}ch x2`, ed: "morning", kind: plan.kind, text: plan.directive.length, block: plan.appendBlock?.length ?? 0, parse: r.success ? "OK" : "FAIL" });
  const b2 = brief(40, 255, 255, "morning", { errors: [`classes: ${big}`], upcomingErrors: [`meetings: ${big}`], tasksError: big, tasks: undefined });
  const plan2 = briefDeliveryPlan(b2, tz);
  const r2 = Input.safeParse(payloadFor(plan2, "morning"));
  rows.push({ name: `items + error text ${elen}ch`, ed: "morning", kind: plan2.kind, text: plan2.directive.length, block: plan2.appendBlock?.length ?? 0, parse: r2.success ? "OK" : "FAIL" });
}
console.table(rows);
// priority check with huge titles
const pc = priorityCheckDirective({ edition: "evening", count: 500, overdue: 9, blocked: 9, unscheduled: 9, top: Array.from({ length: 500 }, (_, i) => "P".repeat(5000)) } as any);
console.log("priorityCheckDirective 500 x 5000-char titles:", pc.length);
const ie = inboundEmailDirective({ fromName: "N".repeat(5000), fromAddress: "a".repeat(5000), subject: "S".repeat(5000), bodyText: "B".repeat(100000) } as any, "R".repeat(5000), { emailId: "e1", owed: 999, settledToday: 9 });
console.log("inboundEmailDirective huge fields:", ie.length);
