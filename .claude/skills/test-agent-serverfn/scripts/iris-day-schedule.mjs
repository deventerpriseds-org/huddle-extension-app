#!/usr/bin/env node
// WHAT:       Live check (PR #193): asks Iris in her 1:1 "what's on my schedule today?" against the deployed
//             app and fails if she calls a day with meetings empty, or never ran the schedule tool.
// WHY:        2026-11-10 07:06 ET she answered "no items scheduled for today" on a day with 8 meetings + a
//             class, because the schedule tool read tasks only (AC-5 in AC-schedule-meetings.md).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/AC-schedule-meetings.md AC-5; compare the printed reply with journey
//             public.external_calendar_events for the same local day.
// RUN IT:     agent-serverfn-uat.yml, script = this file. Builds once so the server-fn ids match the deployed
//             main (huddle.mjs resolves ids from ./.output). Journey tools are OFF, so nothing is written.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
if (!fs.existsSync(path.join(ROOT, ".output"))) {
  console.log("building to resolve server-fn ids...");
  const b = spawnSync("npx", ["vite", "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  if (b.status !== 0) {
    console.log("FAIL build failed; cannot resolve server-fn ids");
    process.exit(1);
  }
}
const asks = process.env.IRIS_ASKS ? JSON.parse(process.env.IRIS_ASKS) : ["What's on my schedule today?", "What do I have tomorrow?"];
let fail = 0;
for (const text of asks) {
  const r = spawnSync("node", [path.join(HERE, "huddle.mjs"), "send", "--scope", "1:1", "--agent", "iris-chase", "--text", text], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  console.log(out);
  const reply = (out.match(/^\s+iris-chase: (.*)$/m) || [])[1] || "";
  const tools = (out.match(/^toolUses: \[(.*?)\]/m) || [])[1] || "";
  const ranTool = /schedule_and_priorities|get_calendar_events/.test(tools);
  const saidEmpty = /\b(no items|nothing (is )?scheduled|clear day|free day|your day is (open|clear|free)|nothing on your (schedule|calendar))\b/i.test(reply);
  const saidMeeting = /\bmeeting|class|\d{1,2}(:\d{2})?\s?(AM|PM)\b/i.test(reply);
  console.log(`CHECK ask=${JSON.stringify(text)} ranScheduleTool=${ranTool} saidEmpty=${saidEmpty} namesTimesOrMeetings=${saidMeeting} http=${/HTTP \d/.test(out)}`);
  if (!reply) { console.log("FAIL no Iris reply"); fail++; continue; }
  if (!ranTool) { console.log("FAIL schedule tool did not run"); fail++; }
  if (saidEmpty) { console.log("FAIL reply calls the day empty"); fail++; }
  if (!saidMeeting) { console.log("FAIL reply names no time or meeting"); fail++; }
}
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
