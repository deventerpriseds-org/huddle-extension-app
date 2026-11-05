// WHAT:       Offline tests for lib/chat-format.ts — the chat's layout rules — using Iris's REAL messages
//             from 2026-11-03..05 as fixtures.
// WHY:        Owner, 2026-11-05: "some texts use proper spacing bullets and indentation and other messages
//             insert line breaks between every line". These fixtures are the exact strings that showed it.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   azure-pg-query run 42105101844.
// Run: bun scripts/chat-format.test.ts   (npm run test:chat-format)
import {
  bulletSection,
  joinOpenerAndBlock,
  noticeText,
  normalizeChatText,
  openerOnly,
  parseChatBlocks,
  parseInline,
  shortUrlLabel,
  spacedClock,
  stripRepeatedDraft,
} from "../src/features/huddle/lib/chat-format";
import { QUOTA_OUTAGE_INLINE } from "../src/features/huddle/lib/fallbacks";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}

// ---- real fixtures -------------------------------------------------------------------------------
// 11-05 08:00 — a blank line between EVERY bullet (22 line breaks).
const SPACED =
  "Hello Sir,\n\njust a reminder that today you have no meetings or classes.\n\nOn your task list:\n\n• 5:00PM — Research someone to install brakes and rotors for my Mercedes S550 sedan\n\n• 7:00PM — 📚 Checkpoint 2 - Details 2 of 2 (MGT-702)\n\nLater this week:\n\n• Monday, Nov 9, 7:00PM–10:00PM — MGT-782-W1 (202711) (class)\n\n• Tuesday, Nov 10, 7:00PM–10:00PM — MGT-702-W1 (202711) (class)\n\nWould you like to adjust anything today? The Open Schedule button below takes you to the Schedule tab.";
// 11-03 20:00 — the SAME message type, one bullet per line.
const TIGHT =
  "Hello Sir,\n\njust a reminder that tomorrow you have no meetings or classes.\n\nOn your task list:\n• 9:00AM — Create Trinnex DevSecMLOps and AI governance case study\n• 10:15AM — Prepare smaller Maximo-style schema dataset\n\nLater this week:\n• Monday, 7:00PM–10:00PM — MGT-782-W1 (202711) (class)\n\nWould you like to adjust anything for tomorrow? The Open Schedule button below takes you to the Schedule tab.";
// 11-05 13:31 — raw markdown bold.
const BOLD =
  "Because your edit only changed the task’s Definition of Done and research scope; it did not authorize starting the work. The task remains in **Up next**, assigned to Iris, with a scheduled work block for **November 7 at 7:00 PM**.";
// 11-04 15:32 — email alert with the draft in the prose.
const EMAIL =
  "The Terra Team at Terra is inviting residents to stop by the Dunkin’ truck outside the building on Friday for coffee and treats.\n\nSuggested reply:\n\nHi Terra Team,\n\nThanks for the heads-up. I’ll stop by for the Dunkin’ truck on Friday if I can.\n\nBest,  \nVon\n\nYou can tap Save to Drafts, or tell me what to change first; you have 15 replies owed right now, with 0 settled today.";
const EMAIL_BODY = "Hi Terra Team,\n\nThanks for the heads-up. I’ll stop by for the Dunkin’ truck on Friday if I can.\n\nBest,\nVon";

