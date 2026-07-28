// Regression guard for CEREMONY BARGE-IN. Runs a clean stand-up (baseline), then a second stand-up
// that a user BARGES into mid-run, and asserts: the interjection is answered, the relay RESUMES and
// Terry still closes, NO ceremony participant is dropped, the barge is idempotent (double-send dedups),
// and nothing spills into a 1:1. Run against the deployed SWA. Refresh FN ids from the build if 404.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE = "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN_ENQ = "c79b918b188cb2ef56b73995a55d32df04f1e0076f8162ccfb23a363b2aac9b3";
const FN_POLL = "874177d69ad37451f9c3ae0ea56f444f2a7f6fc3a83ce4494ad5a9ec6036daad";
const FN_BARGE = "5b90651b4fc038e90dfac3a7dbb15cafb6b859c0bb67bbdbad4b016bf610736c";
const plugins = defaultSerovalPlugins;
const CALLER = { entra_email: "von.ellis@enterpriseds.io" };
const M = ["terry-locke","iris-chase","finn-reid","faith-hartley","elle-rowan","flex-grimes","ezra-miles","sam-trent","cole-blake","charleston-lewis","eli-vaughn","liam-kingsley","cam-post","troy-lennox","tess-sutton"];
const agents = {}; for (const id of M) agents[id] = { backend:"openai", journey:{enabled:false}, rag:{store:"azure",chunks:false,triples:false,fileSearch:false,sharing:"shared"}, webSearch:false };
const router = { backend:"openai", model:"gpt-4o-mini", soloOnCoverage:true, interjections:false, ceremonyMode:"round-robin" };
// CORRECT seroval constant indices (verified via toJSONAsync): 0=null 1=undefined 2=true 3=false
// 4=-0 5=Infinity 6=-Infinity 7=NaN. (The isolation harness copies the buggy map — latent there
// because it only reads strings; here we decode a boolean `queued`, so it must be right.)
const CONST = [null, undefined, true, false, -0, Infinity, -Infinity, NaN];
function dec(r){const g=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return CONST[n.s];case 7:return g.get(n.i);case 9:{const a=[];if(n.i!=null)g.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)g.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(r);}
async function call(fn,p){const b=JSON.stringify(await toJSONAsync({data:p},{plugins}));const res=await fetch(`${BASE}/_serverFn/${fn}`,{method:"POST",headers:{"Content-Type":"application/json","x-tsr-serverFn":"true",accept:"application/json"},body:b});const t=await res.text();let n;try{n=JSON.parse(t);}catch{return{http:res.status,val:null};}return{http:res.status,val:dec(n)?.result};}
const CEREMONY = "ceremony-standup";
const ONE_TO_ONE = "dm-terry-locke";
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// Run a stand-up to completion; optionally fire a barge once >=`bargeAfter` replies have streamed.
async function runStandup(label, barge){
  const turnId = `ceremony-${CEREMONY}-standup-${label}-${Date.now()}`;
  const enqP = call(FN_ENQ,{text:"let's run the daily stand-up",huddleId:CEREMONY,scope:"group",members:M,history:[],router,agents,timeZone:"America/New_York",caller:CALLER,turnId});
  let seen=0,done=false,order=[],replies=[],g=0,barged=false,dedupResult=null;
  while(!done && g++<90){
    await sleep(2500);
    const p=await call(FN_POLL,{huddleId:CEREMONY,sinceMs:0});
    const turn=(p.val?.turns??[]).find(t=>t.id===turnId);
    if(turn){
      const reps=turn.result?.replies??turn.replies??[];
      if(reps.length>seen){for(const r of reps.slice(seen)){order.push(r.agentId);replies.push(r);}seen=reps.length;}
      if(turn.status==="done"||turn.status==="error")done=true;
    }
    if(barge && !barged && seen>=barge.after){
      barged=true;
      const first=await call(FN_BARGE,{turnId,text:barge.text});
      const second=await call(FN_BARGE,{turnId,text:barge.text}); // same text → same id → must dedup
      dedupResult={first:first.val?.queued, second:second.val?.queued};
      console.log(`  barge fired after ${seen} replies → queued=${JSON.stringify(dedupResult)}`);
    }
  }
  await enqP;
  return { order, replies, dedupResult };
}

console.log("== baseline (no barge) ==");
const base = await runStandup("base", null);
const baseOwners = [...new Set(base.order.filter(id=>id!=="terry-locke"))];
console.log("  order:", base.order.join(" → "));

console.log("== barge run ==");
const dmBefore = ((await call(FN_POLL,{huddleId:ONE_TO_ONE,sinceMs:0})).val?.turns??[]).length;
// Targeted interjection → the router sends it to the specialist (Finn, finance) who answers with the
// runway figure. (A message containing "everyone" is a BROADCAST and correctly goes to the host — a
// different, also-valid path; we test the targeted case since "the right agent answers" is the point.)
const bargeText = "Quick question for Finn — what is our current cash runway in months?";
const run = await runStandup("barge", { after: 2, text: bargeText });
const dmAfter = ((await call(FN_POLL,{huddleId:ONE_TO_ONE,sinceMs:0})).val?.turns??[]).length;
console.log("  order:", run.order.join(" → "));

const opensFirst = run.order[0]==="terry-locke";
const closesLast = run.order.length>1 && run.order[run.order.length-1]==="terry-locke";
// The barge responder should address the finance interjection — allow natural phrasings of "runway".
const answered = run.replies.some(r => /runway|months? of (cash|runway)|cash (position|on hand)|burn rate/i.test((r.text??"").replace(/\\[nrt]/g," ")));
const bargeOwners = new Set(run.order.filter(id=>id!=="terry-locke"));
const dropped = baseOwners.filter(o => !bargeOwners.has(o));
const noDrop = dropped.length===0;
const dedupOk = run.dedupResult && run.dedupResult.first===true && run.dedupResult.second===false;
const spilled = dmAfter - dmBefore;

console.log("\n--- results ---");
console.log("AC-7a Terry opens:", opensFirst ? "PASS ✓" : `FAIL ✗ (${run.order[0]})`);
console.log("AC-7b relay resumed, Terry closes:", closesLast ? "PASS ✓" : `FAIL ✗ (last=${run.order[run.order.length-1]})`);
console.log("AC-6 interjection answered (a reply mentions 'runway'):", answered ? "PASS ✓" : "FAIL ✗");
console.log(`AC-8 no participant dropped (baseline owners ⊆ barge owners):`, noDrop ? "PASS ✓" : `FAIL ✗ dropped=${dropped.join(",")}`);
console.log("AC-9 barge idempotent (2nd identical send deduped):", dedupOk ? "PASS ✓" : `FAIL ✗ (${JSON.stringify(run.dedupResult)})`);
console.log(`AC-10 no 1:1 spill (dm-terry-locke ${dmBefore}/${dmAfter}):`, spilled===0 ? "PASS ✓" : `FAIL ✗ (${spilled})`);
const ok = opensFirst && closesLast && answered && noDrop && dedupOk && spilled===0;
console.log("\nBARGE-IN:", ok ? "PASS ✓✓" : "FAIL ✗");
process.exit(ok?0:1);
