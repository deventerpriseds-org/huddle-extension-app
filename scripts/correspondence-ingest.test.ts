// WHAT:       Offline tests for the correspondence ingest DATA LAYER: the Teams JSONL adapter, the Teams
//             config entry and switches, email source identity, the ledger pass (with an in-memory twin of
//             the ledger), the dummy-file fixtures, and public-repo hygiene. Every check is labelled with
//             the AC id it proves (docs/ac/AC-correspondence-checklist.md, branch
//             claude_ac-correspondence-checklist).
// WHY:        Tier 1 path: the adapter decides which messages become stored claims. Synthetic fixtures only
//             (scripts/fixtures/onedrive/*, `.example` domains, HUDDLE-PA-SBX- prefix, CANARY-7f3a marker).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-correspondence-ingest.md.
// Run: bun scripts/correspondence-ingest.test.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  latestSentByConversation,
  mapFeedMessage,
  mapSentRecords,
  parseFeedsConfig,
  sentReplySettles,
  validateEmailSnapshot,
  validateSentSnapshot,
} from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { parseTeamsLog, teamsParseNote } from "../src/features/huddle/lib/external-feeds/teams-log";
import {
  combineOutcomes,
  emailSourceItem,
  errorCategory,
  ledgerKey,
  stableHash,
  teamsSourceItem,
  teamsSourceItemId,
  type ClaimedItem,
  type CorrespondenceSource,
  type CursorStore,
  type ItemProcessor,
  type LedgerStatus,
  type LedgerStore,
  type ProcessOutcome,
  type SourceCursor,
  type SourceItem,
  type TeamsMessage,
} from "../src/features/huddle/lib/correspondence/source-item";
import { ledgerEmailItems, runIngestPass, type PassDeps } from "../src/features/huddle/lib/correspondence/ingest-pass";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const ROOT = join(import.meta.dir, "..");
const FIX = join(ROOT, "scripts/fixtures/onedrive");
const teamsFixture = readFileSync(join(FIX, "huddle-source-log.sample.jsonl"), "utf8");
const emailFixture = JSON.parse(readFileSync(join(FIX, "emails.sample.json"), "utf8"));

// Placeholder identities only (public repo).
const baseJson = {
  enabled: true,
  ownerLogins: ["login@eds.example", "owner@eds.example"],
  driveUser: "owner@eds.example",
  mailbox: "owner@work.example",
  sourceLogin: "login@work.example",
  synthetic: true,
  subjectPrefix: "HUDDLE-PA-SBX-",
};
const withTeams = { ...baseJson, teams: { path: "/automation/email/huddle-source-log.jsonl", ownerSenderIds: ["USER-OWNER-1"] } };
const cfg = parseFeedsConfig(JSON.stringify(withTeams))!;

console.log("A. CONFIG — Teams entry + switches (AC-1.1, AC-6.1, AC-6.3)");
const noTeams = parseFeedsConfig(JSON.stringify(baseJson))!;
t("AC-1.1 teams entry parsed with the same path rule", [cfg.teams.enabled, cfg.teams.path, cfg.teams.source, cfg.teams.ownerSenderIds], [
  true,
  "/automation/email/huddle-source-log.jsonl",
  "teams",
  ["user-owner-1"],
]);
t("AC-1.1 teams path without leading / -> disabled", parseFeedsConfig(JSON.stringify({ ...baseJson, teams: { path: "automation/x.jsonl" } }))!.teams.enabled, false);
t("AC-1.1 teams path with .. -> disabled", parseFeedsConfig(JSON.stringify({ ...baseJson, teams: { path: "/a/../x.jsonl" } }))!.teams.enabled, false);
t("AC-1.1 teams enabled:false honoured", parseFeedsConfig(JSON.stringify({ ...baseJson, teams: { enabled: false } }))!.teams.enabled, false);
t("AC-6.1 absent teams key -> teams OFF (a new source never switches itself on)", noTeams.teams.enabled, false);
t(
  "AC-1.1 absent teams key leaves email/appointments parsing identical",
  [noTeams.email, noTeams.appointments, noTeams.synthetic, noTeams.maxBytes],
  [cfg.email, cfg.appointments, cfg.synthetic, cfg.maxBytes],
);
t("AC-6.1 correspondence switches all OFF by default", noTeams.correspondence, {
  ingest: false,
  sources: ["teams", "email"],
  bell: false,
  proposals: false,
  maxAttempts: 5,
  minIntervalMinutes: 10,
});
t("AC-6.1 only a literal true turns a switch on", parseFeedsConfig(JSON.stringify({ ...baseJson, correspondence: { ingest: "yes", bell: 1 } }))!.correspondence.ingest, false);
const perm = (c: Record<string, unknown>) => {
  const k = parseFeedsConfig(JSON.stringify({ ...baseJson, correspondence: c }))!.correspondence;
  return [k.ingest, k.bell, k.proposals];
};
t("AC-6.3 bell only / proposals only / both are independent", [perm({ ingest: true, bell: true }), perm({ ingest: true, proposals: true }), perm({ ingest: true, bell: true, proposals: true })], [
  [true, true, false],
  [true, false, true],
  [true, true, true],
]);
t("AC-3.6 maxAttempts configurable, bounded", [perm({}) && parseFeedsConfig(JSON.stringify({ ...baseJson, correspondence: { maxAttempts: 3 } }))!.correspondence.maxAttempts, parseFeedsConfig(JSON.stringify({ ...baseJson, correspondence: { maxAttempts: 999 } }))!.correspondence.maxAttempts, parseFeedsConfig(JSON.stringify({ ...baseJson, correspondence: { maxAttempts: 0 } }))!.correspondence.maxAttempts], [3, 20, 5]);
t("AC-6.3 sources filter rejects unknown names", parseFeedsConfig(JSON.stringify({ ...baseJson, correspondence: { sources: ["teams", "fax"] } }))!.correspondence.sources, ["teams"]);

t("PA contract: teams.ownerIds accepted as an alias of ownerSenderIds, merged, lower-cased", parseFeedsConfig(JSON.stringify({ ...baseJson, teams: { ownerSenderIds: ["A"], ownerIds: ["b", "a"] } }))!.teams.ownerSenderIds, ["a", "b"]);
t("PA contract: teams entry with no path -> the REAL file's default (own folder, with a space)", parseFeedsConfig(JSON.stringify({ ...baseJson, teams: {} }))!.teams.path, "/automation/Teams Chats/teams-chats.jsonl");
t("PA contract: the real default path passes the path rule (a space is allowed)", parseFeedsConfig(JSON.stringify({ ...baseJson, teams: {} }))!.teams.enabled, true);
t("AC-6.4 / owner decision 2: absent `sent` key -> Sent Items OFF", noTeams.sent, { enabled: false, path: "/automation/email/sent.json" });
t("PA contract: `sent` entry -> same path rule as email", [parseFeedsConfig(JSON.stringify({ ...baseJson, sent: {} }))!.sent, parseFeedsConfig(JSON.stringify({ ...baseJson, sent: { path: "sent.json" } }))!.sent.enabled], [{ enabled: true, path: "/automation/email/sent.json" }, false]);

