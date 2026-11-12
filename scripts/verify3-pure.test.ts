// WHAT:       Verify loop 3 probes of the pure rules in lib/fireflies/minutes.ts (C1 signature, C2 id, C5, C10).
// WHY:        Independent re-check; not part of the author's suite.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-fireflies-minutes-3.md
import { createHmac } from "node:crypto";
import * as m from "../src/features/huddle/lib/fireflies/minutes";

let fail = 0;
const t = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const S = "s3cret";
const body = '{"event":"meeting.transcribed","meeting_id":"ASxwZxCstx","timestamp":1}';
const hex = createHmac("sha256", S).update(body, "utf8").digest("hex");
t("C1 docs-format sha256=<hex> accepted", await m.verifyFirefliesSignature(body, "sha256=" + hex, S), true);
t("C1 upper-case hex accepted", await m.verifyFirefliesSignature(body, "sha256=" + hex.toUpperCase(), S), true);
t("C1 bare hex (V1 style) refused", await m.verifyFirefliesSignature(body, hex, S), false);
t("C1 tampered body refused", await m.verifyFirefliesSignature(body + " ", "sha256=" + hex, S), false);
t("C1 one-nibble-off sig refused", await m.verifyFirefliesSignature(body, "sha256=" + hex.slice(0, 63) + (hex[63] === "0" ? "1" : "0"), S), false);
t("C1 truncated sig refused", await m.verifyFirefliesSignature(body, "sha256=" + hex.slice(0, 62), S), false);
t("C1 empty secret refused", await m.verifyFirefliesSignature(body, "sha256=" + hex, ""), false);
t("C1 sha1= prefix refused", await m.verifyFirefliesSignature(body, "sha1=" + hex, S), false);
t("C1 null header refused", await m.verifyFirefliesSignature(body, null, S), false);
const uni = '{"event":"meeting.transcribed","meeting_id":"A1","title":"Café ☕"}';
t("C1 non-ASCII body (utf8) accepted", await m.verifyFirefliesSignature(uni, "sha256=" + createHmac("sha256", S).update(uni, "utf8").digest("hex"), S), true);

t("C2 docs ULID id accepted", m.safeMeetingId("01KTXMH9V8RPY1B4DTYKB27WYR"), "01KTXMH9V8RPY1B4DTYKB27WYR");
t("C2 path traversal rejected", m.safeMeetingId("../x"), null);
t("C2 dot rejected (not cleaned)", m.safeMeetingId("a.b"), null);
t("C2 121 chars rejected", m.safeMeetingId("a".repeat(121)), null);

t("C5 custom sections preferred", m.firefliesSummaryMarkdown({ summary: { overview: "o", extended_sections: [{ title: "T", content: "c" }] } }).ok && (m.firefliesSummaryMarkdown({ summary: { overview: "o", extended_sections: [{ title: "T", content: "c" }] } }) as { source: string }).source, "custom");
t("C5 empty-content sections -> standard", (m.firefliesSummaryMarkdown({ summary: { overview: "o", extended_sections: [{ title: "T", content: "  " }] } }) as { source: string }).source, "standard");
t("C5 no summary -> fail (no Luna)", m.firefliesSummaryMarkdown({ summary: null }).ok, false);

t("C10 subject title+date", m.minutesSubject("Weekly\nsync", "Nov 10, 2026"), "Meeting minutes: Weekly sync (Nov 10, 2026)");
t("C10 update subject", m.minutesSubject("X", "", true), "Updated meeting minutes: X");
const html = m.markdownToEmailHtml("## <script>alert(1)</script>\n- [x](javascript:alert(1)) **b** <img src=x onerror=y>");
t("C10 no raw tag survives", /<script|<img|<a /i.test(html), false);
t("C10 recipients typo rejected, not replaced", m.parseRecipients(["ok@x.io", "bad"], ["owner@x.io"]), null);
t("C10 null -> owner fallback", m.parseRecipients(null, ["Owner@X.io"]), ["owner@x.io"]);
t("C6 template sections all required", m.missingTemplateSections("## Agenda\n## Summary\n## Questions\n## Decisions\n"), ["Action Items"]);
if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log("\nall passed");
