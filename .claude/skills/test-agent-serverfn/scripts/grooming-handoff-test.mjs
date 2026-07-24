// Verify the capability hand-off flow for backlog grooming:
//   T1 (group) "Hey Tess, please perform backlog grooming"
//      -> Tess DEFERS (no groom, no meta-task) + @terry-locke ; Terry brought in, CONFIRMS (no groom yet)
//   T2 (group, threaded) "Yes Terry, go ahead"  -> Terry calls groom_backlog
//   T3 (control, fresh)  "Tess, what should the MVP include?" -> still Tess, no grooming
// journey.enabled=true so Terry actually holds groom_backlog. Prints responders + text + toolUses.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE="https://icy-flower-0f415200f.7.azurestaticapps.net", FN="a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662", plugins=defaultSerovalPlugins;
const ALL=["iris-chase","tess-sutton","sam-trent","terry-locke","finn-reid","faith-hartley","cole-blake"];
const NAME={"iris-chase":"Iris","tess-sutton":"Tess","sam-trent":"Sam","terry-locke":"Terry","finn-reid":"Finn","faith-hartley":"Faith","cole-blake":"Cole"};
const CONST={1:undefined,2:null,3:NaN,4:Infinity,5:-Infinity,6:-0};
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}
const agents={};for(const id of ALL)agents[id]={backend:"openai",rag:{store:"azure",chunks:false,triples:false,fileSearch:false,sharing:"shared"},journey:{enabled:true},webSearch:false};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ts=1; const HID="all-members";
const userMsg=(t)=>({id:`m${ts}`,huddleId:HID,author:{kind:"user"},text:t,ts:ts++});
const agentMsg=(a,t)=>({id:`m${ts}`,huddleId:HID,author:{kind:"agent",agentId:a},text:t,ts:ts++});
async function send(text,history,hid=HID){const payload={text,huddleId:hid,scope:"group",members:ALL,history,router:{backend:"openai",model:"gpt-5.5",fastMode:false,soloOnCoverage:true,interjections:false,maxInterjectors:2},agents,timeZone:"America/New_York",caller:{entra_email:"von.ellis@enterpriseds.io"}};const body=JSON.stringify(await toJSONAsync({data:payload},{plugins}));const res=await fetch(`${BASE}/_serverFn/${FN}`,{method:"POST",headers:{"Content-Type":"application/json","x-tsr-serverFn":"true",accept:"application/json"},body});const txt=await res.text();let node;try{node=JSON.parse(txt);}catch{return{raw:txt.slice(0,150)};}let d;try{d=dec(node);}catch(e){return{e:String(e)};}return d?.result??d;}
const nm=x=>NAME[x]||x;
const tools=v=>(v?.toolUses||[]).map(t=>t.name||t.tool||t.toolName||JSON.stringify(t).slice(0,30));
let history=[];
async function turn(label,text,thread=true){
  const v=await send(text,thread?history:[]);
  const reps=v?.replies||[];
  console.log(`\n════ ${label}\nYOU: ${text}`);
  console.log(`  responders: [${reps.map(x=>nm(x.agentId)).join(", ")}]`);
  for(const x of reps)console.log(`   ${nm(x.agentId)}: ${String(x.text).replace(/\n/g," ").slice(0,200)}`);
  console.log(`  toolUses: [${tools(v).join(", ")}]   tasks:[${(v?.journeyTaskUpdates||[]).map(t=>t.title||t.name).join(" | ")}]`);
  if(thread){history=history.concat(userMsg(text), ...reps.map(x=>agentMsg(x.agentId,x.text)));}
  return {reps,v};
}
await turn("T1 group: ask Tess to groom (expect Tess defers + Terry confirms, NO groom_backlog)","Hey Tess, please perform backlog grooming");
await sleep(10000);
await turn("T2 group: user gives go-ahead (expect Terry calls groom_backlog)","Yes Terry, go ahead and groom it now.");
await sleep(10000);
await turn("T3 control: normal product ask (expect Tess, no grooming)","Tess, what should the MVP include for the premium tier?", false);