console.log("B. TEAMS ADAPTER — the fixture (AC-1.3..1.12, AC-7.1)");
const p = parseTeamsLog(teamsFixture, cfg);
t("AC-1.3 JSONL parsed line by line (never whole-file JSON)", [p.rejected ?? "none", p.lines], ["none", 7]);
t("AC-1.4 / S-7 truncated line skipped and counted, other lines kept", [p.skipped.not_json_line, p.messages.length], [1, 5]);
t("S-15 wrong source line skipped, counted", p.skipped.wrong_source, 1);
t("AC-1.5 / S-2 repeated message kept ONCE, counted as duplicate", [p.messages.filter((m) => m.messageId === "1001").length, p.duplicates], [1, 1]);
t("S-4 message without id skipped, counted", p.skipped.missing_message_id, 1);
t("S-16 (provisional) system event message is not an item", p.skipped.not_a_message, 1);
t("AC-1.11 empty message array: zero items, not an error", p.skipped.missing_messages ?? 0, 0);
const m3001 = p.messages.find((m) => m.messageId === "3001")!;
t("S-11 html body -> text via the email feed converter", m3001.text, "HUDDLE-PA-SBX- Please update the budget sheet before the review.");
t("S-13 quoted <blockquote> history is not in the item text", m3001.text.includes("echo:") || m3001.text.includes("CANARY"), false);
t("S-12 owner's own message ACCEPTED and marked fromOwner (reply signal)", p.messages.find((m) => m.messageId === "1002")!.fromOwner, true);
t("AC-4.8 seam: an application sender is marked senderIsApp", p.messages.find((m) => m.messageId === "3003")!.senderIsApp, true);
t("Graph-style from.user sender mapped", [m3001.senderId, m3001.senderName], ["user-other-3", "Alex Placeholder"]);
t("AC-1.12 output is source-neutral (no PA field names)", Object.keys(p.messages[0]).sort(), [
  "at",
  "chatId",
  "chatName",
  "fromOwner",
  "messageId",
  "senderId",
  "senderIsApp",
  "senderName",
  "text",
]);
t("AC-1.4 note names COUNTS and reasons only, no content", (() => {
  const n = teamsParseNote(p)!;
  return [n.includes("skipped 2 line(s)"), /CANARY|chat-|1001|Pat|HUDDLE/.test(n)];
})(), [true, false]);

