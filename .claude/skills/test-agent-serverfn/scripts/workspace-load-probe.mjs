// WHAT:       Probe the live loadWorkspace / getAllTurnUpdates server fns: reachable, how fast, what error.
// WHY:        2026-11-07 the owner's app hung on "Loading your message history…". A fake id token must fail
//             FAST with an auth error if the server fn is healthy; a timeout / 5xx points at the host.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
import crypto from "crypto";
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";
const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const id = (file, name) => crypto.createHash("sha256").update(`${file}--${name}_createServerFn_handler`).digest("hex");
async function call(file, name, payload) {
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins: defaultSerovalPlugins }));
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/_serverFn/${id(file, name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(90_000),
    });
    const txt = await res.text();
    console.log(`${name}: HTTP ${res.status} in ${Date.now() - t0}ms; ${txt.length} bytes; ${txt.slice(0, 400).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`${name}: THREW after ${Date.now() - t0}ms: ${e}`);
  }
}
for (let i = 1; i <= 2; i++) {
  await call("src/features/huddle/lib/identity/workspace.functions.ts", "loadWorkspace", { idToken: "probe-not-a-real-token-xxxxxxxxxxxxxxxx" });
}
const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(30000) }).catch((e) => ({ status: String(e) }));
console.log(`GET / -> ${r.status}`);
