import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE = "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const ALL = ["iris-chase","cole-blake","elle-rowan","finn-reid","ezra-miles","faith-hartley","tess-sutton","sam-trent","terry-locke","eli-vaughn","cam-post","liam-kingsley","troy-lennox","flex-grimes","charleston-lewis"];
const agents = {};
for (const id of ALL) agents[id] = { backend:"openai", rag:{store:"azure",chunks:false,triples:false,fileSearch:false,sharing:"shared"}, journey:{enabled:false}, webSearch:false };
const router = { backend:"openai", model:"gpt-4o-mini", fastMode:false, strictPrompt:false, soloOnCoverage:true, interjections:false, maxInterjectors:0 };
const CONST = {1:undefined,2:null,3:NaN,4:Infinity,5:-Infinity,6:-0};
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}
const msg = `Here are some things I need to tackle 

Career - Apply to Trinnex position with boost, update LinkedIn profile, confirm the 6 courses taken in the MIT CTO program for th Linkedin update 

Education - import AI course , add DBA program , add import schedule from image or file 

Finance - make payments to klarna , transfer HSA funds, transfer bill account+amex+wife SUV repairs funds

Errands - cancel or take my wife's suv for repair 8am upcoming Tuesday morning`;
const payload = { text:msg, huddleId:"all-members", scope:"group", members:ALL, history:[], router, agents, timeZone:"America/New_York" };
const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
const res = await fetch(`${BASE}/_serverFn/${FN}`, { method:"POST", headers:{ "Content-Type":"application/json","x-tsr-serverFn":"true", accept:"application/json" }, body });
const txt = await res.text();
let val; try { val = dec(JSON.parse(txt)); val = val?.result ?? val; } catch(e){ console.log("http",res.status,"decodeErr",String(e),"raw",txt.slice(0,300)); process.exit(); }
console.log("HTTP", res.status);
console.log("FULL decision:", JSON.stringify(val?.decision));
console.log("reasoning:", JSON.stringify(val?.reasoning)?.slice(0,600));
console.log("responders:", (val?.replies||[]).map(r=>r.agentId).join(", "));
console.log("suggestedTasks:", (val?.suggestedTasks||[]).map(t=>`${t.ownerId}:${t.title}`).join(" | "));
