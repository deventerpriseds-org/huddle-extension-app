// WHAT:       offline suite for the Huddle Android app's FCM registration loop (lib/push/bridge-fcm-register.ts).
// WHY:        journey-voice VERIFY-phone-registration-a-2: `done` was set before getToken(), so one null ID token
//             silently skipped registration for the whole page session. Pins: done only after an ok send; a
//             skip is logged and retried; failures retry; the loop is bounded; cleanup stops it.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   journey-voice docs/qc-evidence/RESTORE-step3-j13-j14-security.md ("Loop 3 fixes")
//
// Run:  npm run test:bridge-fcm-register   (bun scripts/bridge-fcm-register.test.ts)
import { startBridgeFcmRegistration, type BridgeFcmRegistrationDeps } from "../src/features/huddle/lib/push/bridge-fcm-register";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Harness: scheduled callbacks are queued and run one per tick() so the test controls time. */
function harness(over: Partial<BridgeFcmRegistrationDeps> & { idTokens?: (string | null)[]; sends?: boolean[]; fcm?: string[] }) {
  const queue: (() => void)[] = [];
  const logs: string[] = [];
  const sent: { idToken: string; fcm: string }[] = [];
  let cancelled = 0;
  const ids = [...(over.idTokens ?? ["id-token"])];
  const sends = [...(over.sends ?? [true])];
  const fcms = [...(over.fcm ?? ["fcm-token"])];
  const deps: BridgeFcmRegistrationDeps = {
    getFcmToken: () => (fcms.length > 1 ? fcms.shift()! : fcms[0]),
    getIdToken: async () => (ids.length > 1 ? ids.shift()! : ids[0]),
    send: async (idToken, fcm) => { sent.push({ idToken, fcm }); const ok = sends.length > 1 ? sends.shift()! : sends[0]; return ok ? { ok: true } : { ok: false, error: "unauthorized" }; },
    schedule: (fn) => { queue.push(fn); return queue.length; },
    cancel: () => { cancelled++; },
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, queue, logs, sent, get cancelled() { return cancelled; }, async tick() { const f = queue.shift(); if (f) f(); await flush(); await flush(); } };
}

console.log("\n--- registration loop ---");
{
  const h = harness({ idTokens: [null, "id-token"] });
  startBridgeFcmRegistration(h.deps); await flush(); await flush();
  check("L-1: a null ID token is LOGGED as a skip and NOT marked done (no send yet)", h.sent.length === 0 && h.logs.some((l) => /skipped: no Entra ID token/.test(l)) && h.queue.length === 1, JSON.stringify(h.logs));
  await h.tick();
  check("L-2: the retry sends once the ID token is available", h.sent.length === 1 && h.sent[0].idToken === "id-token" && h.sent[0].fcm === "fcm-token", JSON.stringify(h.sent));
  check("L-3: after an ok send nothing more is scheduled (done)", h.queue.length === 0 && h.logs.at(-1) === "[bridge-fcm] registered", JSON.stringify(h.logs));
}
{
  const h = harness({ sends: [false, true] });
  startBridgeFcmRegistration(h.deps); await flush(); await flush();
  check("L-4: a refused send is retried, not marked done", h.sent.length === 1 && h.queue.length === 1 && h.logs.some((l) => /refused: unauthorized/.test(l)));
  await h.tick();
  check("L-5: the retry succeeds and stops", h.sent.length === 2 && h.queue.length === 0);
}
{
  const h = harness({ send: async () => { throw new Error("network down"); } });
  startBridgeFcmRegistration(h.deps); await flush(); await flush();
  check("L-6: a thrown send is logged and retried", h.queue.length === 1 && h.logs.some((l) => /failed: network down/.test(l)));
}
{
  const h = harness({ fcm: ["", "fcm-token"] });
  startBridgeFcmRegistration(h.deps); await flush(); await flush();
  check("L-7: waits for the bridge's FCM token before asking for an ID token", h.sent.length === 0 && h.queue.length === 1);
  await h.tick();
  check("L-8: then registers", h.sent.length === 1);
}
{
  const h = harness({ idTokens: [null], maxAttempts: 3 });
  startBridgeFcmRegistration(h.deps);
  for (let i = 0; i < 6; i++) { await flush(); await h.tick(); }
  check("L-9: bounded: gives up after maxAttempts and says so", h.sent.length === 0 && h.queue.length === 0 && h.logs.some((l) => /giving up until the next page load/.test(l)), JSON.stringify(h.logs));
}
{
  const h = harness({ idTokens: [null, "id-token"] });
  const stop = startBridgeFcmRegistration(h.deps); await flush(); await flush();
  stop();
  check("L-10: cleanup cancels the pending retry", h.cancelled === 1);
  await h.tick();
  check("L-11: a retry that fires after cleanup sends nothing", h.sent.length === 0);
}

console.log("\n--- wiring (source) ---");
const view = await Bun.file(new URL("../src/features/huddle/components/HuddleView.tsx", import.meta.url)).text();
const eff = view.slice(view.indexOf("Standalone Huddle Android app: register"), view.indexOf("const [notifyStripHidden"));
check("W-1: HuddleView uses startBridgeFcmRegistration and sends idToken, with no inline `done = true`", /startBridgeFcmRegistration\(/.test(eff) && /registerBridgeFcmToken\(\{ data: \{ idToken, token \} \}\)/.test(eff) && !/done = true/.test(eff));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
