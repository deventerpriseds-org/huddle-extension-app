import { briefDeliveryPlan } from "../src/features/huddle/lib/tasks/schedule-brief-run.server";
import { priorityAppendBlock } from "../src/features/huddle/lib/tasks/priority-check.server";
import { joinOpenerAndBlock } from "../src/features/huddle/lib/chat-format";
const INTERNAL_TEXT_MAX = 16000; // huddle.functions.ts:220 (read, not imported: that module pulls server deps)
const TZ = "America/New_York";
const base: any = { edition: "morning", forDate: "2026-10-15", items: [], errors: [], upcoming: [] };
const it = (o: any) => ({ sourceId: Math.random().toString(36), title: "x", kind: "meeting", startIso: "2026-10-15T14:00:00Z", endIso: "2026-10-15T14:30:00Z", ...o });
const TITLE = "Quarterly planning sync with the platform engineering team"; // 58 chars
const LOC = "Microsoft Teams Meeting";
const hh = (h: number) => String(12 + (h % 11)).padStart(2, "0");
for (const n of [4, 6, 8, 10, 12, 15]) {
  const today: any[] = [], up: any[] = [];
  for (let h = 0; h < n; h++) today.push(it({ title: `${TITLE} ${h}`, location: LOC, startIso: `2026-10-15T${hh(h)}:00:00Z`, endIso: `2026-10-15T${hh(h)}:30:00Z` }));
  for (let d = 16; d <= 21; d++) for (let h = 0; h < n; h++) up.push(it({ title: `${TITLE} ${h}`, location: LOC, day: `2026-10-${d}`, startIso: `2026-10-${d}T${hh(h)}:00:00Z`, endIso: `2026-10-${d}T${hh(h)}:30:00Z` }));
  const tasks = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Follow up on the vendor contract renewal item ${i}`, startIso: "2026-10-15T15:00:00Z" }));
  const p = briefDeliveryPlan({ ...base, items: today, upcoming: up, tasks }, TZ);
  const a = (p.appendBlock ?? "").length;
  console.log(`brief n=${n}/day (today ${n} + week 6x${n} + ${n} tasks): appendBlock=${a} directive(text)=${p.directive.length} block<=12000:${a <= 12000} text<=16000:${p.directive.length <= INTERNAL_TEXT_MAX}`);
}
{
  const up: any[] = [];
  for (let d = 16; d <= 21; d++) for (let h = 0; h < 6; h++) up.push(it({ title: `${TITLE} ${h}`, location: "Conference Room 4B - Building 2 - 1200 Main St, Suite 400, Springfield; Microsoft Teams Meeting", day: `2026-10-${d}`, startIso: `2026-10-${d}T1${h}:00:00Z`, endIso: `2026-10-${d}T1${h}:30:00Z` }));
  const p = briefDeliveryPlan({ ...base, upcoming: up }, TZ);
  console.log(`brief 6/day long-location: appendBlock=${(p.appendBlock ?? "").length} directive=${p.directive.length}`);
}
for (const L of [40, 120, 400]) {
  const b = priorityAppendBlock({ edition: "evening", count: 57, top: Array.from({ length: 10 }, (_, i) => `${"T".repeat(L)} ${i}`), overdue: 9, blocked: 4, unscheduled: 30 } as any) ?? "";
  console.log(`priority titleLen=${L}: len=${b.length} bullets=${(b.match(/•/g) || []).length}`);
}
console.log("priority count=0:", priorityAppendBlock({ edition: "morning", count: 0, top: [] } as any));
const block = 'Meetings and classes:\n• 9:00 AM — A (meeting)\n\nLater this week:\n• Tomorrow, 10:00 AM — B (meeting)\n\nWould you like to adjust anything today? The "Open Schedule" button below takes you to the Schedule tab.';
const O = "Hello Sir, just a reminder that today you have one meeting.";
const cases: [string, string][] = [
  ["plain opener", O],
  ["opener + dash list", `${O}\n\n- 9:00 AM A`],
  ["opener + bullet list", `${O}\n• 9:00 AM A`],
  ["opener + numbered", `${O}\n1. 9:00 AM A`],
  ["opener + bold header", `${O}\n\n**Meetings and classes:**\n9:00 AM — A`],
  ["opener + plain header", `${O}\n\nMeetings and classes:\n9:00 AM — A`],
  ["opener + bold header colon outside", `${O}\n\n**Meetings and classes**:\n9:00 AM — A`],
  ["opener + md heading", `${O}\n\n### Meetings and classes:\n9:00 AM — A`],
  ["opener + header no colon", `${O}\n\nMeetings and classes\n9:00 AM — A`],
  ["opener + lowercase header", `${O}\n\nmeetings and classes:\n9:00 AM — A`],
  ["opener + closing question copy", `${O} Would you like to adjust anything today? The "Open Schedule" button below takes you to the Schedule tab.`],
  ["empty", ""],
  ["quota notice", "(couldn't respond — OpenAI quota exhausted)"],
  ["fallback notice", "(fallback: openai) couldn't reach the model — timeout"],
];
for (const [n, t] of cases) {
  const out = joinOpenerAndBlock(t, block);
  const hdr = (out.match(/meetings and classes/gi) || []).length, q = (out.match(/adjust anything/g) || []).length, a = (out.match(/9:00 AM/g) || []).length;
  console.log(`JOIN [${n}] header=${hdr} item9am=${a} question=${q} opener=${JSON.stringify(out.split("\n\nMeetings and classes:\n•")[0])}`);
}
const win = { name: "business_hours", start: 9, end: 17 };
const wp = briefDeliveryPlan({ ...base, window: win, items: [it({ title: "Standup" })], tasks: [{ id: "a", title: "A", startIso: "2026-10-15T16:00:00Z" }], upcoming: [it({ day: "2026-10-16", startIso: "2026-10-16T14:00:00Z" })] }, TZ);
console.log("B2 window kind", wp.kind, "| week in block:", /later this week/i.test(wp.appendBlock ?? ""), "| week in directive:", /LATER THIS WEEK/.test(wp.directive), "| question in block:", /adjust anything|\?/.test(wp.appendBlock ?? ""), "| question in directive:", /adjust anything/.test(wp.directive), "\n ", JSON.stringify(wp.appendBlock));
const wEmpty = briefDeliveryPlan({ ...base, window: win, items: [], tasks: [] }, TZ);
console.log("B2 window empty kind", wEmpty.kind, "appendBlock", JSON.stringify(wEmpty.appendBlock));
const empty = briefDeliveryPlan({ ...base, items: [], tasks: [] }, TZ);
console.log("B2 empty day kind", empty.kind, "bullets:", /•/.test(empty.appendBlock ?? ""), "nothing-line:", /nothing scheduled|no tasks|no meetings/i.test(empty.appendBlock ?? ""), JSON.stringify(empty.appendBlock));
const re = briefDeliveryPlan({ ...base, items: [], errors: ["classes: http_500"] }, TZ);
console.log("B3 kind", re.kind, "appendBlock", re.appendBlock, "\n ", JSON.stringify(re.directive));
const re2 = briefDeliveryPlan({ ...base, items: [], errors: ["meetings: 403", "classes: http_500"], tasksError: "pg down" }, TZ);
console.log("B3b kind", re2.kind, "appendBlock", re2.appendBlock, "\n ", JSON.stringify(re2.directive));