// ---- A: normalize + blocks -----------------------------------------------------------------------
{
  const n = normalizeChatText(SPACED);
  check("A1 no blank line is left between two bullets", !/•[^\n]*\n\n•/.test(n), n);
  check("A2 a section header still has a blank line before it", /\n\nLater this week:\n• Monday/.test(n), n);
  check("A3 the dangling 'Hello Sir,' greeting is re-joined with its sentence", n.startsWith("Hello Sir, just a reminder that today"), n.slice(0, 60));
  check("A4 the two spacings of the SAME brief now produce the SAME shape",
    parseChatBlocks(SPACED).map((b) => b.t).join(",") === parseChatBlocks(TIGHT).map((b) => b.t).join(","),
    [parseChatBlocks(SPACED).map((b) => b.t), parseChatBlocks(TIGHT).map((b) => b.t)]);
  const blocks = parseChatBlocks(SPACED);
  const lists = blocks.filter((b) => b.t === "ul");
  check("A5 each list section is ONE list, not one list per bullet", lists.length === 2 && lists.every((l) => l.t === "ul" && l.items.length === 2), blocks.map((b) => b.t));
  check("A6 words are never changed by normalizing", normalizeChatText(SPACED).replace(/\s+/g, " ") === SPACED.replace(/Hello Sir,\n\njust/, "Hello Sir, just").replace(/\s+/g, " "));
  check("A7 trailing two-space hard breaks are dropped", normalizeChatText("Best,  \nVon") === "Best,\nVon");
  check("A8 three+ blank lines collapse to one", normalizeChatText("a\n\n\n\nb") === "a\n\nb");
  check("A9 a greeting is NOT joined to a capitalised next paragraph", normalizeChatText("Hello Sir,\n\nHere it is.") === "Hello Sir,\n\nHere it is.");
  check("A10 a non-greeting line ending in a comma is not joined", normalizeChatText("I checked three things,\n\nand found one.") === "I checked three things,\n\nand found one.");
}
{
  const b = parseInline(BOLD);
  const bolds = b.filter((x) => x.t === "bold").map((x) => (x as { v: string }).v);
  check("A11 **bold** becomes bold, asterisks gone", JSON.stringify(bolds) === '["Up next","November 7 at 7:00 PM"]', bolds);
  check("A12 '**' alone at line start is not a bullet", parseChatBlocks("**Up next** is the lane")[0].t === "p");
  const z = parseInline("Join: https://zoom.us/j/9164221159?pwd=abc123.");
  const link = z.find((x) => x.t === "link") as { href: string; label: string } | undefined;
  check("A13 a bare URL becomes a link without the trailing period", link?.href === "https://zoom.us/j/9164221159?pwd=abc123", link);
  check("A14 its label hides the query string", link?.label === "zoom.us/j/9164221159", link);
  check("A15 javascript: never becomes a link", !parseInline("[x](javascript:alert(1))").some((x) => x.t === "link"));
  check("A16 a markdown link keeps its label", JSON.stringify(parseInline("[the doc](https://a.io/x)")) === JSON.stringify([{ t: "link", href: "https://a.io/x", label: "the doc" }]));
  check("A17 numbered lists parse as ol", parseChatBlocks("1. one\n2. two")[0].t === "ol");
  check("A18 '- ' and '* ' bullets parse as ul", parseChatBlocks("- a\n* b").every((x) => x.t === "ul"));
  check("A19 a heading line parses as h", parseChatBlocks("## Plan\nbody")[0].t === "h");
  check("A20 shortUrlLabel caps long paths", shortUrlLabel("https://example.com/" + "a".repeat(80)).length <= 40);
  check("A21 an empty message yields no blocks", parseChatBlocks("").length === 0);
}

