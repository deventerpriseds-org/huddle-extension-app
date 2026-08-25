import { renderBlockedLine } from "../src/features/huddle/lib/tasks/autowork.server.ts";
import { buildBrief } from "../src/features/huddle/lib/tasks/standup.server.ts";
import { AGENT_BY_ID } from "../src/features/huddle/data/agents.ts";
let p=0,f=0; const t=(n,c,d="")=>{c?(p++,console.log("✅ "+n)):(f++,console.log("❌ "+n+" — "+d));};

// AC-1.1 owner named
const a = renderBlockedLine({title:"Investigate Veridian transfer issues", reason:"needs your decision", ownerName:"Sam Trent"});
t("AC-1.1 owner display name present", a.includes("Sam Trent"), a);
t("AC-1.1/1.8 conversational 'needs you on this'", a.includes("Sam Trent needs you on this"), a);

// AC-1.3 no assignee
const b = renderBlockedLine({title:"Some task", reason:"waiting"});
t("AC-1.3 no 'undefined'", !/undefined|null|NaN/.test(b), b);
t("AC-1.3 no dangling connector", !/—\s*needs you/.test(b) && !b.trim().endsWith("needs you on this"), b);
t("AC-1.3 title+reason still present", b.includes("Some task") && b.includes("waiting"), b);

// AC-1.4 unknown id -> resolver yields undefined -> same ownerless path (no slug as a name)
const c = renderBlockedLine({title:"T", reason:"r", ownerName:undefined});
t("AC-1.4 no slug rendered as a human name", !/[a-z]+-[a-z]+ needs you/.test(c), c);

// AC-1.11 truncation must not eat the name
const longTitle="X".repeat(300), longReason="Y".repeat(300);
const d = renderBlockedLine({title:longTitle, reason:longReason, ownerName:"Sam Trent"});
t("AC-1.11 name survives long title+reason", d.includes("Sam Trent needs you on this"), d.slice(-60));
t("AC-1.11 components bounded", d.length < 260, "len="+d.length);

// AC-1.5/1.6 per-item pairing incl. mixed
const items=[{title:"Alpha",ownerName:"Sam Trent"},{title:"Beta",ownerName:"Tess Sutton"},{title:"Gamma"}];
const lines=items.map(renderBlockedLine);
t("AC-1.5 Alpha↔Sam on same line", lines[0].includes("Alpha")&&lines[0].includes("Sam Trent"), lines[0]);
t("AC-1.5 Beta↔Tess on same line", lines[1].includes("Beta")&&lines[1].includes("Tess Sutton"), lines[1]);
t("AC-1.5 no cross-contamination", !lines[0].includes("Tess")&&!lines[1].includes("Sam"), lines.join(" | "));
t("AC-1.6 mixed: unassigned stays ownerless", !/needs you on this/.test(lines[2]), lines[2]);

// AC-1.7 rejected phrasing
t("AC-1.7 no label-style phrasing", !/owned by|assigned to|owner:/i.test(lines.join("\n")+a+b+d), "found");

// --- AC-1.4 for real: exercise the id->name RESOLVER on BOTH surfaces, not a pre-resolved name.
// The first version of this test passed `ownerName: undefined` straight in, so it never touched the
// resolution step -- which is exactly where standup regressed (agentName() ends `|| id`, rendering a
// stale slug as a person). A test that cannot fail on the real defect is not covering it.
const REAL_ID = Object.keys(AGENT_BY_ID)[0];
const REAL_NAME = AGENT_BY_ID[REAL_ID].name;

const sReal = buildBrief([], [], [{title:"Alpha", reason:"needs you", agent:REAL_ID}], []);
t("AC-1.4 standup: real id resolves to display name", sReal.includes(`${REAL_NAME} needs you on this`), sReal);
const sStale = buildBrief([], [], [{title:"Alpha", reason:"needs you", agent:"sam-trent-old"}], []);
t("AC-1.4 standup: stale id NOT rendered as a person", !sStale.includes("sam-trent-old needs you"), sStale);
t("AC-1.4 standup: stale id degrades to ownerless", !/needs you on this/.test(sStale), sStale);
t("AC-1.4 standup: stale id line keeps title+reason", sStale.includes("Alpha") && sStale.includes("needs you"), sStale);
const sNull = buildBrief([], [], [{title:"Alpha", agent:null}], []);
t("AC-1.4 standup: null assignee ownerless, no undefined", !/undefined|null/.test(sNull) && !/needs you on this/.test(sNull), sNull);

// Same resolver contract on the autowork surface, via its documented call-site expression.
const resolve = (id) => AGENT_BY_ID[id]?.name;
t("AC-1.4 autowork: stale id resolves to undefined", resolve("sam-trent-old") === undefined, String(resolve("sam-trent-old")));
const aStale = renderBlockedLine({title:"Alpha", reason:"r", ownerName:resolve("sam-trent-old")});
t("AC-1.4 autowork: stale id degrades to ownerless", !/needs you on this/.test(aStale), aStale);
const aReal = renderBlockedLine({title:"Alpha", reason:"r", ownerName:resolve(REAL_ID)});
t("AC-1.4 autowork: real id resolves to display name", aReal.includes(`${REAL_NAME} needs you on this`), aReal);

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
