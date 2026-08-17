// Verify deterministic lane->exact-owner fan-out (main c82ae29). Key: elle-rowan + ezra-miles must respond.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = process.env.HUDDLE_FN || "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const CALLER = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
const plugins = defaultSerovalPlugins;

const ALL = ["cam-post","charleston-lewis","cole-blake","eli-vaughn","elle-rowan","ezra-miles","faith-hartley","finn-reid","flex-grimes","iris-chase","liam-kingsley","sam-trent","terry-locke","tess-sutton","troy-lennox"];
const EXPECT = ["cole-blake","elle-rowan","finn-reid","ezra-miles"];

const agents = {};
for (const id of ALL) agents[id] = { backend:"openai", rag:{store:"azure",chunks:false,triples:false,fileSearch:false,sharing:"shared"}, journey:{enabled:false}, webSearch:false };
const router = { backend:"openai", model:"gpt-4o-mini", fastMode:false, strictPrompt:false, soloOnCoverage:true, interjections:true, maxInterjectors:6 };

const CONST = { 1:undefined,2:null,3:NaN,4:Infinity,5:-Infinity,6:-0 };
function decodeSeroval(root){const reg=new Map();function walk(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(walk(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=walk(v[j]);return o;}default:return n.s??null;}}return walk(root);}

async function send(text){
  const payload = { text, huddleId:"all-members", scope:"group", members:ALL, history:[], router, agents, timeZone:"America/New_York", caller:{entra_email:CALLER} };
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${FN}`, { method:"POST", headers:{ "Content-Type":"application/json","x-tsr-serverFn":"true",accept:"application/json" }, body });
  const txt = await res.text();
  let node; try{node=JSON.parse(txt);}catch{return{http:res.status,raw:txt.slice(0,900)};}
  let decoded; try{decoded=decodeSeroval(node);}catch(e){return{http:res.status,decodeErr:String(e),raw:txt.slice(0,900)};}
  return { http:res.status, val: decoded?.result ?? decoded };
}

function dump(val){
  if(!val||typeof val!=="object"){console.log("  val:",JSON.stringify(val).slice(0,500));return;}
  console.log("  decision.reason:",JSON.stringify(val.decision?.reason??val.decision?.mode??"(none)").slice(0,500));
  const replies = val.replies||[];
  const ids = replies.map(r=>r.agentId);
  console.log(`  RESPONDERS (${replies.length}): ${ids.join(", ")}`);
  const missing = EXPECT.filter(e=>!ids.includes(e));
  console.log(`  ALL 4 EXACT OWNERS PRESENT? ${missing.length===0 ? "YES" : "NO — missing: "+missing.join(", ")}`);
  const st = val.suggestedTasks||[];
  const filers = [...new Set(st.map(s=>s.ownerId))];
  console.log(`  suggestedTasks (${st.length}) filed by ${filers.length} owner(s): ${filers.join(", ")}`);
  for(const s of st) console.log(`    · owner=${s.ownerId} :: "${s.title}"`);
}

console.log("\n======== TURN A · 4-LANE LIST (expect cole+elle+finn+ezra) ========");
for(let run=1; run<=2; run++){
  console.log(`\n--- TURN A · RUN ${run} ---`);
  const r = await send(`Here are some things I need to tackle

Career - Apply to Trinnex position with boost, update LinkedIn profile, confirm the 6 courses taken in the MIT CTO program for th Linkedin update

Education - import AI course , add DBA program , add import schedule from image or file

Finance - make payments to klarna , transfer HSA funds, transfer bill account+amex+wife SUV repairs funds

Errands - cancel or take my wife's suv for repair 8am upcoming Tuesday morning`);
  console.log(`(http ${r.http})`);
  if(r.decodeErr) console.log("decodeErr:",r.decodeErr,"\nraw:",r.raw);
  else if(r.raw) console.log("raw:",r.raw);
  else dump(r.val);
}

console.log("\n\n======== TURN B · SINGLE-TOPIC CONTROL (expect solo, flex-grimes) ========");
console.log("YOU: what workouts do I usually go for?");
const rb = await send("what workouts do I usually go for?");
console.log(`(http ${rb.http})`);
if(rb.decodeErr) console.log("decodeErr:",rb.decodeErr,"\nraw:",rb.raw);
else if(rb.raw) console.log("raw:",rb.raw);
else dump(rb.val);

console.log("\n\n==== DONE ====");
