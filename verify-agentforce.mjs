// TEMP fake-link fix verify (delete after). Re-drives the exact autowork-style research directive that
// produced the fabricated "[here](salesforce.com)" link, and checks the reply has NO fake doc-link:
// either a real create_artifact chip, or plain findings with no markdown http link.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN = "a05698ead723b29fa9081c375c1940d87eac6e9ae3efaf24489ef0ec9c2fc662"; // sendHuddleMessage
const plugins = defaultSerovalPlugins;
const CALLER = { entra_email: "von.ellis@enterpriseds.io" };

const CONST = { 1: undefined, 2: null, 3: NaN, 4: Infinity, 5: -Infinity, 6: -0 };
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}

const directive =
  "You've been assigned this task on the board: \"Research Agentforce by Salesforce\". Do the work now as " +
  "the startup planner you are. Research it and give me a substantive summary of what Agentforce is, who " +
  "it's for, and whether it matters for my ventures. If you compile a document, save it with create_artifact " +
  "(folder Research) so it becomes a real link.";

const payload = { text: directive, huddleId: "dm-sam-trent", scope: "one-to-one", members: ["sam-trent"], targetAgentId: "sam-trent", history: [], router: { backend: "openai", model: "gpt-4o-mini", soloOnCoverage: true, interjections: false }, agents: { "sam-trent": { backend: "openai", journey: { enabled: false }, rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" }, webSearch: true } }, timeZone: "America/New_York", caller: CALLER };
const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
const res = await fetch(`${BASE}/_serverFn/${FN}`, { method: "POST", headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" }, body });
const txt = await res.text();
const val = (dec(JSON.parse(txt)))?.result;
console.log("HTTP", res.status, "| decision:", val?.decision?.reason);
for (const r of val?.replies ?? []) {
  const hasMdHttp = /\[[^\]]+\]\(https?:\/\/[^)\s]+\)/.test(r.text);
  const chips = (r.artifacts ?? []).map((a) => a.name);
  console.log(`\n── ${r.agentId} ──`);
  console.log(r.text);
  console.log(`\n  real artifact chips: ${chips.length ? chips.join(", ") : "(none)"}`);
  console.log(`  raw markdown http-link in text: ${hasMdHttp ? "YES ⚠️" : "no"}`);
  console.log(`  VERDICT: ${(!hasMdHttp) ? "PASS — no fabricated doc-link" : "FAIL — a bare markdown link remains"}`);
}
