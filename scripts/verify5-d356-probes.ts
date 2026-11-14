// WHAT:       Verifier loop 5: D3 (Teams non-text owner reply), D5 (nobody/no one negation), D6 (negating title),
//             plus Teams dedup (chatId, message.id) and unknown per-line keys. Synthetic data only.
// WHY:        Claims 7, 8, 9 and the real-file note. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-5.md
import { parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { parseTeamsLog } from "../src/features/huddle/lib/external-feeds/teams-log";
import { validateCandidates } from "../src/features/huddle/lib/proposals/proposals";
const P = (id: string, v: unknown) => console.log(`${id.padEnd(52)} ${JSON.stringify(v)}`);
const live = parseFeedsConfig(JSON.stringify({ enabled: true, ownerLogins: ["owner@huddle.example"], driveUser: "owner@work.example", mailbox: "owner@work.example", synthetic: false, teams: { ownerSenderIds: ["00000000-0000-0000-0000-00000000a0a0"] } }))!;
const tcfg = { synthetic: live.synthetic, subjectPrefix: live.subjectPrefix, notBeforeUtc: live.notBeforeUtc, teams: live.teams };
const OWNER = "00000000-0000-0000-0000-00000000a0a0";
const user = (id: string) => ({ user: { id, displayName: "x", userIdentityType: "aadUser" } });
const msg = (id: string, at: string, content: string, extra: Record<string, unknown> = {}) => ({ id, messageType: "message", createdDateTime: at, from: user(OWNER), body: { content, contentType: "html" }, attachments: [], ...extra });
const line = (msgs: unknown[], extra: Record<string, unknown> = {}, chat = "19:c1@thread.example") => JSON.stringify({ source: "teams", synthetic: false, chatId: chat, capturedAt: "2026-11-12T23:00:05Z", messages: msgs, ...extra });
for (const [id, content] of [
  ["customemoji only", `<p><customemoji id="a" alt="parrot"></customemoji></p>`],
  ["CUSTOMEMOJI upper", `<P><CUSTOMEMOJI ID="a"></CUSTOMEMOJI></P>`],
  ["emoji element", `<emoji id="like" alt="x"></emoji>`],
  ["animatedemoji", `<animatedemoji id="z"></animatedemoji>`],
  ["video only (left open)", `<video src="https://x.example/v.mp4"></video>`],
  ["whitespace code block (must stay empty)", `<pre><code>   </code></pre>`],
  ["span class=emoji, no element (over-match?)", `<span class="emoji"></span>`],
  ["attachment card, no body", ``],
] as [string, string][]) {
  const r = parseTeamsLog(line([msg("9", "2026-11-12T15:00:00Z", content)]), tcfg);
  P(`D3 ${id}`, { kept: r.messages.length, skipped: r.skipped });
}
const a = msg("m1", "2026-11-12T15:00:00Z", "<p>first copy</p>");
const b = msg("m1", "2026-11-12T15:00:00Z", "<p>edited copy</p>");
const c = msg("m1", "2026-11-12T15:00:00Z", "<p>other chat same id</p>");
const t = [line([a], { ownerUserId: OWNER, futureKey: { x: 1 } }), line([b], { ownerUserId: OWNER, zz: "y" }), line([c], { ownerUserId: OWNER }, "19:c2@thread.example")].join("\n");
const r = parseTeamsLog(t, tcfg);
P("DEDUP (c1,m1)x2 + (c2,m1), unknown keys", { n: r.messages.length, skipped: r.skipped, msgs: r.messages.map((m: any) => [m.chatId ?? m.threadId, m.text ?? m.bodyText ?? m.preview]) });
const ctx = { atIso: "2026-11-12T15:00:00Z", tz: "America/New_York" };
const run = (id: string, src: string, task: Record<string, unknown>) => {
  const v = validateCandidates({ tasks: [task] }, src, ctx);
  P(id, v.accepted[0] ? { ACCEPTED: v.accepted[0].title } : { rejected: v.rejected });
};
const C = (s: string, title = "Send the contract to the client") => ({ task: title, evidence: s });
run("D5 nobody should", "Nobody should send the contract to the client today.", C("send the contract to the client today"));
run("D5 no one should", "No one should send the contract to the client today.", C("send the contract to the client today"));
run("D5 no-one should", "No-one should send the contract to the client today.", C("send the contract to the client today"));
run("D5 NO ONE caps", "NO ONE is to send the contract to the client today.", C("send the contract to the client today"));
run("D5 no one, repeat, should", "No one, repeat, should send the contract to the client.", C("send the contract to the client"));
run("D5 nobody here may", "Nobody here may send the contract to the client yet.", C("send the contract to the client yet"));
run("D5 no one else should", "No one else should send the contract to the client.", C("send the contract to the client"));
run("D5 curly 'no‑one' (non-breaking hyphen)", "No‑one should send the contract to the client.", C("send the contract to the client"));
run("D5 pos 'nobody forget to'", "Nobody forget to send the contract to the client today.", C("send the contract to the client today"));
run("D5 pos 'no one objected, so send'", "No one objected, so send the contract to the client today.", C("send the contract to the client today"));
run("D6 'Do not send' from 'send the deck'", "Please send the deck to finance.", { task: "Do not send the deck to finance", evidence: "send the deck to finance" });
run("D6 'Don't send' title", "Please send the deck to finance.", { task: "Don't send the deck to finance", evidence: "send the deck to finance" });
run("D6 'Never send' title", "Please send the deck to finance.", { task: "Never send the deck to finance", evidence: "send the deck to finance" });
run("D6 'Send no deck' title", "Please send the deck to finance.", { task: "Send no deck to finance", evidence: "send the deck to finance" });
run("D6 'Cannot send' title", "Please send the deck to finance.", { task: "Cannot send the deck to finance", evidence: "send the deck to finance" });
run("D6 'Hold off on sending' title", "Please send the deck to finance.", { task: "Hold off on sending the deck to finance", evidence: "send the deck to finance" });
run("D6 'Stop sending' title", "Please send the deck to finance.", { task: "Stop sending the deck to finance", evidence: "send the deck to finance" });
run("D6 pos plain", "Please send the deck to finance.", { task: "Send the deck to finance", evidence: "send the deck to finance" });
