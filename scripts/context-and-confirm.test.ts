// WHAT:       Offline guards for two owner-approved changes (2026-11-04):
//             (1) a short "ok"/"great" in a 1:1 is NO LONGER recorded as a confirm-intent before any model
//                 reads the message -- the agent reads it and calls confirm_task_intent itself;
//             (2) the agent sees a compact text summary of every non-text item in the thread (widgets,
//                 cards + their button state, chips) through the existing history path.
// WHY:        (1) the former isPlainConfirmation short-circuit confirmed the last-asked task off a regex;
//             (2) HuddleView's history map + the HistoryMessage zod stripped every widget/card field, so the
//                 agent was "oblivious" to them (owner's word).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   `npm run test:context-and-confirm`; docs/qc-evidence/BUILD-context-and-confirm.md
//
// runHuddleTurn cannot run offline (pg, OpenAI, journey), so (1) and the server wiring of (2) are pinned
// with SOURCE assertions scoped to the exact blocks; the summariser itself is exercised behaviourally.

import { readFileSync } from "node:fs";
import {
  streamItemSummary,
  textWithStreamContext,
  streamContextInstructionBlock,
  STREAM_CONTEXT_MAX_CHARS,
} from "../src/features/huddle/lib/stream-context";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${JSON.stringify(detail)})`}`);
}

const HF = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
const HV = readFileSync("src/features/huddle/components/HuddleView.tsx", "utf8");
const STORE = readFileSync("src/features/huddle/store.ts", "utf8");

