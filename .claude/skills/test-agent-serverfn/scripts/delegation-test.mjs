// Multi-turn test of agent task-creation + inter-agent delegation + cross-agent context.
// Scenarios:
//   A) Ask Finn directly to create a task → does Finn create it?
//   B) Ask Finn to have IRIS create a task → does it hand off and does Iris create it?
//   C) Give Tess the details of a task, then ask Iris to create "the task I discussed with Tess"
//      WITHOUT restating name/details → can Iris do it from context?
// journey.enabled=true so create_huddle_task is offered; threaded history so context carries.
// Creates REAL journey tasks (named "TEST — …"). Run from repo root.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE="https://icy-flower-0f415200f.7.azurestaticapps.net", FN="a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662", plugins=defaultSerovalPlugins;
const ALL=["iris-chase","tess-sutton","sam-trent","terry-locke","finn-reid","faith-hartley","cole-blake"];
const NAME={"iris-chase":"Iris","tess-sutton":"Tess","sam-trent":"Sam","terry-locke":"Terry","finn-reid":"Finn","faith-hartley":"Faith","cole-blake":"Cole"};
const CONST={1:undefined,2:null,3:NaN,4:Infinity,5:-Infinity,6:-0};
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}
const agents={};for(const id of ALL)agents[id]={backend:"openai",rag:{store:"azure",chunks:true,triples:false,fileSearch:false,sharing:"shared"},journey:{enabled:true},webSearch:false};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const HID="all-members"; let ts=1;
const userMsg=t=>({id:`m${ts}`,huddleId:HID,author:{kind:"user"},text:t,ts:ts++});
const agentMsg=(a,t)=>({id:`m${ts}`,huddleId:HID,author:{kind:"agent",agentId:a},text:t,ts:ts++});
async function send(text,history){const payload={text,huddleId:HID,scope:"group",members:ALL,history,router:{backend:"openai",model:"gpt-5.5",fastMode:false,soloOnCoverage:true,interjections:false,maxInterjectors:2},agents,timeZone:"America/New_York",caller:{entra_email:"von.ellis@enterpriseds.io"}};const body=JSON.stringify(await toJSONAsync({data:payload},{plugins}));const res=await fetch(`${BASE}/_serverFn/${FN}`,{method:"POST",headers:{"Content-Type":"application/json","x-tsr-serverFn":"true",accept:"application/json"},body});const txt=await res.text();let node;try{node=JSON.parse(txt);}catch{return{raw:txt.slice(0,200)};}let d;try{d=dec(node);}catch(e){return{e:String(e)};}return{val:d?.result??d};}
const nm=x=>NAME[x]||x;
function tasksOf(v){const s=(v?.suggestedTasks||[]).map(t=>t.title||t.name||JSON.stringify(t).slice(0,40));const j=(v?.journeyTaskUpdates||[]).map(t=>t.title||t.name||t.task_name||JSON.stringify(t).slice(0,40));return {s,j};}
let history=[];
async function turn(label,text){
  const r=await send(text,history);
  const v=r.val||{};
  const reps=v.replies||[];
  const who=reps.map(x=>nm(x.agentId));
  const {s,j}=tasksOf(v);
  console.log(`\n════ ${label}\nYOU: ${text}`);
  console.log(`  responders: [${who.join(", ")}]`);
  for(const x of reps)console.log(`   ${nm(x.agentId)}: ${String(x.text).replace(/\n/g," ").slice(0,180)}`);
  console.log(`  suggestedTasks: [${s.join(" | ")}]`);
  console.log(`  journeyTaskUpdates: [${j.join(" | ")}]`);
  // thread replies into history
  history=history.concat(userMsg(text), ...reps.map(x=>agentMsg(x.agentId,x.text)));
  return {who,s,j};
}
// A) direct
await turn("A) direct create (Finn)","Finn, create a task called \"TEST — reconcile Q3 vendor invoices\" and note to check the $12k discrepancy.");
await sleep(10000);
// B) delegate Finn -> Iris
await turn("B) delegate (Finn -> Iris)","Finn, have Iris create a task called \"TEST — book the Q3 board dinner venue\".");
await sleep(10000);
// C1) give Tess the details
await turn("C1) give Tess details","Tess, for the onboarding revamp we need a task: redesign the welcome screen as a 3-step wizard, due next Friday. Call it \"TEST — onboarding wizard redesign\".");
await sleep(10000);
// C2) ask Iris to create the task discussed with Tess, WITHOUT restating it
await turn("C2) Iris creates the task discussed w/ Tess (no details restated)","Iris, check with Tess and create the task I just went over with her.");
console.log("\n(remember to delete the TEST — tasks from journey afterward)");
