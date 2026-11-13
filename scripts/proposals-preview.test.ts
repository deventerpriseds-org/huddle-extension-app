// WHAT:          Runs scripts/proposals-preview.ts end to end with Graph stubbed (scripts/fixtures/preview-fetch-stub.ts)
//                and checks what it PRINTS: a non-JSON feed file logs "<file>: not JSON" and never any of its content;
//                and what it DOES: one OneDrive file write, plus a sendMail only with PREVIEW_EMAIL=1.
// WHY:           Verifier loop 4 (8.3): an uncaught JSON.parse quoted ~10 characters of a feed file into the public
//                workflow log; the header also said "sends nothing" while the script writes a file and can email.
// SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/IMPL-task-proposals.md "Verifier loop-4 fix pass".
//
// Run: bun scripts/proposals-preview.test.ts      All data synthetic (.example).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const root = new URL("..", import.meta.url).pathname;
const feeds = { enabled: true, ownerLogins: ["owner@eds.example"], driveUser: "drive@eds.example", mailbox: "work@corp.example", synthetic: true, subjectPrefix: "[TEST]" };
const SECRET = "Secret merger with Example Corp closes Friday";
const run = (extra: Record<string, string>) => {
  const log = join(mkdtempSync(join(tmpdir(), "preview-")), "calls.log");
  const r = spawnSync("bun", ["--preload", join(root, "scripts/fixtures/preview-fetch-stub.ts"), join(root, "scripts/proposals-preview.ts")], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, TOKEN: "token.example", HUDDLE_ONEDRIVE_FEEDS: JSON.stringify(feeds), OPENAI_API_KEY: "", STUB_LOG: log, ...extra },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status, calls };
};

const bad = run({ STUB_EMAIL: SECRET, STUB_SENT: `${SECRET} (sent)`, STUB_TEAMS: `${SECRET} (teams)` });
t("PV-1 non-JSON email / sent files print 'not JSON' and NONE of their content", [
  /email: not JSON/.test(bad.out),
  /sent: not JSON/.test(bad.out),
  /Secret|merger|Example Corp|Unexpected token/i.test(bad.out),
], [true, true, false]);
t("PV-2 the run still completes (counts + file write), exit 0", [bad.status, bad.calls.filter((c) => c === "PUT preview-file").length], [0, 1]);
t("PV-3 without PREVIEW_EMAIL nothing is emailed", bad.calls.some((c) => c.includes("sendMail")), false);
const mailed = run({ STUB_EMAIL: SECRET, PREVIEW_EMAIL: "1" });
t("PV-4 with PREVIEW_EMAIL=1 the report is emailed once (the header now says so)", mailed.calls.filter((c) => c === "POST sendMail").length, 1);
const header = readFileSync(join(root, "scripts/proposals-preview.ts"), "utf8").split("\n").slice(0, 25).join("\n");
t("PV-5 the header states the OneDrive write and the PREVIEW_EMAIL email, and no longer says 'sends nothing'", [
  /WRITES one Markdown file to the owner's OWN OneDrive/.test(header),
  /PREVIEW_EMAIL=1, EMAILS the same report/.test(header),
  /sends nothing/i.test(header),
], [true, true, false]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
