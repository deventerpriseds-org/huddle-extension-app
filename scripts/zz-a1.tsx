import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatText } from "../src/features/huddle/components/ChatText";
import { parseInline, stripRepeatedDraft, noticeText } from "../src/features/huddle/lib/chat-format";
import { briefDeliveryPlan } from "../src/features/huddle/lib/tasks/schedule-brief-run.server";

const show = (s: string) => console.log(JSON.stringify(s), "\n  parse:", JSON.stringify(parseInline(s)), "\n  html:", renderToStaticMarkup(<ChatText text={s} />));
console.log("---- A1 link parens");
[
  "[docs](https://a.io/p_(q))",
  "see [docs](https://a.io/p_(q)).",
  "[x](https://a.io/y))",
  "[x](https://a.io/(y)",
  "[x](javascript:alert(1))",
  "[x](https://a.io/(javascript:alert(1)))",
  "[a [b](https://e.io)](https://f.io)",
  "[x](https://a.io/((y)))",
  "https://en.wikipedia.org/wiki/Foo_(bar) and (https://a.io/z)",
  "[<img src=x onerror=alert(1)>](https://a.io)",
  "[x](https://a.io/\"onmouseover=alert(1))",
  "[x](data:text/html,<script>alert(1)</script>)",
  "<script>alert(1)</script> **b** `c`",
].forEach(show);
console.log("---- A2/A3 representative");
show("1. one\n2. two\n10. ten\n\n- a\n- b\n\nThe 3 PM meeting costs $1,200 (approx.) — 2*3=6 and a_b_c, __init__.");
show("Just plain text with a * star and 5 * 6 and C:\\path and 1) not a list?");
console.log("---- B2/B3");
const tz = "America/New_York";
const w = briefDeliveryPlan({ ok: true, edition: "morning", forDate: "2026-11-06", items: [], errors: [], tasks: [], window: { name: "business_hours", start: 9, end: 17 } } as any, tz);
console.log("window empty:", w.kind, JSON.stringify(w.directive.slice(0, 200)), "block:", JSON.stringify(w.appendBlock));
const e = briefDeliveryPlan({ ok: false, edition: "evening", forDate: "2026-11-06", items: [], errors: ["classes: http_500"], upcoming: [], upcomingErrors: [] } as any, tz);
console.log("read-error:", e.kind, JSON.stringify(e.directive));
console.log("---- C1/E1");
console.log(JSON.stringify(stripRepeatedDraft("From Sam re lunch.\n\nSuggested reply:\n\nHi Sam,\n\nTuesday works.\n\nBest, Von\n\nTap Save.", "Hi Sam,\n\nTuesday works.\n\nBest, Von")));
console.log(JSON.stringify(stripRepeatedDraft("From Sam.\n\nHi Sam,\n\nSomething else.\n\nBest, Von", "Hi Sam,\n\nTuesday works.\n\nBest, Von")));
console.log(JSON.stringify(noticeText("(couldn't respond — quota exhausted)")), JSON.stringify(noticeText("(fallback: gpt-4o (TPM): Limit) couldn't reach the model — retry")), JSON.stringify(noticeText("Hello Sir")));
