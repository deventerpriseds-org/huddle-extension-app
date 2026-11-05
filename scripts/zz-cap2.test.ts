import { briefDeliveryPlan } from "../src/features/huddle/lib/tasks/schedule-brief-run.server";
import { priorityAppendBlock } from "../src/features/huddle/lib/tasks/priority-check.server";
const TZ = "America/New_York";
const titles = ["Quarterly planning sync with the platform engineering team", "1:1", "Standup", "Client review — Acme Corp renewal and pricing discussion (FY27)", "Lunch"];
function brief(perDay: number, titleLen?: number) {
  const items: any[] = [], upcoming: any[] = [], tasks: any[] = [];
  const T = (i: number) => (titleLen ? "X".repeat(titleLen) : titles[i % titles.length]);
  const hh = (h: number) => String(12 + (h % 10)).padStart(2, "0");
  for (let h = 0; h < perDay; h++) items.push({ sourceId: `t${h}`, kind: "meeting", title: T(h), startIso: `2026-10-15T${hh(h)}:00:00Z`, endIso: `2026-10-15T${hh(h)}:30:00Z`, location: h % 2 ? "Microsoft Teams Meeting" : null });
  for (let k = 0; k < 8; k++) tasks.push({ title: `Follow up on the vendor contract redlines ${k}`, startIso: null });
  for (let d = 16; d <= 21; d++) for (let h = 0; h < perDay; h++) upcoming.push({ sourceId: `u${d}-${h}`, kind: "meeting", title: T(h), startIso: `2026-10-${d}T${hh(h)}:00:00Z`, endIso: `2026-10-${d}T${hh(h)}:30:00Z`, day: `2026-10-${d}`, location: h % 2 ? "Microsoft Teams Meeting" : null });
  return { ok: true, edition: "morning", forDate: "2026-10-15", items, errors: [], tasks, upcoming } as any;
}
for (const n of [6, 8, 10, 12, 14, 16, 20, 25]) {
  const p = briefDeliveryPlan(brief(n), TZ);
  const b = (p.appendBlock ?? "").length;
  console.log(`perDay=${n} items=${n * 7} directive=${p.directive.length} block=${b} block>12000=${b > 12000} directive>16000=${p.directive.length > 16000}`);
}
for (const L of [150, 255]) {
  const p = briefDeliveryPlan(brief(6, L), TZ);
  console.log(`titleLen=${L} perDay=6 directive=${p.directive.length} block=${(p.appendBlock ?? "").length}`);
}
const pb = priorityAppendBlock({ count: 500, top: ["X".repeat(500), "Y".repeat(500), "Z".repeat(500)], overdue: 400, blocked: 50, unscheduled: 50 } as any);
console.log("priority block worst (3 x 500-char titles):", pb?.length);