console.log("C. TEAMS ADAPTER — spelling table rows (S-1..S-16)");
const L = (over: Record<string, unknown> = {}, msgs: unknown[] = [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", body: "HUDDLE-PA-SBX- hello?", sender: "u1" }]) =>
  JSON.stringify({ source: "teams", synthetic: true, chatId: "c1", capturedUtc: "2026-11-11T23:00:00Z", status: "pending", messages: msgs, ...over });
const parse = (text: string, c = cfg) => parseTeamsLog(text, c);
t("S-1 planned shape accepted, one item per message", parse(L()).messages.length, 1);
t("AC-1.6 / S-3 different capturedUtc, same ids -> one item", parse([L(), L({ capturedUtc: "2026-11-12T23:00:00Z" })].join("\n")).messages.length, 1);
t("AC-1.6 capture time is not part of the content hash", (() => {
  const a = teamsSourceItem(parse(L()).messages[0], { path: "/x" });
  const b = teamsSourceItem(parse(L({ capturedUtc: "2030-01-01T00:00:00Z" })).messages[0], { path: "/x" });
  return a.contentHash === b.contentHash && a.sourceItemId === b.sourceItemId;
})(), true);
t("AC-3.4 an edited body changes the hash, not the id", (() => {
  const a = teamsSourceItem(parse(L()).messages[0], { path: "/x" });
  const b = teamsSourceItem(parse(L({}, [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", body: "HUDDLE-PA-SBX- hello, edited?", sender: "u1" }])).messages[0], { path: "/x" });
  return [a.sourceItemId === b.sourceItemId, a.contentHash === b.contentHash];
})(), [true, false]);
t("S-2 a later copy of the same message wins (edit in a rerun)", parse([L(), L({}, [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", body: "HUDDLE-PA-SBX- v2", sender: "u1" }])].join("\n")).messages[0].text, "HUDDLE-PA-SBX- v2");
t("AC-1.7 same message id in two chats -> two items", parse([L({ chatId: "c1" }), L({ chatId: "c2" })].join("\n")).messages.length, 2);
t("AC-1.7 identity keys cannot collide across ':' in chat ids", teamsSourceItemId("a:b", "c") === teamsSourceItemId("a", "b:c"), false);
t("S-5 line without chatId skipped", parse(L({ chatId: "" })).skipped.missing_chat_id, 1);
t("S-6 unparseable timestamp skipped", parse(L({}, [{ id: "m1", timestamp: "tuesday", body: "HUDDLE-PA-SBX- x", sender: "u1" }])).skipped.bad_timestamp, 1);
t("S-8 whole file is a JSON array -> rejected not_jsonl (never half-ingested)", parse(`[${L()},${L({ chatId: "c2" })}]`).rejected, "not_jsonl");
t("S-8 an array written one object per line (last line parses alone) -> rejected, never half-ingested", parse(`[\n${L()},\n${L({ chatId: "c2" })}\n]`).rejected, "not_jsonl");
t("S-8 pretty-printed single object (no line parses) -> rejected not_jsonl", parse(JSON.stringify(JSON.parse(L()), null, 2)).rejected, "not_jsonl");
t("S-9 (provisional) blank lines ignored, not counted", (() => {
  const r = parse([L(), "", "   ", L({ chatId: "c2" })].join("\n"));
  return [r.messages.length, r.lines, r.skippedLines];
})(), [2, 2, 0]);
t("S-10 (provisional) CRLF line endings accepted", parse([L(), L({ chatId: "c2" })].join("\r\n")).messages.length, 2);
t("S-14 a URL-only body maps to [link] (its '?' is not a question)", parse(L({}, [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", body: { contentType: "html", content: "HUDDLE-PA-SBX- https://x.example/form?id=1" }, sender: "u1" }])).messages[0].text, "HUDDLE-PA-SBX- [link]");
t("S-16 (provisional) deleted message skipped", parse(L({}, [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", deletedDateTime: "2026-11-11T11:00:00Z", body: "HUDDLE-PA-SBX- x" }])).skipped.deleted, 1);
t("Graph createdDateTime / value aliases accepted", parse(JSON.stringify({ source: "teams", synthetic: true, chatId: "c9", value: [{ id: "g1", createdDateTime: "2026-11-11T10:00:00Z", body: { contentType: "text", content: "HUDDLE-PA-SBX- hi" }, from: { user: { id: "U1", displayName: "N" } } }] })).messages[0].senderId, "u1");
t("PA contract: the doc's exact Graph message shape (createdDateTime, from.user, body object, webUrl, messageType)", (() => {
  const line = JSON.stringify({ source: "teams", synthetic: true, chatId: "19:chat-alpha@thread.example", chatName: "HUDDLE-PA-SBX- Alpha chat", capturedUtc: "2026-11-11T23:00:00Z", messages: [{ id: "1001", createdDateTime: "2026-11-10T14:00:00Z", messageType: "message", webUrl: "https://teams.example/l/message/1001", body: { contentType: "text", content: "HUDDLE-PA-SBX- Can you send me the Q3 deck by Friday?" }, from: { user: { id: "USER-OWNER-1", displayName: "Owner Example" } } }] });
  const m = parse(line).messages[0];
  return [m.messageId, m.at, m.senderId, m.fromOwner, m.webUrl, m.text, m.chatName];
})(), ["1001", "2026-11-10T14:00:00.000Z", "user-owner-1", true, "https://teams.example/l/message/1001", "HUDDLE-PA-SBX- Can you send me the Q3 deck by Friday?", "HUDDLE-PA-SBX- Alpha chat"]);
t("AC-1.9 synthetic config: line NOT marked synthetic -> skipped", parse(L({ synthetic: undefined })).skipped.synthetic_mismatch, 1);
t("AC-1.9 synthetic config: text without the test prefix -> skipped", parse(L({}, [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", body: "a real message", sender: "u1" }])).skipped.prefix_mismatch, 1);
const live = parseFeedsConfig(JSON.stringify({ ...withTeams, synthetic: false, subjectPrefix: "" }))!;
t("AC-1.9 live config: line still marked synthetic -> skipped", parse(L(), live).skipped.synthetic_mismatch, 1);
t("AC-1.9 live config: unmarked line -> skipped (must say synthetic:false)", parse(L({ synthetic: undefined }), live).skipped.synthetic_mismatch, 1);
t("AC-1.9 live config: synthetic:false accepted, no prefix needed", parse(L({ synthetic: false }, [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", body: "real words", sender: "u1" }]), live).messages.length, 1);
const nb = parseFeedsConfig(JSON.stringify({ ...withTeams, notBeforeUtc: "2026-11-11T12:00:00Z" }))!;
t("AC-1.10 message before notBeforeUtc never evaluated", parse(L(), nb).skipped.before_not_before, 1);
t("fromOwner is null when owner ids are not configured (OQ-4: never guessed)", parse(L(), noTeams).messages[0].fromOwner, null);
t("AC-1.8 tail read: the first (partial) line is dropped", (() => {
  const full = [L({ chatId: "c1" }), L({ chatId: "c2" }), L({ chatId: "c3" })].join("\n");
  const tail = full.slice(20); // starts mid-line, as a byte-range read does
  const r = parseTeamsLog(tail, cfg, { dropFirstLine: true });
  return [r.rejected ?? "none", r.messages.map((m) => m.chatId), r.skippedLines];
})(), ["none", ["c2", "c3"], 0]);
t("AC-1.8 tail note says bytes not read, counts only", teamsParseNote({ messages: [], lines: 0, skippedLines: 0, skippedMessages: 0, skipped: {}, duplicates: 0 }, 1234), "tail read: first 1234 byte(s) not read");

console.log("D. EMAIL SOURCE IDENTITY (AC-2.2, AC-2.3)");
const NOW = Date.parse("2026-11-12T00:00:00Z");
const v = validateEmailSnapshot(emailFixture, cfg, NOW);
t("fixture email snapshot validates (existing envelope, AC-7.1)", [v.ok, v.ok ? v.snapshot.records.length : -1, v.ok ? v.snapshot.skipped : -1], [true, 3, 1]);
const recs = v.ok ? v.snapshot.records : [];
const file = { path: cfg.email.path, itemId: "drive-item-1", etag: '"{etag-1},1"' };
const e1 = emailSourceItem(recs[0], mapFeedMessage(recs[0], cfg.mailbox), file, cfg.mailbox)!;
t("AC-2.2 identity is (email, mailbox:outlook id) -- the existing feed id minus 'feed:'", [e1.source, e1.sourceItemId, e1.identityBasis], ["email", "owner@work.example:AAMk-sample-1", "provider_id"]);
t("AC-2.2 internetMessageId stored when present", e1.internetMessageId, "<sample-1@partner.example>");
t("AC-2.2 thread id is the conversationId", e1.threadId, "conv-sample-1");
const noId = { ...recs[0], id: "" };
t("AC-2.2 snapshot record with no id -> no identity (never subject/time)", emailSourceItem(noId, mapFeedMessage(noId, cfg.mailbox), file, cfg.mailbox), null);
const perFile = emailSourceItem(noId, mapFeedMessage(noId, cfg.mailbox), { ...file, perRecordFile: true }, cfg.mailbox)!;
t("AC-2.3 per-file archive without provider id -> drive item + eTag basis recorded", [perFile.identityBasis, perFile.sourceItemId], ["drive_item_etag", "owner@work.example:drive:drive-item-1"]);
t("AC-2.3 drive-item identity: a new eTag is a CHANGE of the same item", (() => {
  const b = emailSourceItem(noId, mapFeedMessage(noId, cfg.mailbox), { ...file, etag: '"{etag-1},2"', perRecordFile: true }, cfg.mailbox)!;
  return [b.sourceItemId === perFile.sourceItemId, b.contentHash === perFile.contentHash];
})(), [true, false]);
t("AC-2.2 snapshot eTag does not affect a provider-id item's hash", emailSourceItem(recs[0], mapFeedMessage(recs[0], cfg.mailbox), { ...file, etag: "other" }, cfg.mailbox)!.contentHash, e1.contentHash);

console.log("D2. SENT ITEMS SNAPSHOT (owner decision 2, option A)");
const sentFixture = JSON.parse(readFileSync(join(FIX, "sent.sample.json"), "utf8"));
const sv = validateSentSnapshot(sentFixture, cfg, NOW);
t("sent.json validates with the email envelope rules + feed_type sent_snapshot", [sv.ok, sv.ok ? sv.snapshot.records.length : -1], [true, 4]);
t("the inbox validator refuses a sent snapshot (feed_type differs)", validateEmailSnapshot(sentFixture, cfg, NOW).ok ? "ok" : (validateEmailSnapshot(sentFixture, cfg, NOW) as { reason: string }).reason, "wrong_feed_type");
t("the sent validator refuses an inbox snapshot", (validateSentSnapshot(emailFixture, cfg, NOW) as { reason?: string }).reason, "wrong_feed_type");
t("sent snapshot: synthetic rule applies (unmarked file refused while synthetic)", (validateSentSnapshot({ ...sentFixture, synthetic: undefined }, cfg, NOW) as { reason?: string }).reason, "synthetic_mismatch");
const ms = mapSentRecords(sv.ok ? sv.snapshot.records : [], cfg);
t("mapSentRecords: conversationId required, prefix filter while synthetic, receivedDateTime fallback", [ms.sent.map((s) => s.conversationId), ms.skipped], [["conv-sample-1", "conv-sample-2"], 2]);
t("mapSentRecords: receivedDateTime accepted when sentDateTime is absent (live config)", mapSentRecords([{ id: "x", conversationId: "c", receivedDateTime: "2026-11-10T17:00:00Z", subject: "no prefix" }], parseFeedsConfig(JSON.stringify({ ...baseJson, synthetic: false }))!).sent, [{ conversationId: "c", sentAt: "2026-11-10T17:00:00.000Z" }]);
t("latestSentByConversation keeps the newest per thread", [...latestSentByConversation([{ conversationId: "c", sentAt: "2026-11-10T10:00:00Z" }, { conversationId: "c", sentAt: "2026-11-10T12:00:00Z" }]).entries()], [["c", Date.parse("2026-11-10T12:00:00Z")]]);

console.log("E. PURE HELPERS");
t("stableHash deterministic, separator-safe", [stableHash(["a", "b"]) === stableHash(["a", "b"]), stableHash(["ab", ""]) === stableHash(["a", "b"])], [true, false]);
t("AC-3.8 errorCategory keeps codes, drops free text", [errorCategory(new Error("graph_429")), errorCategory(new Error("Can you send the deck? owner@x.example")), errorCategory("Bearer abc.def")], ["graph_429", "processor_error", "processor_error"]);
t("combineOutcomes: needs_context wins; result ids merge", [
  combineOutcomes([{ status: "processed", resultIds: { bell: ["b1"] } }, { status: "needs_context", missingField: "sent_items" }]).status,
  combineOutcomes([{ status: "processed", resultIds: { bell: ["b1"] } }, { status: "processed", resultIds: { proposals: ["p1"] } }]),
], ["needs_context", { status: "processed", resultIds: { bell: ["b1"], proposals: ["p1"] } }]);

console.log("F. THE PASS against the dummy fixtures, in-memory ledger twin (AC-6.1, 6.3, 7.1, 2.x, 3.x)");
// The twin mirrors ledger.server.ts; scripts/correspondence-ledger-sql.test.ts proves the real SQL.
type Row = { owner: string; hash: string; status: LedgerStatus; attempts: number; v: number; missing: string | null; cat: string | null; result: Record<string, string[]>; writes: number; source: CorrespondenceSource; id: string; leased?: boolean; notBefore?: number };
const makeTwin = () => {
  const rows = new Map<string, Row>();
  const cursors = new Map<string, SourceCursor>();
  const calls: string[] = [];
  let clock = Date.parse("2026-11-12T23:05:00Z");
  const ledger: LedgerStore = {
    async observe(owner, items) {
      calls.push("observe");
      const out = { inserted: 0, changed: 0, unchanged: 0 };
      for (const i of items) {
        const k = ledgerKey(i);
        const r = rows.get(k);
        if (!r) {
          rows.set(k, { owner, hash: i.contentHash, status: "pending", attempts: 0, v: 0, missing: null, cat: null, result: {}, writes: 1, source: i.source, id: i.sourceItemId });
          out.inserted++;
        } else if (r.hash !== i.contentHash) {
          Object.assign(r, { hash: i.contentHash, status: "pending", attempts: 0, v: r.v + 1, missing: null, writes: r.writes + 1, leased: false, notBefore: 0 });
          out.changed++;
        } else out.unchanged++;
      }
      return out;
    },
    async reopenNeedsContext(owner, source) {
      let n = 0;
      for (const r of rows.values()) if (r.owner === owner && r.source === source && r.status === "needs_context") Object.assign(r, { status: "pending", missing: null, attempts: 0, v: r.v + 1 }), n++;
      return n;
    },
    async hasDue(owner, sources, max) {
      return [...rows.values()].some((r) => r.owner === owner && sources.includes(r.source) && (r.status === "pending" || r.status === "failed_retryable") && r.attempts < max && !r.leased && (r.notBefore ?? 0) <= clock);
    },
    async claimDue(owner, sources, limit, max) {
      calls.push("claim");
      const out: ClaimedItem[] = [];
      for (const r of rows.values()) {
        if (out.length >= limit) break;
        if (r.owner !== owner || !sources.includes(r.source) || !(r.status === "pending" || r.status === "failed_retryable") || r.attempts >= max) continue;
        if (r.leased || (r.notBefore ?? 0) > clock) continue; // lease / retry backoff, as the SQL does
        r.attempts++;
        r.v++;
        r.leased = true;
        out.push({ source: r.source, sourceItemId: r.id, claimVersion: r.v, attempts: r.attempts });
      }
      return out;
    },
    async markProcessed(c, ids) {
      const r = rows.get(ledgerKey(c))!;
      if (r.v !== c.claimVersion) return false;
      Object.assign(r, { status: "processed", result: ids, writes: r.writes + 1, leased: false });
      return true;
    },
    async markNeedsContext(c, f) {
      const r = rows.get(ledgerKey(c))!;
      if (r.v !== c.claimVersion) return false;
      Object.assign(r, { status: "needs_context", missing: f, leased: false });
      return true;
    },
    async markFailed(c, cat, max) {
      const r = rows.get(ledgerKey(c))!;
      if (r.v !== c.claimVersion) return false;
      Object.assign(r, { status: r.attempts >= max ? "failed" : "failed_retryable", cat, leased: false, notBefore: clock + 5 * 60_000 });
      return true;
    },
    async health() {
      return {};
    },
  };
  const cursor: CursorStore = {
    async get(o, s) {
      return cursors.get(`${o}|${s}`) ?? null;
    },
    async set(o, s, etag) {
      const prev = cursors.get(`${o}|${s}`);
      cursors.set(`${o}|${s}`, { etag: etag ?? prev?.etag ?? null, checkedAtMs: clock });
    },
  };
  return { rows, cursors, calls, ledger, cursor, tick: (ms: number) => (clock += ms), now: () => clock };
};
const logs: string[] = [];
const files = { teamsText: teamsFixture, teamsEtag: '"{t},1"', emailEtag: '"{e},1"', email: emailFixture };
const reads = { teams: 0, email: 0 };
const deps = (tw: ReturnType<typeof makeTwin>, processors: ItemProcessor[] = []): PassDeps => ({
  ledger: tw.ledger,
  cursor: tw.cursor,
  async readTeams(_c, known) {
    reads.teams++;
    if (known && known === files.teamsEtag) return { ok: true, changed: false, etag: known };
    return { ok: true, changed: true, etag: files.teamsEtag, itemId: "drive-item-t", path: "/automation/email/huddle-source-log.jsonl", text: files.teamsText };
  },
  async recordTeamsStatus() {},
  async readEmail(c) {
    reads.email++;
    const vv = validateEmailSnapshot(files.email, c, Date.parse("2026-11-12T00:00:00Z"));
    return vv.ok ? { ok: true, etag: files.emailEtag, path: c.email.path, records: vv.snapshot.records } : { ok: false, reason: `rejected:${vv.reason}` };
  },
  processors,
  now: tw.now,
  log: (l) => logs.push(l),
});
const onCfg = (over: Record<string, unknown> = {}) => parseFeedsConfig(JSON.stringify({ ...withTeams, correspondence: { ingest: true, ...over } }))!;

// AC-6.1 OFF => zero calls
{
  const tw = makeTwin();
  reads.teams = reads.email = 0;
  const offs = [null, noTeams, cfg, parseFeedsConfig(JSON.stringify({ ...withTeams, correspondence: { ingest: false, bell: true } }))!];
  const rs = [];
  for (const c of offs) rs.push((await runIngestPass(c, deps(tw))).reason);
  t("AC-6.1 absent config / ingest off -> the pass makes ZERO reads and ZERO ledger calls", [rs, reads.teams + reads.email, tw.calls.length, tw.rows.size], [
    ["not_configured", "ingest_off", "ingest_off", "ingest_off"],
    0,
    0,
    0,
  ]);
  const teamsOff = parseFeedsConfig(JSON.stringify({ ...baseJson, correspondence: { ingest: true, sources: ["teams"] } }))!;
  t("AC-6.1 ingest on but the teams entry absent -> no Teams read at all", [(await runIngestPass(teamsOff, deps(tw))).reason, reads.teams], ["no_source_enabled", 0]);
}

// AC-7.1 full pass over the fixtures; no processor switched on -> items recorded pending, nothing claimed
const tw1 = makeTwin();
reads.teams = reads.email = 0;
const r1 = await runIngestPass(onCfg(), deps(tw1));
t("AC-7.1 fixtures: 5 Teams messages + 2 emails recorded (dup/malformed/wrong-source/no-id/unprefixed skipped)", [r1.sources.teams?.new, r1.sources.email?.new, tw1.rows.size], [5, 2, 7]);
t("AC-7.1 skip counts reported per source", [r1.sources.teams?.skipped, r1.sources.email?.skipped], [4, 1]);
t("AC-6.3 no processor switched on -> nothing claimed, every row stays pending", [tw1.calls.includes("claim"), [...tw1.rows.values()].every((r) => r.status === "pending")], [false, true]);
t("AC-2.2 email rows keyed (email, mailbox:outlook id)", [...tw1.rows.values()].filter((r) => r.source === "email").map((r) => r.id).sort(), ["owner@work.example:AAMk-sample-1", "owner@work.example:AAMk-sample-2"]);
t("AC-1.7 Teams rows keyed (encoded chat id : message id)", [...tw1.rows.values()].some((r) => r.id === teamsSourceItemId("19:chat-alpha@thread.example", "1001")), true);

// AC-3.5 / AC-1.6: an immediate second pass is throttled; after the throttle an unchanged file is not re-read
const r2 = await runIngestPass(onCfg(), deps(tw1));
t("read throttle: a pass inside minIntervalMinutes reads nothing", [r2.sources.teams?.status, r2.sources.email?.status, reads.teams, reads.email], ["throttled", "throttled", 1, 1]);
tw1.tick(11 * 60_000);
const writesBefore = [...tw1.rows.values()].reduce((n, r) => n + r.writes, 0);
const r3 = await runIngestPass(onCfg(), deps(tw1));
t("AC-3.5 unchanged eTag -> Teams short-circuits (no download), email not re-observed, zero row writes", [r3.sources.teams?.status, r3.sources.email?.status, [...tw1.rows.values()].reduce((n, r) => n + r.writes, 0) - writesBefore], ["unchanged", "unchanged", 0]);

// AC-1.6 a re-capture with new capturedUtc, same messages -> new file eTag but zero new/changed rows
tw1.tick(11 * 60_000);
files.teamsText = teamsFixture.replaceAll("2026-11-11T23:00:00Z", "2026-11-12T23:00:00Z");
files.teamsEtag = '"{t},2"';
const r4 = await runIngestPass(onCfg(), deps(tw1));
t("AC-1.6 re-capture (new capture time) -> 0 new, 0 changed, rows unchanged", [r4.sources.teams?.new, r4.sources.teams?.changed, r4.sources.teams?.unchanged, tw1.rows.size], [0, 0, 5, 7]);

// AC-3.4 an edit in a later file -> SAME row, changed
tw1.tick(11 * 60_000);
files.teamsText += `\n${JSON.stringify({ source: "teams", synthetic: true, chatId: "19:chat-bravo@thread.example", messages: [{ id: "2001", timestamp: "2026-11-11T09:00:00Z", body: "HUDDLE-PA-SBX- FYI the nightly build is RED.", sender: { id: "user-other-2" } }] })}`;
files.teamsEtag = '"{t},3"';
const r5 = await runIngestPass(onCfg(), deps(tw1));
t("AC-3.4 edited Teams message -> 1 changed, still 7 rows", [r5.sources.teams?.changed, tw1.rows.size], [1, 7]);

// AC-2.4 the ledger, not the 12h/72h lookback, decides new: a message days older than the pass is ingested
t("AC-2.4 an email 3+ days older than 'now' is still recorded (no lookback window)", ledgerEmailItems((validateEmailSnapshot(emailFixture, cfg, NOW) as { snapshot: { records: Record<string, unknown>[] } }).snapshot.records, cfg, { path: "/p", etag: null }).items.length, 2);

// AC-2.5 a message that rolled out of today's snapshot keeps its row untouched
tw1.tick(11 * 60_000);
files.email = { ...emailFixture, snapshot: { value: emailFixture.snapshot.value.filter((r: { id: string }) => r.id !== "AAMk-sample-1") } };
files.emailEtag = '"{e},2"';
const rolled = tw1.rows.get(`email\u0000owner@work.example:AAMk-sample-1`)!;
const rolledBefore = JSON.stringify(rolled);
await runIngestPass(onCfg(), deps(tw1));
t("AC-2.5 absence from a bounded snapshot changes nothing on that row", JSON.stringify(rolled), rolledBefore);

console.log("G. PROCESSOR SEAM (AC-3.3, 3.6, 3.7, 3.8, 3.10, 6.3)");
const spyProc = (name: "bell" | "proposals", fn: (i: SourceItem) => ProcessOutcome | Promise<ProcessOutcome>): ItemProcessor & { seen: string[] } => {
  const seen: string[] = [];
  return { name, seen, process: async (i) => (seen.push(i.sourceItemId), fn(i)) };
};
{
  files.teamsText = teamsFixture;
  files.teamsEtag = '"{t},1"';
  files.email = emailFixture;
  files.emailEtag = '"{e},1"';
  const tw = makeTwin();
  const bell = spyProc("bell", () => ({ status: "processed", resultIds: { bell: ["b"] } }));
  const props = spyProc("proposals", () => ({ status: "processed", resultIds: { proposals: ["p"] } }));
  await runIngestPass(onCfg({ bell: true }), deps(tw, [bell, props]));
  t("AC-6.3 bell only: only the bell processor runs, every item processed", [bell.seen.length, props.seen.length, [...tw.rows.values()].every((r) => r.status === "processed")], [7, 0, true]);
  t("AC-3.2 result ids stored on the row", tw.rows.get(`email\u0000owner@work.example:AAMk-sample-1`)!.result, { bell: ["b"] });
}
{
  const tw = makeTwin();
  const boom = spyProc("proposals", (i) => {
    if (i.source === "teams") throw new Error("Can you send me the Q3 deck by Friday? CANARY-7f3a Bearer abc");
    return { status: "processed" };
  });
  logs.length = 0;
  const r = await runIngestPass(onCfg({ proposals: true, maxAttempts: 2 }), deps(tw, [boom]));
  const teamsRows = [...tw.rows.values()].filter((x) => x.source === "teams");
  t("AC-3.3 a failing processor write -> failed_retryable, never processed", [r.failed, teamsRows.every((x) => x.status === "failed_retryable")], [5, true]);
  t("AC-3.8 the error is stored as a category, never its text", teamsRows.every((x) => x.cat === "processor_error"), true);
  t("AC-3.8 pass log: no canary, chat name, id, sender, subject or Bearer", logs.filter((l) => /CANARY|Bearer|chat-|1001|Pat|HUDDLE|AAMk|@/.test(l)), []);
  t("AC-3.8 pass log carries counts", logs.some((l) => /teams=ok new=5/.test(l) && /failed=5/.test(l)), true);
  tw.tick(11 * 60_000);
  await runIngestPass(onCfg({ proposals: true, maxAttempts: 2 }), deps(tw, [boom]));
  t("AC-3.6 after maxAttempts the item is terminal failed", teamsRows.every((x) => x.status === "failed" && x.attempts === 2), true);
  tw.tick(11 * 60_000);
  const seenBefore = boom.seen.length;
  await runIngestPass(onCfg({ proposals: true, maxAttempts: 2 }), deps(tw, [boom]));
  t("AC-3.6 a terminal item is never retried", boom.seen.length, seenBefore);
}
{
  const tw = makeTwin();
  const nc = spyProc("bell", (i) => (i.source === "teams" ? { status: "needs_context", missingField: "owner_teams_id" } : { status: "processed" }));
  await runIngestPass(onCfg({ bell: true }), deps(tw, [nc]));
  t("AC-3.7 undecidable item -> needs_context with the missing field", [...tw.rows.values()].filter((x) => x.source === "teams").map((x) => `${x.status}:${x.missing}`)[0], "needs_context:owner_teams_id");
  tw.tick(11 * 60_000);
  files.teamsEtag = '"{t},9"';
  const r = await runIngestPass(onCfg({ bell: true }), deps(tw, [nc]));
  t("AC-3.7 a newly published file reopens needs_context rows for re-evaluation", [r.sources.teams?.reopened, nc.seen.filter((s) => s.includes("1001")).length], [5, 2]);
  files.teamsEtag = '"{t},1"';
}
{
  // An item already in the ledger whose text is no longer in the file (rolled out) -> needs_context, not failed
  const tw = makeTwin();
  await runIngestPass(onCfg(), deps(tw)); // ingest only
  tw.tick(11 * 60_000);
  files.email = { ...emailFixture, snapshot: { value: emailFixture.snapshot.value.filter((r: { id: string }) => r.id !== "AAMk-sample-1") } };
  files.emailEtag = '"{e},7"';
  const p2 = spyProc("bell", () => ({ status: "processed" }));
  await runIngestPass(onCfg({ bell: true }), deps(tw, [p2]));
  const row1 = tw.rows.get(`email\u0000owner@work.example:AAMk-sample-1`)!;
  t("AC-2.5 a due item absent from the current file -> needs_context 'source_payload' (not failed, not resolved)", [row1.status, row1.missing], ["needs_context", "source_payload"]);
  files.email = emailFixture;
  files.emailEtag = '"{e},1"';
}
{
  // AC-3.10 budget: a slow processor makes the pass yield; the rest resume next tick from the ledger
  const tw = makeTwin();
  const slow = spyProc("bell", () => {
    tw.tick(4_000);
    return { status: "processed" };
  });
  const r = await runIngestPass(onCfg({ bell: true }), deps(tw, [slow]), { budgetMs: 10_000, batch: 2 });
  const done = [...tw.rows.values()].filter((x) => x.status === "processed").length;
  tw.tick(11 * 60_000);
  await runIngestPass(onCfg({ bell: true }), deps(tw, [slow]), { budgetMs: 60_000, batch: 2 });
  t("AC-3.10 over budget -> yields, then the next tick finishes from the ledger", [r.yielded, done < 7, [...tw.rows.values()].every((x) => x.status === "processed")], [true, true, true]);
}
{
  // AC-3.9 (twin level; the real CAS is in the SQL test): two overlapping passes process each item once
  const tw = makeTwin();
  const once = spyProc("bell", () => ({ status: "processed" }));
  await Promise.all([runIngestPass(onCfg({ bell: true }), deps(tw, [once])), runIngestPass(onCfg({ bell: true }), deps(tw, [once]))]);
  t("AC-3.9 two overlapping passes: each item processed once", [once.seen.length, new Set(once.seen).size], [7, 7]);
}

console.log("I. SERVER READ — Graph spy (AC-1.2, 1.8, 1.13)");
{
  process.env.AZURE_TENANT_ID = "tenant-placeholder";
  process.env.AZURE_CLIENT_ID = "client-placeholder";
  process.env.AZURE_CLIENT_SECRET = "secret-placeholder";
  const { readTeamsLogFile } = await import("../src/features/huddle/lib/external-feeds/onedrive-feed.server");
  const realFetch = globalThis.fetch;
  const realErr = console.error;
  const seen: { method: string; host: string; path: string; range: string | null }[] = [];
  let size = 100;
  let body = teamsFixture;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const range = new Headers(init?.headers).get("range");
    seen.push({ method: (init?.method ?? "GET").toUpperCase(), host: u.host, path: decodeURIComponent(u.pathname), range });
    if (range && u.pathname.endsWith(":/content")) return new Response(body.slice(body.length - Number(range.replace("bytes=-", ""))), { status: 206 });
    if (u.host.startsWith("login.")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    if (u.pathname.endsWith(":/content")) return new Response(body, { status: 200 });
    return new Response(JSON.stringify({ id: "drive-item-t", eTag: '"{t},5"', size }), { status: 200 });
  }) as typeof fetch;
  console.error = () => {}; // state writes fail without AZURE_PG_URL; they are caught by design
  try {
    const c = onCfg();
    const a = await readTeamsLogFile(c, null);
    t("AC-1.2 Teams log read: meta then content, text returned with eTag + drive item id", a.ok && a.changed ? [a.etag, a.itemId, a.text.length === teamsFixture.length] : a, ['"{t},5"', "drive-item-t", true]);
    const b = await readTeamsLogFile(c, '"{t},5"');
    t("AC-1.2 unchanged eTag -> no download", [b.ok && !b.changed, seen.filter((s) => s.path.endsWith(":/content")).length], [true, 1]);
    // AC-1.8 as amended by the PA contract doc ("Huddle reads the end of it"): an oversized rolling log is
    // read from its END with a Range request; the parse then drops the partial first line.
    const line = (i: number) => JSON.stringify({ source: "teams", synthetic: true, chatId: `c${i}`, messages: [{ id: "m", createdDateTime: "2026-11-11T10:00:00Z", body: "HUDDLE-PA-SBX- x", from: { user: { id: "u" } } }] });
    body = Array.from({ length: 40 }, (_, i) => line(i)).join("\n");
    const c2 = { ...c, maxBytes: 1000 };
    size = body.length;
    const big = await readTeamsLogFile(c2, null);
    t("AC-1.8 oversized log -> tail read (Range bytes=-maxBytes), never the whole file", big.ok && big.changed ? [big.text.length, (big.tailSkippedBytes ?? 0) > 0, seen.at(-1)!.range] : big, [1000, true, "bytes=-1000"]);
    const tailParse = big.ok && big.changed ? parseTeamsLog(big.text, c2, { dropFirstLine: true }) : null;
    t("AC-1.8 tail parse: partial first line dropped, only whole lines become items, last line kept", [tailParse?.rejected ?? "none", tailParse?.skippedLines, tailParse?.messages.at(-1)?.chatId], ["none", 0, "c39"]);
    size = 100; // the size header understated the file: the downloaded text is trimmed to its end too
    const big2 = await readTeamsLogFile(c2, null);
    t("AC-1.8 downloaded text over maxBytes -> trimmed to the tail", big2.ok && big2.changed ? [big2.text.length, (big2.tailSkippedBytes ?? 0) > 0] : big2, [1000, true]);
    body = teamsFixture;
    const { readFeed } = await import("../src/features/huddle/lib/external-feeds/onedrive-feed.server");
    size = c.maxBytes + 1;
    const em = await readFeed(c, "email");
    t("AC-6.4 the email snapshot keeps today's rule: over maxBytes -> rejected:too_large (no tail read)", em.ok ? "ok" : em.reason, "rejected:too_large");
    size = 100;
    const graph = seen.filter((s) => s.host === "graph.microsoft.com");
    t("AC-1.13 / AC-2.6 every Graph call is a GET (no write, rename, move or delete of any feed file)", [graph.length > 0, graph.every((s) => s.method === "GET")], [true, true]);
    t("AC-1.2 drive calls target only the configured Teams log and email snapshot paths", graph.every((s) => /\/drive\/root:\/automation\/email\/(huddle-source-log\.jsonl|emails\.json)/.test(s.path)), true);
    t("AC-6.1 teams disabled -> readTeamsLogFile makes no call", await (async () => {
      const n = seen.length;
      const r = await readTeamsLogFile(noTeams, null);
      return [r.ok ? "ok" : r.reason, seen.length - n];
    })(), ["disabled", 0]);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realErr;
  }
}

console.log("J. SECTION 4 — unanswered correspondence -> the EXISTING bell (AC-4.x)");
{
  const A = await import("../src/features/huddle/lib/attention/attention");
  const B = await import("../src/features/huddle/lib/correspondence/bell");
  const chatRow = (o: Record<string, unknown> = {}) => ({ id: "attn-chat-x", kind: "chat", huddle_id: "dm-iris-chase", subject: "HUDDLE-PA-SBX- Alpha chat", from_name: "Pat Example", from_address: null, received_at: "2026-11-10T14:00:00Z", ...o });
  t("AC-4.2 `chat` is a bell kind with a label", [A.ATTENTION_KINDS.includes("chat"), A.ATTENTION_KIND_LABEL.chat], [true, "Teams chats"]);
  t("AC-4.2 a chat row becomes a bell item (not silently null) that opens Iris's chat", (() => {
    const i = A.toAttentionItem(chatRow());
    return i ? [i.kind, i.huddleId, i.title, i.uncertain ?? false] : null;
  })(), ["chat", "dm-iris-chase", "HUDDLE-PA-SBX- Alpha chat", false]);
  t("AC-4.2 the bell component maps the chat kind to an icon", readFileSync(join(ROOT, "src/features/huddle/components/AttentionBell.tsx"), "utf8").includes("chat: MessageSquare"), true);
  const unc = A.toAttentionItem(chatRow({ needs_context: "owner_messages" }))!;
  t("AC-4.6 uncertain chat row says 'Can't tell if answered', never 'unanswered'", [unc.uncertain, /Can't tell if answered/.test(unc.detail!), /unanswered/i.test(unc.detail!)], [true, true, false]);
  t("owner decision: uncertain rows are listed but NOT counted in the badge", [A.badgeCount([A.toAttentionItem(chatRow())!, unc]), A.bellItems([chatRow(), chatRow({ id: "y", needs_context: "owner_teams_id" })], A.DEFAULT_URGENT_KINDS).length], [1, 2]);
  t("AC-4.11 deep link only when the record supplied an https link; none -> no link field", [A.toAttentionItem(chatRow({ source_link: "https://teams.example/l/m/1" }))!.link, "link" in A.toAttentionItem(chatRow())!, "link" in A.toAttentionItem(chatRow({ source_link: "javascript:alert(1)" }))!], ["https://teams.example/l/m/1", false, false]);
  t("AC-4.3 a setting saved BEFORE chat existed still counts chat", A.resolveStoredUrgentKinds(["email", "meeting", "appointment"]), ["email", "meeting", "appointment", "chat"]);
  t("AC-4.3 explicit empty list (everything off) still honoured", A.resolveStoredUrgentKinds([]), []);
  t("AC-4.3 an explicit opt-out survives: saving without chat stores '-chat' and reads back without it", [A.serializeUrgentKinds(["email"]), A.resolveStoredUrgentKinds(A.serializeUrgentKinds(["email"]))], [["email", "-chat"], ["email"]]);
  t("AC-4.3 unset setting -> default includes chat", A.resolveStoredUrgentKinds(null).includes("chat"), true);
  t("AC-4.1 chat row id cannot collide with an email row (16 hex) or meeting/appointment ids", (() => {
    const id = B.chatAttentionId("Owner@eds.example", "19:chat-alpha@thread.example");
    return [/^attn-chat-[0-9a-f]{16}$/.test(id), id === B.chatAttentionId("owner@eds.example", "19:chat-alpha@thread.example"), id === B.chatAttentionId("owner@eds.example", "19:chat-bravo@thread.example")];
  })(), [true, true, false]);

  const M = (o: Partial<TeamsMessage>): TeamsMessage => ({ chatId: "c1", messageId: "m", at: "2026-11-10T10:00:00Z", senderId: "u-other", senderName: "Pat", senderIsApp: false, fromOwner: false, text: "HUDDLE-PA-SBX- Can you send the deck?", ...o });
  t("AC-4.5 an ask followed by an owner message -> answered at the owner's time", B.decideChatThread([M({ messageId: "1" }), M({ messageId: "2", fromOwner: true, at: "2026-11-10T11:00:00Z", text: "HUDDLE-PA-SBX- sent" })], true), { state: "answered", ownerReplyAt: "2026-11-10T11:00:00Z" });
  t("AC-4.9 four questions in a row -> ONE open ask, the newest", (() => {
    const d = B.decideChatThread([1, 2, 3, 4].map((i) => M({ messageId: String(i), at: `2026-11-10T1${i}:00:00Z` })), true);
    return d.state === "open" ? [d.ask.messageId, d.missing] : d;
  })(), ["4", null]);
  t("AC-4.6 the log carries no owner message at all -> open but missing owner_messages (can't tell)", (() => {
    const d = B.decideChatThread([M({})], false);
    return d.state === "open" ? d.missing : d.state;
  })(), "owner_messages");
  t("AC-4.6 / OQ-4 owner ids not configured (fromOwner null) -> missing owner_teams_id", (() => {
    const d = B.decideChatThread([M({ fromOwner: null })], false);
    return d.state === "open" ? d.missing : d.state;
  })(), "owner_teams_id");
  t("AC-4.8 FYI (no ask), app sender, automated address -> nothing", [
    B.decideChatThread([M({ text: "HUDDLE-PA-SBX- FYI the nightly build is green." })], true).state,
    B.decideChatThread([M({ senderIsApp: true })], true).state,
    B.decideChatThread([M({ senderId: "noreply@svc.example" })], true).state,
  ], ["nothing", "nothing", "nothing"]);
  t("S-12 the owner's own question is never an item needing reply", B.decideChatThread([M({ fromOwner: true })], true).state, "answered");
  t("an ask AFTER the owner's last message re-opens the chat", B.decideChatThread([M({ messageId: "1", fromOwner: true }), M({ messageId: "2", at: "2026-11-10T12:00:00Z" })], true).state, "open");

  // The processor through the pass, fixtures + in-memory bell store.
  const bellRows = new Map<string, { status: string; needs: string | null; ask: string; at: string }>();
  const store = {
    upserts: 0,
    settles: 0,
    async upsert(r: { id: string; askSourceId: string; askAt: string; needsContext: string | null }) {
      this.upserts++;
      const cur = bellRows.get(r.id);
      if (cur && cur.status !== "owed" && !(Date.parse(r.askAt) > Date.parse(cur.at) && r.askSourceId !== cur.ask)) return false;
      bellRows.set(r.id, { status: "owed", needs: r.needsContext, ask: r.askSourceId, at: r.askAt });
      return true;
    },
    async settle(id: string, _o: string, at: string) {
      this.settles++;
      const cur = bellRows.get(id);
      if (!cur || cur.status !== "owed" || Date.parse(cur.at) > Date.parse(at)) return false;
      cur.status = "replied";
      return true;
    },
  };
  files.teamsText = teamsFixture;
  files.teamsEtag = '"{t},1"';
  files.email = emailFixture;
  files.emailEtag = '"{e},1"';
  const tw = makeTwin();
  await runIngestPass(onCfg({ bell: true }), deps(tw, [B.makeBellProcessor(store)]));
  const alpha = B.chatAttentionId("login@eds.example", "19:chat-alpha@thread.example");
  t("AC-4.5 fixture: the alpha chat (owner replied later) writes no open row", bellRows.get(alpha)?.status ?? "none", "none");
  // Red-team S2 (2026-11-12): owner presence is decided PER CHAT (AC-4.6 "for that chat"). The fixture's charlie
  // chat carries no owner message, so its ask is listed as can't-tell (owner_messages), not certain-owed.
  t("AC-7.1 fixture: exactly ONE open row -- the charlie chat's ask (its app message ignored); can't-tell per chat (S2)", [...bellRows.entries()].map(([k, v]) => [k === B.chatAttentionId("login@eds.example", "19:chat-charlie@thread.example"), v.status, v.needs, v.ask]), [[true, "owed", "owner_messages", "19:chat-charlie@thread.example:3001"]]);
  t("AC-4.5 fixture: the alpha chat's owner reply reached the store as a settle", store.settles >= 1, true);
  t("AC-4.8 fixture: the FYI chat writes no row", bellRows.has(B.chatAttentionId("login@eds.example", "19:chat-bravo@thread.example")), false);
  t("AC-2.7 email items: the bell processor announces nothing (the inbox watch already did)", [...bellRows.keys()].every((k) => k.startsWith("attn-chat-")), true);
  t("AC-3.2 / ledger: every fixture item processed or needs_context, none failed", [...tw.rows.values()].every((r) => r.status === "processed" || r.status === "needs_context"), true);

  // AC-4.13 two passes: an ask, then the owner's reply in a later file, settles with no action in Huddle
  bellRows.clear();
  const line1 = JSON.stringify({ source: "teams", synthetic: true, chatId: "19:chat-golf@thread.example", chatName: "HUDDLE-PA-SBX- Golf", messages: [{ id: "g1", createdDateTime: "2026-11-11T10:00:00Z", body: { contentType: "text", content: "HUDDLE-PA-SBX- Could you approve the PO today?" }, from: { user: { id: "user-other-7", displayName: "Gale" } }, webUrl: "https://teams.example/l/m/g1" }] });
  // Red-team S2: the owner's earlier message is in THE SAME chat (presence is per chat), before the ask.
  const ownerLine = JSON.stringify({ source: "teams", synthetic: true, chatId: "19:chat-golf@thread.example", messages: [{ id: "h1", createdDateTime: "2026-11-11T09:00:00Z", body: "HUDDLE-PA-SBX- morning all", from: { user: { id: "USER-OWNER-1" } } }] });
  const tw2 = makeTwin();
  files.teamsText = [line1, ownerLine].join("\n");
  files.teamsEtag = '"{g},1"';
  await runIngestPass(onCfg({ bell: true, sources: ["teams"] }), deps(tw2, [B.makeBellProcessor(store)]));
  const golf = B.chatAttentionId("login@eds.example", "19:chat-golf@thread.example");
  t("AC-4.13 pass 1: the ask is an open (owed, certain) row", [bellRows.get(golf)?.status, bellRows.get(golf)?.needs], ["owed", null]);
  tw2.tick(11 * 60_000);
  files.teamsText += `\n${JSON.stringify({ source: "teams", synthetic: true, chatId: "19:chat-golf@thread.example", messages: [{ id: "g2", createdDateTime: "2026-11-11T12:00:00Z", body: "HUDDLE-PA-SBX- approved", from: { user: { id: "USER-OWNER-1" } } }] })}`;
  files.teamsEtag = '"{g},2"';
  await runIngestPass(onCfg({ bell: true, sources: ["teams"] }), deps(tw2, [B.makeBellProcessor(store)]));
  t("AC-4.13 pass 2: the owner's later message settles it 'replied'", bellRows.get(golf)?.status, "replied");
  t("AC-4.6 with NO owner message anywhere in the log, the same ask is 'can't tell'", await (async () => {
    bellRows.clear();
    const tw3 = makeTwin();
    files.teamsText = line1;
    files.teamsEtag = '"{g},9"';
    await runIngestPass(onCfg({ bell: true, sources: ["teams"] }), deps(tw3, [B.makeBellProcessor(store)]));
    return [bellRows.get(golf)?.needs, [...tw3.rows.values()][0].status];
  })(), ["owner_messages", "needs_context"]);
  t("AC-6.3 bell OFF -> the bell processor never runs", await (async () => {
    const before = store.upserts + store.settles;
    const tw4 = makeTwin();
    await runIngestPass(onCfg({ proposals: false, sources: ["teams"] }), deps(tw4, [B.makeBellProcessor(store)]));
    return store.upserts + store.settles - before;
  })(), 0);
  t("AC-4.12 the bell module never sends (no send/draft/POST call sites)", /sendMail|createDraft|send_email|method:\s*"POST"/.test(readFileSync(join(ROOT, "src/features/huddle/lib/correspondence/bell.ts"), "utf8")), false);

  // Owner decision 2 (option A): a work email settles when a LATER sent message is in its conversation
  const S = new Map([["conv-1", Date.parse("2026-11-10T15:00:00Z")]]);
  t("sent settle: a later sent message in the same conversation settles the owed work email", sentReplySettles({ conversation_id: "conv-1", received_at: "2026-11-10T11:00:00Z" }, S), true);
  t("sent settle: a sent message EARLIER than the email does not", sentReplySettles({ conversation_id: "conv-1", received_at: "2026-11-10T16:00:00Z" }, S), false);
  t("sent settle: equal time is not later -> not settled", sentReplySettles({ conversation_id: "conv-1", received_at: "2026-11-10T15:00:00Z" }, S), false);
  t("sent settle: other conversation / no conversation id / no receipt time -> unchanged", [sentReplySettles({ conversation_id: "conv-2", received_at: "2026-11-10T11:00:00Z" }, S), sentReplySettles({ conversation_id: null, received_at: "2026-11-10T11:00:00Z" }, S), sentReplySettles({ conversation_id: "conv-1", received_at: null }, S)], [false, false, false]);
  t("sent settle: fixture end to end (conv-sample-1 replied later; conv-sample-2's sent mail is older)", (() => {
    const latest = latestSentByConversation(ms.sent);
    return [sentReplySettles({ conversation_id: "conv-sample-1", received_at: "2026-11-10T11:00:00Z" }, latest), sentReplySettles({ conversation_id: "conv-sample-2", received_at: "2026-11-10T12:00:00Z" }, latest)];
  })(), [true, false]);
}

console.log("H. PUBLIC-REPO HYGIENE (AC-8.1, AC-8.2)");
const NEW_FILES = [
  "scripts/fixtures/onedrive/huddle-source-log.sample.jsonl",
  "scripts/fixtures/onedrive/emails.sample.json",
  "scripts/fixtures/onedrive/sent.sample.json",
  "src/features/huddle/lib/external-feeds/teams-log.ts",
  "src/features/huddle/lib/correspondence/source-item.ts",
];
const extra = (() => {
  try {
    return readdirSync(join(ROOT, "src/features/huddle/lib/correspondence")).map((f) => `src/features/huddle/lib/correspondence/${f}`);
  } catch {
    return [];
  }
})();
const scanned = [...new Set([...NEW_FILES, ...extra])].filter((f) => {
  try {
    return statSync(join(ROOT, f)).isFile();
  } catch {
    return false;
  }
});
const domains = new Set<string>();
const guids: string[] = [];
for (const f of scanned) {
  const s = readFileSync(join(ROOT, f), "utf8");
  for (const m of s.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) domains.add(m[1].toLowerCase());
  for (const m of s.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) guids.push(m[0]);
}
t("AC-8.1 every address/@-domain in new files ends .example", [...domains].filter((d) => !d.endsWith(".example")), []);
t("AC-8.1 no GUID (tenant/drive/flow id) in new files", guids, []);
t("AC-8.1 scanned at least the fixtures + new modules", scanned.length >= 4, true);
const comps = (() => {
  const dir = join(ROOT, "src/features/huddle/components");
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p2 = join(d, f);
      if (statSync(p2).isDirectory()) walk(p2);
      else if (/\.(tsx?|jsx?)$/.test(f) && readFileSync(p2, "utf8").includes("huddle-source-log")) hits.push(f);
    }
  };
  walk(dir);
  return hits;
})();
t("AC-8.2 client components never name the Teams source path", comps, []);
t("AC-7.2 no src/ module references the fixture directory", (() => {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p2 = join(d, f);
      if (statSync(p2).isDirectory()) walk(p2);
      else if (/\.(tsx?|jsx?)$/.test(f) && readFileSync(p2, "utf8").includes("fixtures/onedrive")) hits.push(f);
    }
  };
  walk(join(ROOT, "src"));
  return hits;
})(), []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
