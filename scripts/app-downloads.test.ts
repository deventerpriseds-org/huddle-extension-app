// Download tab: rows, link filter, version compare. Run: bun scripts/app-downloads.test.ts
import { shapeDownloads, isBlobLink, compareVersions, DOWNLOAD_APPS } from "../src/features/huddle/lib/downloads/app-downloads";
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) { fail++; console.log("  got", got, "want", want); }
};
const SIGNED = "https://acct.blob.core.windows.net/bridge-apks/x/huddle-v1.0.17.apk?sv=1&sig=abc";
const rows = shapeDownloads([{ appId: DOWNLOAD_APPS[0].appId, found: true, version: "1.0.17", downloadUrl: SIGNED }]);
eq("rows in tab order", rows.map((r) => r.key), ["huddle", "taskos"]);
eq("found row keeps version", [rows[0].found, rows[0].version], [true, "1.0.17"]);
eq("missing app is an empty row", [rows[1].found, rows[1].downloadUrl], [false, null]);
eq("unsigned link refused", isBlobLink("https://acct.blob.core.windows.net/a.apk"), false);
eq("look-alike host refused", isBlobLink("https://acct.blob.core.windows.net.evil.example/a?sig=1"), false);
eq("javascript: refused", shapeDownloads([{ appId: DOWNLOAD_APPS[1].appId, found: true, downloadUrl: "javascript:alert(1)" }])[1].found, false);
eq("garbage never throws", [null, "x", {}].map((b) => shapeDownloads(b).length), [2, 2, 2]);
eq("1.0.9 < 1.0.10", compareVersions("1.0.9", "1.0.10"), -1);
eq("equal", compareVersions("1.0.17", "1.0.17"), 0);
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
console.log("all passed");
