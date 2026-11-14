// WHAT:          Offline suite for the correspondence "needs you" JUDGE (part A): the deterministic FACTS code
//                (recipient parsing, owner position, settled, header facts), the Tier 1 validator of the model's
//                answer, the judge flow with a STUBBED model, the judge processor, the synthetic fixture set, the
//                config switches, and a PIN of Iris's live email screen (inbound-email.ts must not move).
// WHY:           Owner 2026-11-14 redirect: meaning is decided by the model, not keywords. AC
//                docs/qc-evidence/AC-correspondence-redesign.md R1, R2 (facts), R3 fact rows S-A, R6, R7, R9.
// SUPERSEDES:    this file's keyword spelling tables S-B / S-C / S-F and the CC keyword rule tests (633d672c..a5f253c2).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/IMPL-needs-you-redesign.md.
//
// Run: bun scripts/needs-you.test.ts        ALL DATA SYNTHETIC (.example / .test addresses, made-up ids). NO live model.
import { readFileSync } from "node:fs";
import {
  asksSomething,
  inboundEmailDirective,
  newTextOnly,
  screenMessage,
  type InboundEmailMode,
  type InboundMessage,
} from "../src/features/huddle/lib/email/inbound-email";
import { latestSentByConversation, mapFeedMessage, parseFeedsConfig, type FeedInboundMessage } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import {
  conversationFacts,
  doerIsOwner,
  effectiveOwnerNames,
  groupEmailConversations,
  headerFacts,
  judgeConversation,
  judgeInput,
  JUDGE_INSTRUCTIONS,
  JUDGE_SCHEMA,
  ownerAddressing,
  ownerAddressSet,
  parseRecipients,
  reportBucket,
  validateJudgement,
  type Judgement,
  type NeedsYouContext,
} from "../src/features/huddle/lib/correspondence/needs-you";
import type { SourceItem } from "../src/features/huddle/lib/correspondence/source-item";
import { needsYouJudgeProcessor } from "../src/features/huddle/lib/proposals/engine";
import type { ProposalStore } from "../src/features/huddle/lib/proposals/proposals";

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const OWNER = "owner@work.example";
const MB = OWNER;
const owners = new Set([OWNER]);
const NAMES = ["Owner Name"];
const ctx = (over: Partial<NeedsYouContext> = {}): NeedsYouContext => ({
  ownerAddresses: owners,
  ownerNames: NAMES,
  latestSent: new Map(),
  sentKnown: true,
  ...over,
});
let seq = 0;
const em = (over: Partial<FeedInboundMessage> & { at?: string } = {}): FeedInboundMessage => {
  const { at, ...rest } = over;
  seq++;
  return {
    id: `feed:${MB}:m${seq}`,
    subject: "Budget numbers",
    receivedDateTime: at ?? `2026-11-10T1${seq % 10}:00:00Z`,
    bodyText: "Can you send the budget numbers?",
    fromAddress: "pat@work.example",
    fromName: "Pat Doe",
    conversationId: "conv-1",
    headerNames: [],
    precedence: null,
    autoSubmitted: null,
    toRecipients: OWNER,
    ...rest,
  };
};
// ── S-A recipient strings (owner = owner@work.example) ─────────────────────────────────────────────
const reach = (to: unknown, cc?: unknown) => ownerAddressing({ toRecipients: to, ccRecipients: cc }, owners).kind;
t("S-A1 To owner -> direct", reach("owner@work.example"), "direct");
t("S-A2 To Name <owner> -> direct", reach("Owner Name <owner@work.example>"), "direct");
t("S-A3 quoted 'Name, Owner' + pat -> group, 2 addresses", [reach('"Name, Owner" <owner@work.example>; pat@work.example'), parseRecipients('"Name, Owner" <owner@work.example>; pat@work.example').addresses.length], ["group", 2]);
t("S-A4 comma-separated pat, owner -> group", reach("pat@work.example, owner@work.example"), "group");
t("S-A5 OWNER@WORK.EXAMPLE -> direct (case-insensitive)", reach("OWNER@WORK.EXAMPLE"), "direct");
t("S-A6 a list address only -> none", reach("dl-all@work.example"), "none");
t("S-A7 To pat, CC owner -> cc_only (counts for replies; OQ-3)", reach("pat@work.example", "owner@work.example"), "cc_only");
t("S-A8 To empty, CC empty (BCC) -> none no_recipients", ownerAddressing({ toRecipients: "", ccRecipients: "" }, owners), { kind: "none", reason: "no_recipients" });
t("S-A9 'Undisclosed recipients:;' -> none", ownerAddressing({ toRecipients: "Undisclosed recipients:;" }, owners), { kind: "none", reason: "no_recipients" });
t("S-A10 owner@work.example.evil.test -> none (whole address only)", reach("owner@work.example.evil.test"), "none");
t("S-A11 notowner@work.example -> none (no substring)", reach("notowner@work.example"), "none");
t("S-A12 owner+billing@ -> none unless an alias", [reach("owner+billing@work.example"), ownerAddressing({ toRecipients: "owner+billing@work.example" }, new Set([OWNER, "owner+billing@work.example"])).kind], ["none", "direct"]);
t("S-A13 address text inside a display name -> the <addr> wins -> none", reach('"owner@work.example" <pat@work.example>'), "none");
t("AC-R3.2 display name + mixed case, with others -> group", reach("Pat Doe <pat@work.example>; Owner Name <OWNER@Work.Example>"), "group");
t("AC-R3.3 quoted comma -> 2 addresses not 3", parseRecipients('"Doe, Pat" <pat@work.example>, owner@work.example').addresses, ["pat@work.example", "owner@work.example"]);
t("AC-R3.6 Graph array shape == string shape", [
  reach([{ emailAddress: { name: "Owner", address: "Owner@work.example" } }]),
  reach([{ emailAddress: { address: "pat@work.example" } }, { emailAddress: { address: OWNER } }]),
  parseRecipients([{ emailAddress: { address: "pat@work.example" } }]).addresses,
], ["direct", "group", ["pat@work.example"]]);
t("R3 a field absent on both -> unknown no_recipient_field (never not_addressed)", ownerAddressing({}, owners), { kind: "unknown", reason: "no_recipient_field" });
t("R3 owner alone on To with others on CC -> group, ownerAloneOnTo", ownerAddressing({ toRecipients: OWNER, ccRecipients: "pat@work.example" }, owners), { kind: "group", ownerAloneOnTo: true });
t("P-5 real shape: ';'-separated, no <> / quotes", parseRecipients("a@work.example;owner@work.example; b@work.example").addresses, ["a@work.example", "owner@work.example", "b@work.example"]);
t("ownerAddressSet: mailbox + logins + aliases, lower-cased", [...ownerAddressSet({ mailbox: "Owner@Work.Example", ownerLogins: ["me@eds.example"], correspondence: { ownerAliases: ["alias@work.example"] } })], [OWNER, "me@eds.example", "alias@work.example"]);

