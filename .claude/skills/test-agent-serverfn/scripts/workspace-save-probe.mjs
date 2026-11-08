// WHAT:       Probe the live loadWorkspace + saveWorkspace(merge) server fns with a dummy token: healthy = a fast auth error.
// WHY:        2026-11-08 the owner got "Couldn't save your latest messages" after re-signing in; DB last save 15:50:59Z.
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
const F = "src/features/huddle/lib/identity/workspace.functions.ts";
const tok = "probe-not-a-real-token-xxxxxxxxxxxxxxxx";
await call(F, "loadWorkspace", { idToken: tok, recentDays: 30 });
await call(F, "saveWorkspace", { idToken: tok, stateJson: '{"messages":[]}', mergeMessages: true });
await call(F, "saveWorkspace", { idToken: tok, stateJson: '{"messages":[]}' });