// ---- verifier loop 1 (docs/qc-evidence/VERIFY-chat-format-1.md) -------------------------------
{
  const bs = parseChatBlocks("1. first\n2. second\n\nSome note\n\n3. third");
  const second = bs[2] as { t: string; start?: number };
  check("V1 an ordered list after a note keeps its number (3, not 1)", second.t === "ol" && second.start === 3, bs);
  check("V2 '>50% done' is text, not a quote (meaning kept)", parseChatBlocks(">50% of tasks done")[0].t === "p");
  check("V3 '# of tasks: 5' is text, not a heading", parseChatBlocks("# of tasks: 5")[0].t === "p");
  check("V4 '__init__' keeps its underscores (no __bold__)", JSON.stringify(parseInline("call __init__ then")) === JSON.stringify([{ t: "text", v: "call __init__ then" }]));
  check("V5 '> quoted' with a space is still a quote", parseChatBlocks("> quoted line")[0].t === "quote");
  const card = "Hi Sam,\n\nThursday at 2 PM works for me (a placeholder, happy to move it).\n\nBest,\nVon";
  const prose = "Sam Lee from Acme wants to meet this week.\n\nHi Sam,\n\nThursday at 2 PM works for me — happy to move it if needed.\n\nBest,\nVon\n\nTap Save to Drafts, or tell me what to change.";
  check("V6 a PARTIAL draft match (greeting + sign-off only) leaves the prose untouched", stripRepeatedDraft(prose, card) === prose);
  check("V7 every runtime '(fallback: …)' reply is a notice", noticeText("(fallback: gateway) AI gateway is not configured yet.") !== null);
  check("V8 a bold copy of a section header is still cut", openerOnly("Hi.\n**On your task list:**\nA", "On your task list:\n• A") === "Hi.");
  // verifier loop 2 (docs/qc-evidence/VERIFY-chat-format-2-CE.md)
  const repeated = "Hi Sam,\n\nSam wants to meet.\n\nHi Sam,\n\nThursday works, happy to move it.\n\nBest,\nVon";
  check("V10 a generic paragraph repeated in the prose does not fake a full match", stripRepeatedDraft(repeated, card) === repeated);
  const boldLabel = `Sam wants to meet.\n\n**Suggested reply:**\n\n${card}`;
  check("V11 a bold '**Suggested reply:**' label goes with the draft", stripRepeatedDraft(boldLabel, card) === "Sam wants to meet.", stripRepeatedDraft(boldLabel, card));
  check("V12 a '(fallback: …)' reply whose error contains ')' is still a notice",
    noticeText("(fallback: model call failed: 429 Rate limit for gpt-4o (TPM): Limit) couldn't reach the model — x") !== null);
  check("V13 a full draft with a same-line label and trailing-space sign-off still strips",
    stripRepeatedDraft("Sam wants to meet.\n\nSuggested reply: Hi Sam,\n\nThursday at 2 PM works for me (a placeholder, happy to move it).\n\nBest,  \nVon\n\nTap Save to Drafts.", card) === "Sam wants to meet.\n\nTap Save to Drafts.");
  const cd = parseChatBlocks("3. a\n2. b\n1. c")[0] as { t: string; nums?: number[] };
  check("V14 every numbered item keeps its own number (countdown stays 3, 2, 1)", JSON.stringify(cd.nums) === "[3,2,1]", cd);
  const z0 = parseChatBlocks("0. zero\n1. one")[0] as { t: string; start?: number; nums?: number[] };
  check("V15 a list starting at 0 starts at 0", z0.start === 0 && JSON.stringify(z0.nums) === "[0,1]", z0);
  const wl = parseInline("see (https://en.wikipedia.org/wiki/Foo_(bar)) here").find((x) => x.t === "link") as { href: string } | undefined;
  check("V16 a URL with balanced parentheses keeps them; the wrapping one stays outside", wl?.href === "https://en.wikipedia.org/wiki/Foo_(bar)", wl);
  const ct = readFileSync("src/features/huddle/components/ChatText.tsx", "utf8");
  check("V17 ChatText renders each <li> with its own value", /value=\{b\.t === "ol" \? b\.nums\[j\] : undefined\}/.test(ct));
  const blk2 = "Meetings and classes:\n• 9:00 AM — A\n\nWould you like to adjust anything today? The button below.";
  for (const copy of ["**Meetings and classes**:", "### Meetings and classes:", "Meetings and classes", "**Meetings and classes:**"])
    check(`V18 a copied header '${copy}' is cut`, openerOnly(`Hello Sir, one meeting.\n${copy}\n9:00 AM A`, blk2) === "Hello Sir, one meeting.", openerOnly(`Hello Sir, one meeting.\n${copy}\n9:00 AM A`, blk2));
  check("V19 a copied closing question is cut", openerOnly("Hello Sir, one meeting.\n\nWould you like to adjust anything today?", blk2) === "Hello Sir, one meeting.");
  check("V20 an ordinary opener is kept whole", openerOnly("Hello Sir, just a reminder that today you have one meeting.", blk2) === "Hello Sir, just a reminder that today you have one meeting.");
  check("V21 bulletSection caps items with an '…and N more' line", bulletSection("T:", ["a", "b", "c"], 2, "see all.") === "T:\n• a\n• b\n…and 1 more see all.");
  const hv = readFileSync("src/features/huddle/components/HuddleView.tsx", "utf8");
  check("V9 a notice keeps the message row (and its email card / nav button): no early return on notice",
    !/if \(notice\) \{\s*return/.test(hv) && /\{notice \? \(/.test(hv));
}

// ---- E: notices ----------------------------------------------------------------------------------
{
  const quota = `(couldn't respond — ${QUOTA_OUTAGE_INLINE})`; // exactly what huddle.functions.ts hardReply writes
  const nt = noticeText(quota);
  check("E1 the quota hardReply is a notice", nt !== null && nt.startsWith("Couldn't respond — "), nt);
  check("E2 its outer parentheses are dropped", nt !== null && !nt.endsWith(")"), nt);
  check("E3 the model-unreachable hardReply is a notice", noticeText("(fallback: openai down) couldn't reach the model — timeout") !== null);
  check("E4 a normal reply is not a notice", noticeText(BOLD) === null);
  check("E5 a reply that merely mentions couldn't respond is not a notice", noticeText("I couldn't respond earlier — sorry.") === null);
  check("E6 'couldn't respond — ' mid-sentence is not a notice", noticeText("Sorry, I couldn't respond — I was in a meeting.") === null);
}

// ---- C: repeated draft ---------------------------------------------------------------------------
{
  const s = stripRepeatedDraft(EMAIL, EMAIL_BODY);
  check("C1 the draft copy is removed from the prose when the card shows it", !/Hi Terra Team/.test(s) && !/Best,/.test(s), s);
  check("C2 the 'Suggested reply:' label goes with it", !/Suggested reply/.test(s), s);
  check("C3 the summary and the closing line stay", /^The Terra Team at Terra/.test(s) && /Save to Drafts/.test(s), s);
  check("C4 no card body -> text unchanged", stripRepeatedDraft(EMAIL, undefined) === EMAIL);
  check("C6 a WEAK match (only the sign-off of a 3-paragraph draft) leaves the prose unchanged",
    stripRepeatedDraft("Sure thing.\n\nBest,\nVon", EMAIL_BODY) === "Sure thing.\n\nBest,\nVon");
  check("C5 a draft that is NOT in the prose leaves it unchanged", stripRepeatedDraft(EMAIL, "Totally different reply.\n\nCheers,\nVon") === EMAIL);
}

// ---- B: opener + code-built block (server) ------------------------------------------------------
{
  const block = "On your task list:\n• 5:00 PM — A\n• 7:00 PM — B\n\nWould you like to adjust anything today?";
  check("B1 the opener and block join with one blank line", joinOpenerAndBlock("Hello Sir, just a reminder that today you have two tasks.", block) === `Hello Sir, just a reminder that today you have two tasks.\n\n${block}`);
  const listy = "Hello Sir, just a reminder that today you have two tasks.\n\nOn your task list:\n\n• 5:00PM — A\n\n• 7:00PM — B";
  check("B2 a list the model wrote anyway is cut, so nothing shows twice", joinOpenerAndBlock(listy, block) === `Hello Sir, just a reminder that today you have two tasks.\n\n${block}`, joinOpenerAndBlock(listy, block));
  check("B3 an empty model reply still delivers the block under 'Hello Sir,'", joinOpenerAndBlock("", block) === `Hello Sir,\n\n${block}`);
  check("B4 a quota notice is replaced by 'Hello Sir,' so the brief still goes out", joinOpenerAndBlock(`(couldn't respond — ${QUOTA_OUTAGE_INLINE})`, block).startsWith("Hello Sir,\n\nOn your task list:"));
  check("B5 openerOnly stops at a copied section header", openerOnly("Hi.\nOn your task list:\nA", block) === "Hi.");
  check("B6 spacedClock: 7:00PM / 7:00 PM / 7:00 pm -> 7:00 PM", spacedClock("7:00PM, 7:00 PM, 7:00 pm") === "7:00 PM, 7:00 PM, 7:00 PM");
  check("B7 spacedClock leaves ranges readable", spacedClock("7:00PM–10:00PM") === "7:00 PM–10:00 PM");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