// ── Owner names: CONTEXT for the model only (never a gate) ──────────────────────────────────────────
t("ON-1 configured ownerNames win", effectiveOwnerNames({ ownerLogins: ["first.last@eds.example"], correspondence: { ownerNames: ["Owner Name"] } }), ["Owner Name"]);
t("ON-2 default: first.last@ -> First; dedup; digits / 1-letter tokens skipped", effectiveOwnerNames({ ownerLogins: ["first.last@eds.example", "FIRST_x@other.example", "a.b@x.example", "r2d2@x.example"] }), ["First"]);

// ── F: deterministic FACTS (never meaning) ──────────────────────────────────────────────────────────
const key = (m: FeedInboundMessage) => `${MB}:conv:${m.conversationId}`;
const facts = (msgs: FeedInboundMessage[], c = ctx()) => conversationFacts(key(msgs[0]), msgs, c);
{
  const thread = [
    em({ conversationId: "f1", at: "2026-11-10T09:00:00Z", fromAddress: "a@work.example", bodyText: "Can you review the plan?" }),
    em({ conversationId: "f1", at: "2026-11-10T10:00:00Z", fromAddress: OWNER, subject: "Re: Budget numbers", bodyText: "Looking now.\n> Can you review the plan?" }),
    em({ conversationId: "f1", at: "2026-11-10T11:00:00Z", fromAddress: "b@work.example", subject: "Re: Budget numbers", bodyText: "Thanks!", toRecipients: "a@work.example; owner@work.example", ccRecipients: "c@work.example" }),
  ];
  const f = facts(thread);
  t("F-1 messages in time order, tagged OWNER / OTHER", f.messages.map((m) => m.speaker), ["OTHER", "OWNER", "OTHER"]);
  t("F-2 quoted history stripped from each message (newTextOnly)", f.messages[1].text, "Looking now.");
  t("F-3 latestOther is the newest message not from the owner", f.latestOther?.id, thread[2].id);
  t("F-4 owner position + counts on the latest OTHER message", [f.ownerPosition, f.othersOnTo, f.othersOnCc, f.recipientCount], ["group", 1, 1, 3]);
  t("F-5 owner message BEFORE the latest other -> NOT settled", f.settled, false);
}
t("F-6 settled: owner wrote in the inbox after the latest other", facts([em({ conversationId: "f2", at: "2026-11-10T09:00:00Z" }), em({ conversationId: "f2", at: "2026-11-10T10:00:00Z", fromAddress: "OWNER@work.example" })]).settled, true);
t("F-7 settled: a later Sent Items message (existing sentReplySettles)", facts([em({ conversationId: "f3", at: "2026-11-10T09:00:00Z" })], ctx({ latestSent: latestSentByConversation([{ conversationId: "f3", sentAt: "2026-11-10T10:00:00.000Z" }]) })).settled, true);
t("F-8 an EARLIER Sent Items message does not settle", facts([em({ conversationId: "f4", at: "2026-11-10T09:00:00Z" })], ctx({ latestSent: latestSentByConversation([{ conversationId: "f4", sentAt: "2026-11-10T08:00:00.000Z" }]) })).settled, false);
t("F-9 a zoneless received time is UTC (sent 10:30Z settles a 10:00 zoneless receipt; 09:30Z does not)", [
  facts([em({ conversationId: "f5", receivedDateTime: "2026-11-10T10:00:00" })], ctx({ latestSent: new Map([["f5", Date.parse("2026-11-10T10:30:00Z")]]) })).settled,
  facts([em({ conversationId: "f5", receivedDateTime: "2026-11-10T10:00:00" })], ctx({ latestSent: new Map([["f5", Date.parse("2026-11-10T09:30:00Z")]]) })).settled,
], [true, false]);
t("F-10 grouping by conversationId only (a forward with a new id is its own conversation)", groupEmailConversations(MB, [em({ conversationId: "o" }), em({ conversationId: "fw", subject: "Fw: Budget numbers" }), em({ conversationId: "o" })]).size, 2);
t("F-11 no conversationId -> own conversation keyed by message id", [...groupEmailConversations(MB, [em({ conversationId: null }), em({ conversationId: null })]).keys()].every((k) => k.includes(":msg:")), true);
t("F-12 header facts are names/values only", headerFacts({ headerNames: ["X-MS-Exchange-Calendar-Originator-Id", "list-unsubscribe", "x-ms-exchange-organization-bulkcategory"], precedence: "Bulk", autoSubmitted: "auto-generated" }), { calendarStamp: true, listUnsubscribe: true, autoSubmitted: "auto-generated", precedence: "bulk", bulkCategoryHeader: true });
{
  const f = facts([em({ conversationId: "f6", fromName: "Pat Doe", bodyText: "Can you send it?" })]);
  const input = judgeInput(f, NAMES);
  t("F-13 the judge input carries FACTS + the speaker-tagged thread + the LATEST OTHER marker", [/FACTS: \{/.test(input), /OTHER \(Pat Doe\)/.test(input), /LATEST OTHER MESSAGE/.test(input), /"owner_position_on_latest_other_message":"direct"/.test(input)], [true, true, true, true]);
  t("F-14 the instructions state the owner's rules (CC, never reply items, owner-only to-dos, verbatim quote)", [/CC counts only when/.test(JUDGE_INSTRUCTIONS), /NEVER reply items/.test(JUDGE_INSTRUCTIONS), /only things the OWNER himself must do/.test(JUDGE_INSTRUCTIONS), /VERBATIM/.test(JUDGE_INSTRUCTIONS)], [true, true, true, true]);
  t("F-15 strict schema: every key required", JUDGE_SCHEMA.required, ["category", "addressed", "ask", "owner_todos", "reason"]);
}

// ── V: Tier 1 validation of the model's answer ──────────────────────────────────────────────────────
const J = (o: Record<string, unknown> = {}) => ({ category: "needs_reply", addressed: "direct", ask: { quote: "Can you send the budget numbers?", summary: "numbers" }, owner_todos: [], reason: "r", ...o });
const fv = facts([em({ conversationId: "v1", at: "2026-11-10T09:00:00Z", bodyText: "Old ask: can you approve the plan?" }), em({ conversationId: "v1", at: "2026-11-10T10:00:00Z", bodyText: "Hi,\n  Can you   send the budget numbers?\nThanks" })]);
const ok = (raw: unknown) => {
  const v = validateJudgement(raw, fv);
  return v.ok ? [v.judgement.category, v.judgement.downgraded] : ["INVALID", v.reason];
};
t("V-1 a verbatim quote (whitespace-normalised) from the LATEST OTHER message -> needs_reply kept", ok(J()), ["needs_reply", null]);
t("V-2 GUARD: a quote NOT in the latest OTHER message -> downgraded to fyi", ok(J({ ask: { quote: "Can you call me tomorrow?", summary: "x" } })), ["fyi", "quote_not_in_latest_other"]);
t("V-3 GUARD: a quote from an EARLIER message (not the latest) -> downgraded", ok(J({ ask: { quote: "can you approve the plan?", summary: "x" } })), ["fyi", "quote_not_in_latest_other"]);
t("V-4 GUARD: needs_reply with no ask -> downgraded", ok(J({ ask: null })), ["fyi", "ask_missing"]);
t("V-5 GUARD: needs_reply but addressed not_addressed -> downgraded", ok(J({ addressed: "not_addressed" })), ["fyi", "not_addressed"]);
t("V-6 GUARD: a too-short quote ('Can') is not grounding", ok(J({ ask: { quote: "Can", summary: "x" } })), ["fyi", "quote_not_in_latest_other"]);
t("V-7 typographic quotes/dashes normalise", validateJudgement(J({ ask: { quote: "Can you send the budget numbers?", summary: "x" } }), facts([em({ conversationId: "v2", bodyText: "Can you send the budget numbers?" })])).ok, true);
t("V-8 bad JSON shapes -> INVALID (caller marks needs_context, never open)", [ok(null), ok("text"), ok(J({ category: "urgent" })), ok(J({ addressed: "maybe" })), ok(J({ ask: { quote: 3 } })), ok(J({ owner_todos: "x" })), ok(J({ owner_todos: [{ title: 1 }] }))], [
  ["INVALID", "not_object"], ["INVALID", "not_object"], ["INVALID", "bad_category"], ["INVALID", "bad_addressed"], ["INVALID", "bad_ask"], ["INVALID", "bad_todos"], ["INVALID", "bad_todos"],
]);
t("V-9 a non-needs_reply category never carries an ask", (() => {
  const v = validateJudgement(J({ category: "fyi" }), fv);
  return v.ok ? v.judgement.ask : "INVALID";
})(), null);
t("V-10 doerIsOwner: null -> owner; a config name / its first word -> owner; anyone else -> not", [doerIsOwner(null, NAMES), doerIsOwner("Owner Name", NAMES), doerIsOwner("owner", NAMES), doerIsOwner("Pat", NAMES)], [true, true, true, false]);

// ── J: the judge flow with a STUBBED model ──────────────────────────────────────────────────────────
const stubJudge = (answer: unknown | ((input: string) => unknown)) => {
  const calls: string[] = [];
  const fn = async (_i: string, input: string) => {
    calls.push(input);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? (answer as (s: string) => unknown)(input) : answer;
  };
  return { calls, fn };
};
{
  const settled = facts([em({ conversationId: "j1", at: "2026-11-10T09:00:00Z" }), em({ conversationId: "j1", at: "2026-11-10T10:00:00Z", fromAddress: OWNER })]);
  const s = stubJudge(J());
  t("J-1 GUARD: a SETTLED conversation is never sent to the model", [(await judgeConversation(settled, NAMES, s.fn)).status, s.calls.length], ["settled", 0]);
  const ownerOnly = facts([em({ conversationId: "j2", fromAddress: OWNER })]);
  t("J-2 an owner-only conversation is never sent to the model", [(await judgeConversation(ownerOnly, NAMES, s.fn)).status, s.calls.length], ["owner_only", 0]);
  const bad = stubJudge("not json at all");
  t("J-3 GUARD: bad JSON from the model -> needs_context (never open)", (await judgeConversation(fv, NAMES, bad.fn)).status, "needs_context");
  const boom = stubJudge(new Error("model down"));
  let threw = false;
  try {
    await judgeConversation(fv, NAMES, boom.fn);
  } catch {
    threw = true;
  }
  t("J-4 a model FAILURE throws (the ledger's failed_retryable / maxAttempts path)", threw, true);
  const cache = new Map<string, Judgement>();
  const jc = { get: (k: string) => cache.get(k), set: (k: string, v: Judgement) => void cache.set(k, v) };
  const c1 = stubJudge(J());
  await judgeConversation(fv, NAMES, c1.fn, jc);
  const again = await judgeConversation(fv, NAMES, c1.fn, jc);
  t("J-5 cached by conversation + latest message id: the same latest message is judged once", [c1.calls.length, again.status === "judged" && again.cached], [1, true]);
  const fv2 = facts([...[em({ conversationId: "v1", at: "2026-11-10T09:00:00Z", bodyText: "Old ask: can you approve the plan?" })], em({ conversationId: "v1", at: "2026-11-10T12:00:00Z", bodyText: "New: can you join Friday?" })]);
  await judgeConversation(fv2, NAMES, c1.fn, jc);
  t("J-6 a NEW latest message re-judges", c1.calls.length, 2);
  t("J-7 Sent Items unusable -> a validated needs_reply is cant_tell_no_sent_items, never listed", reportBucket({ ...fv, sentKnown: false }, { status: "judged", judgement: { category: "needs_reply", addressed: "direct", ask: { quote: "x", summary: "y" }, todos: [], downgraded: null }, cached: false }), "cant_tell_no_sent_items");
}

// ── Q: the judge processor (ledger seam) ────────────────────────────────────────────────────────────
{
  type Up = Parameters<ProposalStore["upsert"]>[0];
  const memProps = () => {
    const rows: Up[] = [];
    const refs = new Map<string, string>();
    return {
      rows,
      async upsert(p: Up) {
        const rk = [p.ref.source, p.ref.sourceItemId, p.normTitle].join("|");
        if (refs.has(rk)) return { kind: "seen" as const, id: refs.get(rk)! };
        rows.push(p);
        refs.set(rk, p.id);
        return { kind: "created" as const, id: p.id };
      },
      async priorRelated() {
        return [];
      },
    } as unknown as ProposalStore & { rows: Up[] };
  };
  const eItem = (m: FeedInboundMessage): SourceItem => ({ source: "email", sourceItemId: m.id.replace(/^feed:/, ""), identityBasis: "provider_id", threadId: m.conversationId ?? null, at: m.receivedDateTime ?? null, contentHash: "h", drivePath: null, driveItemId: null, fileEtag: null, internetMessageId: null, email: m });
  const run = async (msgs: FeedInboundMessage[], answer: unknown, extra: { teams?: SourceItem[] } = {}) => {
    const store = memProps();
    const j = stubJudge(answer);
    const extractCalls: string[] = [];
    const proc = needsYouJudgeProcessor({ store, judge: j.fn, extract: async (_i, input) => (extractCalls.push(input), { tasks: [] }), openTitles: async () => null, tz: "America/New_York", owner: () => "me@eds.example", mailbox: () => MB, needsYou: async () => ctx() });
    const items = [...msgs.map(eItem), ...(extra.teams ?? [])];
    const outs = [];
    for (const it of items) outs.push(await proc.process(it, { owner: "me@eds.example", nowMs: 0, batch: items }));
    return { store, judgeCalls: j.calls.length, extractCalls: extractCalls.length, outs };
  };
  const conv = [
    em({ conversationId: "q1", at: "2026-11-10T09:00:00Z", bodyText: "Please send the quarterly budget deck by Friday." }),
    em({ conversationId: "q1", at: "2026-11-10T10:00:00Z", fromAddress: "b@work.example", subject: "Re: Budget numbers", bodyText: "Dana will update the hiring plan spreadsheet." }),
  ];
  const todos = [
    { title: "Send the quarterly budget deck", quote: "Please send the quarterly budget deck by Friday", doer: null, due_text: "by Friday" },
    { title: "Update the hiring plan spreadsheet", quote: "Dana will update the hiring plan spreadsheet", doer: "Dana", due_text: null },
    { title: "Book flights to the offsite", quote: "Thanks for the update on the offsite plans", doer: null, due_text: null },
  ];
  const r = await run(conv, J({ category: "action_for_owner", ask: null, owner_todos: todos }));
  t("Q-1 two messages of ONE conversation -> ONE judge call", r.judgeCalls, 1);
  t("Q-2 GUARD: the to-do for someone else (doer Dana) is dropped; the invented-quote one fails the EXISTING validator; the owner's is stored", r.store.rows.map((x) => x.title), ["Send the quarterly budget deck"]);
  t("Q-3 the stored to-do keeps the existing validator's due date and the conversation key as its ref", [r.store.rows[0]?.dueText, r.store.rows[0]?.ref.sourceItemId], ["by Friday", `${MB}:conv:q1`]);
  const settled = await run([em({ conversationId: "q2", at: "2026-11-10T09:00:00Z" }), em({ conversationId: "q2", at: "2026-11-10T10:00:00Z", fromAddress: OWNER })], J());
  t("Q-4 a settled conversation: ZERO judge calls, processed", [settled.judgeCalls, settled.outs[0].status], [0, "processed"]);
  const badJson = await run([em({ conversationId: "q3" })], { nope: true });
  t("Q-5 GUARD: bad JSON -> the ledger item is needs_context (retried), never processed/open", badJson.outs[0], { status: "needs_context", missingField: "judge_bad_category" });
  for (const cat of ["meeting_minutes", "calendar", "automated_or_broadcast"]) {
    const x = await run(conv, J({ category: cat, ask: null, owner_todos: todos }));
    t(`Q-6 GUARD: a ${cat} conversation yields ZERO to-dos even if the model listed some`, x.store.rows.length, 0);
  }
  const na = await run(conv, J({ category: "fyi", addressed: "not_addressed", ask: null, owner_todos: todos }));
  t("Q-7 a not_addressed conversation yields ZERO to-dos", na.store.rows.length, 0);
  const teams: SourceItem = { source: "teams", sourceItemId: "c:m", identityBasis: "provider_id", threadId: "c", at: "2026-11-10T10:00:00Z", contentHash: "h", drivePath: null, driveItemId: null, fileEtag: null, internetMessageId: null, teams: { chatId: "c", messageId: "m", at: "2026-11-10T10:00:00Z", senderId: "p", senderName: "P", senderIsApp: false, fromOwner: false, text: "Please send the quarterly budget deck by Friday." } };
  const tr = await run([], J(), { teams: [teams] });
  t("SCOPE Teams items go to the ORIGINAL per-message path (its own extraction call; never the judge)", [tr.judgeCalls, tr.extractCalls], [0, 1]);
}

// ── X: the synthetic fixture set for the later HUMAN check (no live model here) ─────────────────────
{
  const cases = JSON.parse(readFileSync(new URL("./fixtures/needs-you-judge-cases.json", import.meta.url).pathname, "utf8")) as Array<{ name: string; expected: string; messages: Array<Record<string, unknown>> }>;
  t("X-1 the fixture set has >= 10 conversations covering every category", [cases.length >= 10, [...new Set(cases.map((c) => c.expected))].sort()], [true, ["action_for_owner", "automated_or_broadcast", "calendar", "fyi", "meeting_minutes", "needs_reply", "settled"]]);
  const bad: string[] = [];
  for (const c of cases) {
    const msgs = c.messages.map((r) => mapFeedMessage(r, MB));
    const f = conversationFacts(`${MB}:conv:${c.name}`, msgs, ctx());
    // Only the DETERMINISTIC part is checked here: "settled" cases are settled, every other case reaches the model.
    if ((c.expected === "settled") !== f.settled) bad.push(c.name);
    if (!judgeInput(f, NAMES).includes("LATEST OTHER MESSAGE") && c.expected !== "settled") bad.push(`${c.name}:no-latest`);
  }
  t("X-2 every fixture maps to facts; 'settled' cases are settled and the rest would be judged", bad, []);
}
// ── Config switches (AC-R9.1) ───────────────────────────────────────────────────────────────────────
const base = { enabled: true, ownerLogins: ["me@eds.example"], driveUser: "drive@eds.example", mailbox: MB, synthetic: false };
const cc = (c: unknown) => parseFeedsConfig(JSON.stringify({ ...base, correspondence: c }))!.correspondence;
t("AC-R9.1 conversations / emailBell OFF unless literally true (absent, 'true', 1, false)", [undefined, "true", 1, false, true].map((v) => [cc({ conversations: v }).conversations, cc({ emailBell: v }).emailBell]), [[false, false], [false, false], [false, false], [false, false], [true, true]]);
t("OQ-4 ownerAliases: whole addresses only, lower-cased; ownerNames from config", [cc({ ownerAliases: ["Alias@Work.Example", "not an address", 3] }).ownerAliases, cc({ ownerNames: ["Owner Name", "", "O"] }).ownerNames], [["alias@work.example"], ["Owner Name"]]);

// ── P: PIN of Iris's live email screen (owner: "must NOT change"; AC-R1.1/1.2/1.4/1.5) ─────────────
// A fixed fixture of synthetic messages covering the S-A..S-D rows, run through screenMessage in all three modes,
// asksSomething, newTextOnly and the alert directive. The snapshot is committed (scripts/fixtures/needs-you-pin.json);
// any change to the live behaviour fails here. Extra mapper fields (toRecipients...) must change nothing.
const pinMsgs: InboundMessage[] = [];
const subjects = ["Budget numbers", "Re: Budget numbers", "Fw: Meeting Minutes: Budget sync", "Accepted: Q3 review", "Invitation: Q3 review", "Updated invitation: Q3", "Meeting request: sync", "Re: quick invite question", "Team invite list", "Invitation to speak at our panel", "Summary of the budget", "Meeting recap: Budget sync", "Q3 review", "Canceled: Q3 review"];
const bodies = ["Can you send the numbers?", "Thanks, all set.", "Owner, can you take item 3 by Friday?", "Microsoft Teams meeting\nJoin the meeting now", "Sounds good.\n> Can you send it?\nOn Mon, Nov 10, 2026 at 9:14 AM Dana <dana@work.example> wrote:\n> old", "Please review", "FYI only"];
const froms = ["pat@work.example", "noreply@vendor.example", OWNER, "fred@fireflies.ai"];
let pi = 0;
for (const s of subjects) for (const b of bodies) {
  pi++;
  pinMsgs.push({ id: `pin-${pi}`, subject: s, bodyText: b, fromAddress: froms[pi % froms.length], fromName: "Pat", conversationId: `pc-${pi % 5}`, receivedDateTime: "2026-11-10T10:00:00Z", headerNames: pi % 7 === 0 ? ["list-unsubscribe"] : pi % 11 === 0 ? ["x-ms-exchange-calendar-originator-id"] : [], precedence: pi % 13 === 0 ? "bulk" : null, autoSubmitted: pi % 17 === 0 ? "auto-generated" : null, inferenceClassification: pi % 19 === 0 ? "other" : undefined });
}
const MODES: InboundEmailMode[] = ["needs-reply", "people", "all"];
const pinOf = (msgs: InboundMessage[]) => msgs.map((m) => ({ id: m.id, screen: MODES.map((mode) => screenMessage(m, mode, OWNER)), asks: asksSomething(m), newText: newTextOnly(m.bodyText ?? ""), directive: inboundEmailDirective(m, "Mon 10:00") }));
const pinNow = pinOf(pinMsgs);
const PIN_FILE = new URL("./fixtures/needs-you-pin.json", import.meta.url).pathname;
if (process.env.NEEDS_YOU_WRITE_PIN === "1") {
  (await import("node:fs")).writeFileSync(PIN_FILE, JSON.stringify(pinNow, null, 1));
  console.log(`wrote pin snapshot (${pinNow.length} messages)`);
}
const pinSaved = JSON.parse(readFileSync(PIN_FILE, "utf8"));
t(`AC-R1.2 PIN: screenMessage x3 modes, asksSomething, newTextOnly, directive identical on ${pinMsgs.length} synthetic messages`, JSON.stringify(pinNow) === JSON.stringify(pinSaved), true);
t("AC-R1.2 PIN fixture covers >= 40 messages", pinMsgs.length >= 40, true);
const withExtras = pinMsgs.map((m, i) => ({ ...m, toRecipients: i % 2 ? OWNER : "dl@work.example", ccRecipients: "pat@work.example", contentClass: i % 3 ? "urn:content-classes:calendarmessage" : null }));
t("AC-R1.4 the optional mapper fields change NO live verdict, ask or directive", JSON.stringify(pinOf(withExtras)) === JSON.stringify(pinSaved), true);
{
  const src = readFileSync(new URL("../src/features/huddle/lib/correspondence/needs-you.ts", import.meta.url).pathname, "utf8").replace(/\/\/.*$/gm, "");
  t("AC-R1.5 + owner redirect: the judge module uses NO live-screen rule and NO keyword classifier for meaning", [/screenMessage|asksSomething|INVITE_SUBJECT|isAutomatedAddress/.test(src), /addressesGroup|ccCallsOnOwner|isMinutesEmail|directAsk|MINUTES_KEYWORD|CALENDAR_SUBJECT|namesOwner/.test(src)], [false, false]);
  const prev = readFileSync(new URL("../scripts/proposals-preview.ts", import.meta.url).pathname, "utf8").replace(/\/\/.*$/gm, "");
  t("AC-R1.6 the preview no longer decides 'open' with screenMessage / INBOUND_EMAIL_MODE_DEFAULT", [/screenMessage/.test(prev), /INBOUND_EMAIL_MODE_DEFAULT/.test(prev)], [false, false]);
}
t("mapFeedMessage: a record without the new fields maps with NO new keys (exactly as before)", Object.keys(mapFeedMessage({ id: "x", subject: "s" }, MB)).filter((k) => ["toRecipients", "ccRecipients", "contentClass"].includes(k)), []);
t("mapFeedMessage: carries toRecipients / ccRecipients when present", [mapFeedMessage({ id: "x", toRecipients: "a@work.example;b@work.example", ccRecipients: "" }, MB).toRecipients, mapFeedMessage({ id: "x", ccRecipients: "" }, MB).ccRecipients], ["a@work.example;b@work.example", ""]);
// ── Z: zero-call when the switch is OFF (AC-R9.2) ──────────────────────────────────────────────────
{
  const src = readFileSync(new URL("../src/features/huddle/lib/proposals/proposals.server.ts", import.meta.url).pathname, "utf8");
  t("AC-R9.2 the judge processor is only built behind correspondence.conversations === true; else the original processor (no judge)", [/if \(cfg\.correspondence\.conversations === true\) \{[\s\S]*needsYouJudgeProcessor\(/.test(src), /return proposalsProcessor\(\{ \.\.\.d, owner/.test(src), (src.match(/needsYouJudgeProcessor\(/g) ?? []).length], [true, true, 1]);
  t("AC-R9.2 flag absent / 'true' / 1 -> OFF", [undefined, "true", 1].map((v) => cc({ conversations: v }).conversations), [false, false, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
