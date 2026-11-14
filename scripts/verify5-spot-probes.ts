// WHAT:       Verifier loop 5 reduced-depth spot probes: 4.5/4.13 (an owner reply in a Teams chat answers it, incl. a
//             <customemoji>-only reply), 6.1 (ingest + staleness off -> the heartbeat hook returns null). Synthetic data.
// WHY:        Re-check of loop-4 CONFIRMED items. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-5.md
import { parseTeamsLog } from "../src/features/huddle/lib/external-feeds/teams-log";
import { decideChatThread } from "../src/features/huddle/lib/correspondence/bell";
const OWNER = "00000000-0000-0000-0000-00000000a0a0";
const OTHER = "00000000-0000-0000-0000-00000000b0b0";
const cfg = { synthetic: false, subjectPrefix: "", notBeforeUtc: null, teams: { source: "teams", ownerSenderIds: [OWNER] } } as any;
const m = (id: string, at: string, who: string, content: string) => ({ id, messageType: "message", createdDateTime: at, from: { user: { id: who, displayName: "x" } }, body: { content, contentType: "html" }, attachments: [] });
const line = (msgs: unknown[]) => JSON.stringify({ source: "teams", synthetic: false, chatId: "19:c@thread.example", capturedAt: "2026-11-12T23:00:05Z", messages: msgs });
const ask = m("1", "2026-11-12T14:00:00Z", OTHER, "<p>Can you send the deck by Friday?</p>");
for (const [id, reply] of [
  ["4.5 text reply", "<p>Sending now</p>"],
  ["4.13 customemoji-only reply", `<p><customemoji id="a" alt="ok"></customemoji></p>`],
  ["4.13 image-only reply", `<p><img src="https://x.example/a.png"></p>`],
  ["control: no owner reply", null],
] as [string, string | null][]) {
  const msgs = reply === null ? [ask] : [ask, m("2", "2026-11-12T15:00:00Z", OWNER, reply)];
  const r = parseTeamsLog(line(msgs), cfg);
  console.log(`${id.padEnd(32)} ${decideChatThread(r.messages, true).state}`);
}
delete process.env.HUDDLE_ONEDRIVE_FEEDS;
const { runCorrespondenceIngest } = await import("../src/features/huddle/lib/correspondence/ingest.server");
console.log("6.1 no config:", await runCorrespondenceIngest());
process.env.HUDDLE_ONEDRIVE_FEEDS = JSON.stringify({ enabled: true, ownerLogins: ["owner@huddle.example"], driveUser: "owner@work.example", mailbox: "owner@work.example", synthetic: false });
console.log("6.1 config, every correspondence flag absent:", await runCorrespondenceIngest());
