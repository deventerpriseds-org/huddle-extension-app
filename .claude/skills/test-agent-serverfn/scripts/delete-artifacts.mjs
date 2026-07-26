#!/usr/bin/env node
// Delete specific artifacts by id via the deployed deleteArtifactFn (row + blob). Pass ids as argv.
// Used to remove the ACT-5 SHORTCUT artifacts (mechanical Tavily dumps) so the real agents re-research.
import fs from "fs"; import path from "path";
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const CALLER = { entra_email: process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io" };
const dir = path.resolve(".output/server");
const f = fs.readdirSync(dir).find((x) => x.includes("server-fn-resolver"));
const s = fs.readFileSync(path.join(dir, f), "utf8");
const re = /"([a-f0-9]{64})"\s*:\s*\{[^}]*?functionName:\s*"([a-zA-Z0-9_]+)_createServerFn_handler"/g;
const FN = {}; let m; while ((m = re.exec(s))) FN[m[2]] = m[1];
const CONST = {0:null,1:undefined,2:true,3:false,4:-0,5:Infinity,6:-Infinity,7:NaN};
function dec(root){const reg=new Map();function w(n){if(n==null||typeof n!=="object")return n;switch(n.t){case 0:case 1:return n.s;case 3:return typeof n.s==="string"?BigInt(n.s):n.s;case 2:return n.s in CONST?CONST[n.s]:undefined;case 7:return reg.get(n.i);case 9:{const a=[];if(n.i!=null)reg.set(n.i,a);for(const it of n.a??[])a.push(w(it));return a;}case 10:case 11:{const o={};if(n.i!=null)reg.set(n.i,o);const k=n.p?.k??[],v=n.p?.v??[];for(let j=0;j<k.length;j++)o[k[j]]=w(v[j]);return o;}default:return n.s??null;}}return w(root);}
async function call(id,payload){const body=JSON.stringify(await toJSONAsync({data:payload},{plugins:defaultSerovalPlugins}));const r=await fetch(`${BASE}/_serverFn/${id}`,{method:"POST",headers:{"Content-Type":"application/json","x-tsr-serverFn":"true"},body});const t=await r.text();try{return dec(JSON.parse(t))?.result;}catch{return {httpError:r.status,raw:t.slice(0,150)};}}
const ids = process.argv.slice(2);
if (!ids.length) { console.error("usage: delete-artifacts.mjs <id> [id...]"); process.exit(1); }
for (const id of ids) {
  const r = await call(FN.deleteArtifactFn, { caller: CALLER, id });
  console.log(id, "→", JSON.stringify(r));
}
