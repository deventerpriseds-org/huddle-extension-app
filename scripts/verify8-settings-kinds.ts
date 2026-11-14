// WHAT:       Verifier loop 8, claim 2: the "What counts" list without Teams chats, and what a save STORES, round-tripped
//             through the branch's and main's own parse functions (main copy read from origin/main via git show).
// WHY:        07f5f6d3 hides the checkbox but keeps `chat` in the data and defaults; confirm stored settings and the bell
//             are unaffected with every flag OFF (no chat or feed rows can exist then).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-8.md
// Run: bun scripts/verify8-settings-kinds.ts. All data synthetic.
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as B from "../src/features/huddle/lib/attention/attention";

const dir = mkdtempSync(join(tmpdir(), "v8main-"));
writeFileSync(join(dir, "attention.ts"), execSync("git show origin/main:src/features/huddle/lib/attention/attention.ts").toString());
const M = await import(join(dir, "attention.ts"));
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`); };

t("settings list = email, meeting, appointment (main's list)", eq([...B.SETTINGS_KINDS], [...M.ATTENTION_KINDS]), JSON.stringify(B.SETTINGS_KINDS));
const rows = [
  { id: "e1", kind: "email", subject: "Test-Budget", from_name: "Pat", from_address: null, received_at: "2026-11-13T10:00:00Z", huddle_id: "dm-iris-chase" },
  { id: "attn-meeting-1", kind: "meeting", subject: "Test-Sync", from_name: null, from_address: null, received_at: "2026-11-13T11:00:00Z", huddle_id: "dm-iris-chase" },
  { id: "attn-appointment-1", kind: "appointment", subject: "Test-Dentist", from_name: null, from_address: null, received_at: "2026-11-13T12:00:00Z", huddle_id: "dm-iris-chase" },
];
for (const stored of [null, ["email", "meeting", "appointment"], ["meeting"], [], ["email", "spam"]]) {
  const kb = B.resolveStoredUrgentKinds(stored), km = M.parseUrgentKinds(stored);
  const ib = B.bellItems(rows as never, kb), im = M.bellItems(rows as never, km);
  t(`stored ${JSON.stringify(stored)}: same bell items and badge as main (no chat/feed rows)`, eq(ib, im) && B.badgeCount(ib) === im.length,
    `branch kinds=${JSON.stringify(kb)} main kinds=${JSON.stringify(km)} items b/m=${ib.length}/${im.length}`);
}
// A save from the branch UI: the client list carries `chat` (it came back from the server), the owner unticks Meetings.
const clientKinds = B.resolveStoredUrgentKinds(["email", "meeting", "appointment"]).filter((k) => k !== "meeting");
const saved = B.serializeUrgentKinds(B.parseUrgentKinds(clientKinds));
console.log(`     saved after unticking Meetings on the branch: ${JSON.stringify(saved)}`);
t("main reading a branch-saved setting sees the same three-kind choice (rollback safe)", eq(M.parseUrgentKinds(saved), ["email", "appointment"]), JSON.stringify(M.parseUrgentKinds(saved)));
t("branch reading it back keeps chat (no UI to untick it while hidden)", B.resolveStoredUrgentKinds(saved).includes("chat"));
console.log(fail ? `${fail} FAILED` : "all passed");
