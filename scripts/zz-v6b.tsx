import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ChatText } from "../src/features/huddle/components/ChatText";
import { briefDeliveryPlan } from "../src/features/huddle/lib/tasks/schedule-brief-run.server";
import { priorityAppendBlock } from "../src/features/huddle/lib/tasks/priority-check.server";
import { joinOpenerAndBlock, stripRepeatedDraft, noticeText } from "../src/features/huddle/lib/chat-format";
const TZ = "America/New_York";
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// A2
const a2 = "Pay $1,234.56 by 10/05 — 3 of 12 tasks, 7:00 PM, v2.3.1, 50% (≈ 0.5), O'Brien & Co.\n• Call Dr. Smith re: 2 items\n1. first 2. inline";
const h = renderToStaticMarkup(createElement(ChatText, { text: a2 }));
const plainWords = (s: string) => s.replace(/[•\n]/g, " ").replace(/^1\. /m, "").replace(/\s+/g, " ").trim();
console.log("A2 html:", h.replace(/ class="[^"]*"/g, ""));
const decoded = strip(h).replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
console.log("A2 every token kept:", plainWords(a2).split(" ").filter((w) => w !== "1.").every((w) => decoded.includes(w)));
// B1/B2/B3
const item = (i: number) => ({ sourceId: `m-${i}`, kind: "meeting" as const, title: `Meeting ${i} ${"x".repeat(200)}`, startIso: `2026-10-05T${String(12 + (i % 10)).padStart(2, "0")}:00:00Z`, endIso: `2026-10-05T${String(13 + (i % 10)).padStart(2, "0")}:00:00Z`, location: "Room ".repeat(40) });
const mk = (over: any = {}) => ({ ok: true, edition: "morning", forDate: "2026-10-05", items: [item(1)], errors: [], ...over });
const busy = briefDeliveryPlan(mk({ items: Array.from({ length: 80 }, (_, i) => item(i)) }) as any, TZ);
console.log("B1 kind", busy.kind, "directive len", busy.directive.length, "appendBlock len", busy.appendBlock?.length, "bullets", (busy.appendBlock ?? "").split("\n").filter((l) => l.startsWith("•")).length, "more-line:", (busy.appendBlock ?? "").split("\n").filter((l) => /more/.test(l)));
const modelCopy = "Hello Sir, here's today.\n\n• Meeting 1 at 8\n• Meeting 2";
const joined = joinOpenerAndBlock(modelCopy, busy.appendBlock ?? "");
console.log("B1 joined starts:", JSON.stringify(joined.slice(0, 60)), "count of 'Meeting 1 ' lines:", joined.split("\n").filter((l) => l.includes("Meeting 1 ")).length);
const empty = briefDeliveryPlan(mk({ items: [] }) as any, TZ);
console.log("B2 empty:", empty.kind, "|", empty.directive.slice(0, 160).replace(/\n/g, " / "), "| append:", empty.appendBlock);
const win = briefDeliveryPlan(mk({ window: { name: "after_work", start: 17, end: 22 } }) as any, TZ);
console.log("B2 window:", win.kind, "|", win.directive.slice(0, 160).replace(/\n/g, " / "));
const err = briefDeliveryPlan(mk({ items: [], errors: ["meetings: Graph 403 " + "e".repeat(5000)] }) as any, TZ);
console.log("B3 err:", err.kind, "directive len", err.directive.length, "|", err.directive.slice(0, 200).replace(/\n/g, " / "));
const pr = priorityAppendBlock({ count: 9, top: ["A", "B", "C", "D", "E", "F"], overdue: 2, blocked: 1, unscheduled: 3 } as any);
console.log("B1 priority:", JSON.stringify(pr));
console.log("B1 priority empty:", priorityAppendBlock({ count: 0, top: [] } as any));
// C1
const body = "Hi Sam,\n\nThanks for reaching out — Tuesday works.\n\nBest,\nVon";
const prose = "Here's a draft.\n\n**Suggested reply:**\n\nHi Sam,\n\nThanks for reaching out — Tuesday works.\n\nBest,\nVon";
console.log("C1 full:", JSON.stringify(stripRepeatedDraft(prose, body)));
console.log("C1 partial unchanged:", stripRepeatedDraft("Here.\n\nHi Sam,\n\nTuesday is fine.\n\nBest,\nVon", body) === "Here.\n\nHi Sam,\n\nTuesday is fine.\n\nBest,\nVon");
// E1
for (const t of ["(couldn't respond — quota)", "(couldn’t respond — x)", "(fallback: gpt-4o (TPM): Limit) couldn't reach the model — retry", "(couldn't respond - quota)", "I couldn't respond earlier — sorry", "(fallback plan: Zoom)", "Fallback: use Zoom"]) console.log("E1", JSON.stringify(t), "->", JSON.stringify(noticeText(t)));