// ---------------------------------------------------------------- (1) confirm AFTER the agent reads
console.log("\n(1) confirm-intent is recorded only by the agent's tool or a button");
const aStart = HF.indexOf("// ---- A: confirm-intent CONTEXT");
const aEnd = HF.indexOf("// ---- B: chat-driven UNBLOCK.");
const blockA = aStart >= 0 && aEnd > aStart ? HF.slice(aStart, aEnd) : "";
check("block A located", blockA.length > 0, { aStart, aEnd });
const blockACode = blockA
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
check("block A writes no confirmation (no confirmTaskIntent call)", !/confirmTaskIntent\s*\(/.test(blockACode));
check("block A makes no journey write (no invokeJourneyTool)", !/invokeJourneyTool/.test(blockACode));
check("block A still looks up the last-asked pending confirm", /getPendingConfirmForAgent\(/.test(blockACode));
check("block A runs on chunk continuations too (no !resume gate)", !/!resume/.test(blockACode));
check("isPlainConfirmation is not called anywhere", !/isPlainConfirmation\s*\(/.test(HF));

const dStart = HF.indexOf("const confirmReplyDirective =");
const directive = dStart >= 0 ? HF.slice(dStart, HF.indexOf(': "";', dStart)) : "";
check("directive exists and is gated on the pending confirm's own agent", /pendingConfirm\.agentId === winner\.id/.test(directive));
check("directive hands over the exact task_id", /task_id "\$\{pendingConfirm\.taskId\}"/.test(directive));
check("directive tells the agent to call confirm_task_intent", /call confirm_task_intent NOW/.test(directive));
check('directive says a short "ok"/"great" IS a confirmation', /"ok"/.test(directive) && /"great"/.test(directive));
check("directive carries the proposed DoD", /pendingConfirm\.proposedDod/.test(directive));
check("directive reaches the scene", /\$\{confirmReplyDirective\}/.test(HF));
check(
  "button row still records WHICH button resolved the card",
  /resolveConfirmAsk\(\s*m\.id,\s*action === "confirm" \? "confirmed"/.test(HV) && /resolvedAs: how/.test(STORE),
);

// ---------------------------------------------------------------- (2) server wiring of stream context
console.log("\n(2a) the context travels the existing history path");
const hmStart = HF.indexOf("const HistoryMessage = z.object({");
const hm = HF.slice(hmStart, HF.indexOf("});", hmStart));
check("HistoryMessage declares `context` (zod would strip it otherwise)", /context: z\.string\(\)/.test(hm));
const htStart = HF.indexOf("const historyTranscript");
const ht = HF.slice(htStart, HF.indexOf("const transcript:", htStart));
check("per-agent transcript appends context to every message", /textWithStreamContext\(m\.text, m\.context\)/.test(ht));
check("own-agent, user and other-agent entries all use the merged body", (ht.match(/\bbody\b/g) ?? []).length >= 4, ht.length);
check(
  "conversation mode carries the summaries in instructions",
  /instructions:\s*\n?\s*personaArgs\.instructions \+ streamContextInstructionBlock\(data\.history\)/.test(HF),
);
check(
  "client history map sends the summary",
  /streamItemSummary\(m, \{\s*live: useHuddleStore\.getState\(\)\.checklistState/.test(HV) &&
    /return context \? \{ context \} : \{\};/.test(HV),
);

// ---------------------------------------------------------------- (2) the summariser, behaviourally
console.log("\n(2b) each stream item type summarises with its state");
const agent = { kind: "agent" as const, agentId: "iris-cole" as never };
const row = (id: string, title: string, status: string) =>
  ({ id, title, status, category: null, isPriority: true, priorityRank: 1, dueDate: null, startTime: null, endTime: null, isScheduled: false, tags: [], assignedAgent: null }) as never;

check("plain text message -> empty (payload unchanged)", streamItemSummary({ author: agent, text: "hi" }) === "");

const pri = streamItemSummary({
  author: agent,
  text: "",
  priorities: { ok: true, timeZone: "UTC", todayKey: "2026-11-04", band: [row("t1", "Ship report", "DOING"), row("t2", "Call bank", "UP_NEXT")], topics: { roots: [] } } as never,
});
check("priorities widget lists rows in order with status", pri === "[Priorities widget shown: 1. Ship report (DOING), 2. Call bank (UP_NEXT)]", pri);

const priLive = streamItemSummary(
  { author: agent, text: "", priorities: { ok: true, timeZone: "UTC", todayKey: "x", band: [row("t1", "Ship report", "DOING")], topics: { roots: [] } } as never },
  { live: { t1: { status: "DONE", tags: [] } } },
);
check("live row state overrides the snapshot", priLive.includes("Ship report (DONE)"), priLive);

const priErr = streamItemSummary({ author: agent, text: "", priorities: { ok: false, error: "mirror down", timeZone: "UTC", todayKey: "x", band: [], topics: { roots: [] } } as never });
check("failed priorities widget says so", priErr.startsWith("[Priorities widget shown: could not load"), priErr);

const sch = streamItemSummary({
  author: agent,
  text: "",
  schedule: { ok: true, timeZone: "UTC", todayKey: "x", weekStartKey: "x", weekEndKey: "x", todaySchedule: [row("s1", "Standup", "TODO")], currentlyDoing: [], upNext: [row("s2", "Taxes", "UP_NEXT")] } as never,
});
check("schedule widget: today + doing(empty) + up next", sch === "[Schedule widget shown — today: 1. Standup (TODO); doing: nothing in progress; up next: 1. Taxes (UP_NEXT)]", sch);

const chk = streamItemSummary({ author: agent, text: "Here you go", checklist: { title: "Kids", rows: [{ taskId: "c1", title: "Dentist", status: "TODO", tags: [] }], more: 3 } });
check("checklist with +more", chk === '[Checklist "Kids" shown: 1. Dentist (TODO) (+3 not shown)]', chk);

const ask = { taskId: "T-9", taskTitle: "Draft the deck", proposedDod: "A 5-slide deck" };
const caOpen = streamItemSummary({ author: agent, text: "Can you confirm?", confirmAsk: ask });
check("confirm card open: names task, id and the open buttons", caOpen === '[Confirm card for task "Draft the deck" (task_id T-9) — buttons Confirm / Revise / Backlog / Archive still open]', caOpen);
const caYes = streamItemSummary({ author: agent, text: "", confirmAsk: { ...ask, resolved: true, resolvedAs: "confirmed" } });
check("confirm card tapped Confirm", caYes.endsWith("— user tapped Confirm]"), caYes);
const caBack = streamItemSummary({ author: agent, text: "", confirmAsk: { ...ask, resolved: true, resolvedAs: "backlogged" } });
check("confirm card tapped Backlog", caBack.includes("user tapped Backlog"), caBack);
const caPark = streamItemSummary({ author: agent, text: "", confirmAsk: { ...ask, resolved: true, resolvedAs: "parked" } });
check("confirm card tapped Archive", caPark.includes("user tapped Archive"), caPark);
const caOld = streamItemSummary({ author: agent, text: "", confirmAsk: { ...ask, resolved: true } });
check("confirm card resolved, button unknown (older message)", caOld.includes("already handled it with a button"), caOld);

const ov = streamItemSummary({ author: agent, text: "", overrideAsk: { taskId: "T-2", taskTitle: "Book flights" } });
check("approach escalation open", ov === '[Approach escalated for task "Book flights" (task_id T-2) — "Approve anyway" button still open]', ov);
check(
  "approach escalation tapped",
  streamItemSummary({ author: agent, text: "", overrideAsk: { taskId: "T-2", taskTitle: "Book flights", resolved: true } }).includes("user tapped Approve anyway"),
);

const em = { emailId: "e1", fromName: "Ann", fromAddress: "ann@x.io", subject: "Lunch?", replyBody: "Sure" };
check("email card open", streamItemSummary({ author: agent, text: "", emailReply: em }) === '[Email reply card for "Lunch?" from Ann — Save to Drafts / No reply needed buttons still open]');
check("email card drafted", streamItemSummary({ author: agent, text: "", emailReply: { ...em, resolved: "drafted" } }).includes("user tapped Save to Drafts"));
check("email card dismissed", streamItemSummary({ author: agent, text: "", emailReply: { ...em, resolved: "dismissed" } }).includes("user tapped No reply needed"));

check("artifact chips", streamItemSummary({ author: agent, text: "", artifacts: [{ id: "a", name: "Brief.md" }] }) === '[Artifacts attached: "Brief.md"]');
check("user attachments", streamItemSummary({ author: { kind: "user" }, text: "see", attachments: [{ id: "u", name: "invite.png", mime: "image/png" }] }) === '[User attached files: "invite.png"]');
check("navLink button", streamItemSummary({ author: agent, text: "", navLink: { view: "priorities", label: "Open Priorities" } }) === '[Button shown: "Open Priorities" opens the priorities tab]');
check("scheduled brief", streamItemSummary({ author: agent, text: "", isBriefing: true }) === "[Scheduled briefing]");
check("scheduled check-in", streamItemSummary({ author: agent, text: "", checkIn: { kind: "morning", scheduledAt: "x", host: "iris-cole" as never, joins: [] } }) === "[Scheduled morning check-in]");

const many = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, name: "x".repeat(70) }));
const big = streamItemSummary({ author: agent, text: "", artifacts: many, attachments: many.map((a) => ({ ...a, mime: "t" })), navLink: { view: "board", label: "y".repeat(60) }, checklist: { title: "z".repeat(60), rows: [] } });
check("summary is length-capped", big.length <= STREAM_CONTEXT_MAX_CHARS, big.length);

console.log("\n(2c) merge + conversation-mode block");
check("text + context joined", textWithStreamContext("Here", "[X]") === "Here\n[X]");
check("empty text -> context alone (no blank entry)", textWithStreamContext("", "[X]") === "[X]");
check("no context -> text unchanged", textWithStreamContext("Here", undefined) === "Here");
const blk = streamContextInstructionBlock([
  { author: { kind: "user" } },
  { author: { kind: "system" }, context: "[ignored]" },
  { author: { kind: "agent" }, context: "[Priorities widget shown: 1. A]" },
]);
check("instruction block lists agent items, skips system", blk.includes("(agent message) [Priorities widget shown: 1. A]") && !blk.includes("[ignored]"), blk);
check("instruction block empty when nothing to add", streamContextInstructionBlock([{ author: { kind: "user" } }]) === "");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
