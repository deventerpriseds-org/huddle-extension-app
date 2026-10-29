// WHAT:       One-off cleanup: deletes EXACTLY the 7 test tasks a live harness created on the owner's board
//             on 2026-10-28 (parked + tagged `test-artifact`), through the board's own Delete action
//             (deleteBoardTask → journey delete_task, scoped to the caller's user_id).
// WHY:        Owner said "delete them"; the Supabase-MCP DELETE confirmation timed out 4x. Run via
//             agent-serverfn-uat.yml (the sandbox cannot reach the SWA).
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- one-off; safe to remove after it has run
// EVIDENCE:   .claude/accuracy-log.md 2026-10-28; .claude/actions.md ACT:ownership-judge-delete
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const EMAIL = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
// sha256("src/features/huddle/lib/tasks/board.functions.ts--deleteBoardTask_createServerFn_handler")
const FN = "66f4b2718ebb4ab77165d21de3720d505e642fcf514647b7a23ae6baec001755";
const IDS = {
  "595bbae9-1c6b-4b7c-b86f-2d77428cdf74": "Work on DBA paper for 782",
  "2a9a7c82-79d9-4b27-b861-fc8006f41fd7": "Draft reflection speech",
  "cbc61c71-743f-4f80-8c6c-1594008eaba5": "Go to the gym",
  "4d2613fb-5144-4183-a9ef-c230399d4530": "Pick up supplements from the vitamin shop",
  "8337a3b6-82ba-4f04-9fca-ae127418bfe1": "Work on Sidecar app",
  "2a0abe5c-9e59-4034-bc52-7c2540ec35f9": "Work on Prompto app",
  "d70875cd-24ba-4030-a0c4-89339cd4f461": "Work on Diagram Builder app",
};
// Seroval constant indices (verified, CLAUDE.md): 0=null 1=undefined 2=true 3=false.
const CONST = [null, undefined, true, false, -0, Infinity, -Infinity, NaN];
function decode(root) {
  const reg = new Map();
  const walk = (n) => {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;
      case 2: return CONST[n.s];
      case 7: return reg.get(n.i);
      case 9: { const a = []; if (n.i != null) reg.set(n.i, a); for (const it of n.a ?? []) a.push(walk(it)); return a; }
      case 10: case 11: { const o = {}; if (n.i != null) reg.set(n.i, o); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) o[k[j]] = walk(v[j]); return o; }
      default: return n.s ?? null;
    }
  };
  return walk(root);
}
let failed = 0;
for (const [taskId, title] of Object.entries(IDS)) {
  const body = JSON.stringify(await toJSONAsync({ data: { caller: { entra_email: EMAIL }, taskId } }, { plugins: defaultSerovalPlugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let r; try { const d = decode(JSON.parse(txt)); r = d?.result ?? d; } catch { r = { raw: txt.slice(0, 200) }; }
  const ok = r && r.ok === true;
  if (!ok) failed++;
  console.log(`${ok ? "✓ deleted" : "✗ FAILED "}  ${title}  (${taskId})  http=${res.status} ${ok ? "" : JSON.stringify(r).slice(0, 200)}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nALL 7 DELETED");
process.exit(failed ? 1 : 0);
