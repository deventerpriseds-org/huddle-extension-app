// Localize the handoff routing gap: for a "A do X, then @B do Y" message, who does the router pick as
// primary/supporting, and who actually replies? Prints the router decision + responders per phrasing.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662";
const plugins = defaultSerovalPlugins;
const ALL = ["iris-chase", "tess-sutton", "sam-trent", "terry-locke", "finn-reid", "faith-hartley", "cole-blake"];
const NAME = { "iris-chase": "Iris", "tess-sutton": "Tess", "sam-trent": "Sam", "terry-locke": "Terry", "finn-reid": "Finn", "faith-hartley": "Faith", "cole-blake": "Cole" };
const CONST = { 1: undefined, 2: null, 3: NaN, 4: Infinity, 5: -Infinity, 6: -0 };
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}
const agents={};for(const id of ALL)agents[id]={backend:"openai",rag:{store:"azure",chunks:false,triples:false,fileSearch:false,sharing:"shared"},journey:{enabled:false},webSearch:false};

async function send(text){
  const payload={text,huddleId:"all-members",scope:"group",members:ALL,history:[],router:{backend:"openai",model:"gpt-5.5",fastMode:false,soloOnCoverage:true,interjections:true,maxInterjectors:2},agents,timeZone:"America/New_York",caller:{entra_email:"von.ellis@enterpriseds.io"}};
  const body=JSON.stringify(await toJSONAsync({data:payload},{plugins}));
  const res=await fetch(`${BASE}/_serverFn/${FN}`,{method:"POST",headers:{"Content-Type":"application/json","x-tsr-serverFn":"true",accept:"application/json"},body});
  const txt=await res.text(); let node; try{node=JSON.parse(txt);}catch{return{http:res.status,raw:txt.slice(0,200)};}
  let d; try{d=dec(node);}catch(e){return{http:res.status,decodeErr:String(e)};}
  return {http:res.status,val:d?.result??d};
}
const nm=(x)=>NAME[x]||x;

const CASES = [
  "Tess, scope the MVP for the premium tier, then hand it to @cole-blake for the engineering plan.",
  "@tess-sutton scope the MVP for the premium tier, then @cole-blake do the engineering plan.",
  "Tess, scope the MVP for the premium tier.",
  "Tess and Cole: Tess scope the MVP, Cole then do the engineering plan.",
];

for (const text of CASES) {
  const r = await send(text);
  const v = r.val || {};
  const d = v.decision || {};
  const responders = (v.replies||[]).map(x=>nm(x.agentId));
  console.log(`\n=== "${text.slice(0,70)}..." (http ${r.http}) ===`);
  console.log(`  decision.primary     : ${d.primary?nm(d.primary):d.primary}`);
  console.log(`  decision.supporting  : [${(d.supporting||[]).map(nm).join(", ")}]`);
  console.log(`  decision.explicitlyRequested: [${(d.explicitlyRequested||[]).map(nm).join(", ")}]`);
  console.log(`  decision.winners     : [${(d.winners||[]).map(nm).join(", ")}]`);
  console.log(`  decision.reason      : ${String(d.reason||"").slice(0,160)}`);
  console.log(`  ACTUAL responders    : [${responders.join(", ")}]`);
}
