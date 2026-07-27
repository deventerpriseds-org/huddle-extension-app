// Regression guard for the meeting/ceremony CHANNEL ISOLATION invariant.
// Asserts: a stand-up runs in its dedicated `ceremony-standup` channel, the host (Terry) OPENS it,
// and NOTHING lands in an agent's 1:1 (`dm-terry-locke`) — the spill this test exists to prevent.
// Run against the deployed SWA. Refresh FN ids from the build if they 404 (content-hash mechanism).
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE = "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN_ENQ = "c79b918b188cb2ef56b73995a55d32df04f1e0076f8162ccfb23a363b2aac9b3";
const FN_POLL = "874177d69ad37451f9c3ae0ea56f444f2a7f6fc3a83ce4494ad5a9ec6036daad";
const plugins = defaultSerovalPlugins;
const CALLER = { entra_email: "von.ellis@enterpriseds.io" };
const M = ["terry-locke","iris-chase","finn-reid","faith-hartley","elle-rowan","flex-grimes","ezra-miles","sam-trent","cole-blake","charleston-lewis","eli-vaughn","liam-kingsley","cam-post","troy-lennox","tess-sutton"];
const agents = {}; for (const id of M) agents[id] = { backend:"openai", journey:{enabled:false}, rag:{store:"azure",chunks:false,triples:false,fileSearch:false,sharing:"shared"}, webSearch:false };
const router = { backend:"openai", model:"gpt-4o-mini", soloOnCoverage:true, interjections:false, ceremonyMode:"round-robin" };
const C = {1:undefined,2:null,3:NaN,4:Infinity,5:-Infinity,6:-0};
function dec(r){const g=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in C?C[n.s]:undefined;case 7:return g.get(n.i);case 9:{const a=[];if(n.i!=null)g.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)g.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(r);}
async function call(fn,p){const b=JSON.stringify(await toJSONAsync({data:p},{plugins}));const res=await fetch(`${BASE}/_serverFn/${fn}`,{method:"POST",headers:{"Content-Type":"application/json","x-tsr-serverFn":"true",accept:"application/json"},body:b});const t=await res.text();let n;try{n=JSON.parse(t);}catch{return{http:res.status};}return{http:res.status,val:dec(n)?.result};}
function countTurns(p){return (p.val?.turns??[]).length;}

const CEREMONY = "ceremony-standup";
const ONE_TO_ONE = "dm-terry-locke";
// Baseline: how many turns are already in Terry's 1:1 (we must add ZERO).
const dmBefore = countTurns(await call(FN_POLL,{huddleId:ONE_TO_ONE,sinceMs:0}));

const turnId = `ceremony-${CEREMONY}-standup-${Date.now()}`;
const enqP = call(FN_ENQ,{text:"let's run the daily stand-up",huddleId:CEREMONY,scope:"group",members:M,history:[],router,agents,timeZone:"America/New_York",caller:CALLER,turnId});
let seen=0,done=false,order=[],g=0;
while(!done && g++<60){await new Promise(r=>setTimeout(r,2500));const p=await call(FN_POLL,{huddleId:CEREMONY,sinceMs:0});const turn=(p.val?.turns??[]).find(t=>t.id===turnId);if(!turn)continue;const reps=turn.result?.replies??turn.replies??[];if(reps.length>seen){for(const r of reps.slice(seen))order.push(r.agentId);seen=reps.length;}if(turn.status==="done"||turn.status==="error")done=true;}
await enqP;

const dmAfter = countTurns(await call(FN_POLL,{huddleId:ONE_TO_ONE,sinceMs:0}));
const spilled = dmAfter - dmBefore;
console.log("ceremony channel:", CEREMONY);
console.log("replies in ceremony channel:", order.length, "→", order.join(" → "));
console.log("opener is Terry:", order[0]==="terry-locke" ? "PASS ✓" : `FAIL ✗ (${order[0]})`);
console.log(`dm-terry-locke turns before/after: ${dmBefore}/${dmAfter}  (spilled ${spilled})`);
console.log("no 1:1 spill:", spilled===0 ? "PASS ✓" : `FAIL ✗ (${spilled} turns leaked into the 1:1)`);
const ok = order.length>0 && order[0]==="terry-locke" && spilled===0;
console.log("\nISOLATION:", ok ? "PASS ✓✓" : "FAIL ✗");
process.exit(ok?0:1);
