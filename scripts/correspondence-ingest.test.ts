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
import { parseFeedsConfig, validateEmailSnapshot, mapFeedMessage } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { parseTeamsLog, teamsParseNote } from "../src/features/huddle/lib/external-feeds/teams-log";
import {
  combineOutcomes,
  emailSourceItem,
  errorCategory,
  stableHash,
  teamsSourceItem,
  teamsSourceItemId,
} from "../src/features/huddle/lib/correspondence/source-item";

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
const withTeams = { ...baseJson, teams: { path: "/automation/huddle-source-log.jsonl", ownerIds: ["USER-OWNER-1"] } };
const cfg = parseFeedsConfig(JSON.stringify(withTeams))!;

console.log("A. CONFIG — Teams entry + switches (AC-1.1, AC-6.1, AC-6.3)");
const noTeams = parseFeedsConfig(JSON.stringify(baseJson))!;
t("AC-1.1 teams entry parsed with the same path rule", [cfg.teams.enabled, cfg.teams.path, cfg.teams.source, cfg.teams.ownerIds], [
  true,
  "/automation/huddle-source-log.jsonl",
  "power-automate-teams",
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
  JSON.stringify({ source: "power-automate-teams", synthetic: true, chatId: "c1", capturedUtc: "2026-11-11T23:00:00Z", status: "pending", messages: msgs, ...over });
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
t("S-8 pretty-printed single object (no line parses) -> rejected not_jsonl", parse(JSON.stringify(JSON.parse(L()), null, 2)).rejected, "not_jsonl");
t("S-9 (provisional) blank lines ignored, not counted", (() => {
  const r = parse([L(), "", "   ", L({ chatId: "c2" })].join("\n"));
  return [r.messages.length, r.lines, r.skippedLines];
})(), [2, 2, 0]);
t("S-10 (provisional) CRLF line endings accepted", parse([L(), L({ chatId: "c2" })].join("\r\n")).messages.length, 2);
t("S-14 a URL-only body maps to [link] (its '?' is not a question)", parse(L({}, [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", body: { contentType: "html", content: "HUDDLE-PA-SBX- https://x.example/form?id=1" }, sender: "u1" }])).messages[0].text, "HUDDLE-PA-SBX- [link]");
t("S-16 (provisional) deleted message skipped", parse(L({}, [{ id: "m1", timestamp: "2026-11-11T10:00:00Z", deletedDateTime: "2026-11-11T11:00:00Z", body: "HUDDLE-PA-SBX- x" }])).skipped.deleted, 1);
t("Graph createdDateTime / value aliases accepted", parse(JSON.stringify({ source: "power-automate-teams", synthetic: true, chatId: "c9", value: [{ id: "g1", createdDateTime: "2026-11-11T10:00:00Z", body: { contentType: "text", content: "HUDDLE-PA-SBX- hi" }, from: { user: { id: "U1", displayName: "N" } } }] })).messages[0].senderId, "u1");
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

console.log("E. PURE HELPERS");
t("stableHash deterministic, separator-safe", [stableHash(["a", "b"]) === stableHash(["a", "b"]), stableHash(["ab", ""]) === stableHash(["a", "b"])], [true, false]);
t("AC-3.8 errorCategory keeps codes, drops free text", [errorCategory(new Error("graph_429")), errorCategory(new Error("Can you send the deck? owner@x.example")), errorCategory("Bearer abc.def")], ["graph_429", "processor_error", "processor_error"]);
t("combineOutcomes: needs_context wins; result ids merge", [
  combineOutcomes([{ status: "processed", resultIds: { bell: ["b1"] } }, { status: "needs_context", missingField: "sent_items" }]).status,
  combineOutcomes([{ status: "processed", resultIds: { bell: ["b1"] } }, { status: "processed", resultIds: { proposals: ["p1"] } }]),
], ["needs_context", { status: "processed", resultIds: { bell: ["b1"], proposals: ["p1"] } }]);

// ---- sections F/G (pass + ledger twin) are appended below ----

console.log("H. PUBLIC-REPO HYGIENE (AC-8.1, AC-8.2)");
const NEW_FILES = [
  "scripts/fixtures/onedrive/huddle-source-log.sample.jsonl",
  "scripts/fixtures/onedrive/emails.sample.json",
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
