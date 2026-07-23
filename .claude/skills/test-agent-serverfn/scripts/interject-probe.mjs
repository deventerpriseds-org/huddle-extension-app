// Characterize the "extra voice" (interjector) on bare @mention turns: does it always fire? always
// the same agent? does it add value or noise? Varied prompts (some with a time/schedule angle, some
// without). Prints responders + FULL router reason + each reply's text. Spaced to avoid rate limits.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE="https://icy-flower-0f415200f.7.azurestaticapps.net", FN="a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662", plugins=defaultSerovalPlugins;
const ALL=["iris-chase","tess-sutton","sam-trent","terry-locke","finn-reid","faith-hartley","cole-blake"];
const NAME={"iris-chase":"Iris","tess-sutton":"Tess","sam-trent":"Sam","terry-locke":"Terry","finn-reid":"Finn","faith-hartley":"Faith","cole-blake":"Cole"};
const ROLE={"iris-chase":"itinerary/schedule","tess-sutton":"product","sam-trent":"startup/GTM","terry-locke":"scrum","finn-reid":"finance","faith-hartley":"wellbeing","cole-blake":"engineering"};
const CONST={1:undefined,2:null,3:NaN,4:Infinity,5:-Infinity,6:-0};
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}
const agents={};for(const id of ALL)agents[id]={backend:"openai",rag:{store:"azure",chunks:false,triples:false,fileSearch:false,sharing:"shared"},journey:{enabled:false},webSearch:false};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function send(text){const payload={text,huddleId:"all-members",scope:"group",members:ALL,history:[],router:{backend:"openai",model:"gpt-5.5",fastMode:false,soloOnCoverage:true,interjections:true,maxInterjectors:2},agents,timeZone:"America/New_York",caller:{entra_email:"von.ellis@enterpriseds.io"}};const body=JSON.stringify(await toJSONAsync({data:payload},{plugins}));const res=await fetch(`${BASE}/_serverFn/${FN}`,{method:"POST",headers:{"Content-Type":"application/json","x-tsr-serverFn":"true",accept:"application/json"},body});const txt=await res.text();let node;try{node=JSON.parse(txt);}catch{return{raw:txt.slice(0,120)};}let d;try{d=dec(node);}catch(e){return{e:String(e)};}return{val:d?.result??d};}
const nm=x=>NAME[x]||x;

// mentioned = who the user @mentioned (the intended sole responder). angle = why an interjector might fire.
const CASES=[
  {t:"@cole-blake how long will the backend API take to build?", mentioned:"Cole", angle:"time/duration"},
  {t:"@cole-blake what database should we use for the mirror?", mentioned:"Cole", angle:"none (pure tech)"},
  {t:"@finn-reid is our current burn rate healthy?", mentioned:"Finn", angle:"none (pure finance)"},
  {t:"@tess-sutton what should be in the MVP?", mentioned:"Tess", angle:"none (pure product)"},
  {t:"@sam-trent when should we launch the premium tier?", mentioned:"Sam", angle:"time/deadline"},
  {t:"@cole-blake can you review this API design?", mentioned:"Cole", angle:"none (pure eng)"},
];

for(const c of CASES){
  const r=await send(c.t);
  const reps=(r.val?.replies||[]);
  const who=reps.map(x=>nm(x.agentId));
  const reason=String(r.val?.decision?.reason||"");
  const real=reason.startsWith("LLM router");
  const extras=who.filter(n=>n!==c.mentioned);
  console.log(`\n■ "${c.t}"`);
  console.log(`   mentioned=${c.mentioned} | angle=${c.angle} | router=${real?"real":"FALLBACK/429"}`);
  console.log(`   responders: [${who.join(", ")}]  ${extras.length?`→ EXTRA: ${extras.join(", ")}`:"→ (mentioned only)"}`);
  console.log(`   reason: ${reason.slice(0,140)}`);
  for(const x of reps){const n=nm(x.agentId);const tag=n===c.mentioned?"(mentioned)":`(EXTRA — ${ROLE[x.agentId]||"?"})`;console.log(`     ${n} ${tag}: ${String(x.text).replace(/\n/g," ").slice(0,150)}`);}
  await sleep(12000);
}
