import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE="https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN="a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins=defaultSerovalPlugins;
const ALL=["iris-chase","tess-sutton","sam-trent","terry-locke","finn-reid","faith-hartley","cole-blake"];
const NAME={"iris-chase":"Iris","tess-sutton":"Tess","sam-trent":"Sam","terry-locke":"Terry","finn-reid":"Finn","faith-hartley":"Faith","cole-blake":"Cole"};
const CONST={1:undefined,2:null,3:NaN,4:Infinity,5:-Infinity,6:-0};
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}
const agents={};for(const id of ALL)agents[id]={backend:"openai",rag:{store:"azure",chunks:false,triples:false,fileSearch:false,sharing:"shared"},journey:{enabled:false},webSearch:false};
async function send(text){const payload={text,huddleId:"all-members",scope:"group",members:ALL,history:[],router:{backend:"openai",model:"gpt-5.5",fastMode:false,soloOnCoverage:true,interjections:true,maxInterjectors:2},agents,timeZone:"America/New_York",caller:{entra_email:"von.ellis@enterpriseds.io"}};const body=JSON.stringify(await toJSONAsync({data:payload},{plugins}));const t0=Date.now();const res=await fetch(`${BASE}/_serverFn/${FN}`,{method:"POST",headers:{"Content-Type":"application/json","x-tsr-serverFn":"true",accept:"application/json"},body});const ms=Date.now()-t0;const txt=await res.text();let node;try{node=JSON.parse(txt);}catch{return{http:res.status,ms,raw:txt.slice(0,150)};}let d;try{d=dec(node);}catch(e){return{http:res.status,ms,decodeErr:String(e)};}return{http:res.status,ms,val:d?.result??d};}
const nm=x=>NAME[x]||x;
const TEXT="Tess, scope the MVP for the premium tier, then hand it to @cole-blake for the engineering plan.";
for(let i=0;i<5;i++){const r=await send(TEXT);const who=(r.val?.replies||[]).map(x=>nm(x.agentId));console.log(`run ${i+1}: ${r.ms}ms responders=[${who.join(", ")}] tessPresent=${who.includes("Tess")}`);}
