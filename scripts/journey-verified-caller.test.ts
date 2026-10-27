// WHAT:       offline guard suite: Huddle's journey-tool server fns run ONLY as a caller proven by a verified
//             Entra ID token -- never as a caller named in the request body.
// WHY:        journey-voice VERIFY-phone-registration-a-1 C2-BYPASS1 (2026-10-27): `invokeJourneyToolDebug` and
//             `registerBridgeFcmToken` trusted `caller.entra_email` from the POST body, and huddle-proxy turns
//             that into a service-role execute-tool call, so anyone could register their phone for any user.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   journey-voice docs/qc-evidence/RESTORE-step3-j13-j14-security.md ("Loop 2 fixes", fix 2)
//
// Run:  npm run test:journey-verified-caller   (bun scripts/journey-verified-caller.test.ts)
// No network: the verifier and the proxy call are injected.
import {
  invokeJourneyToolDebugImpl,
  registerBridgeFcmTokenImpl,
  verifiedJourneyCaller,
  type VerifyIdToken,
} from "../src/features/huddle/lib/journey/verified-caller.server";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

const GOOD = "good-id-token-xxxxxxxxxxxxxxxxxxxx";
const NOEMAIL = "no-email-id-token-xxxxxxxxxxxxxxxx";
const verify: VerifyIdToken = async (t) => {
  if (t === GOOD) return { oid: "oid-owner", email: "owner@example.com" };
  if (t === NOEMAIL) return { oid: "oid-x", email: null };
  throw new Error("invalid signature");
};
const calls: any[] = [];
const invoke = async (req: any) => { calls.push(req); return { ok: true, output: "ok" }; };
const VICTIM = { entra_email: "victim@example.com", entra_object_id: "oid-victim" };

console.log("\n--- verifiedJourneyCaller ---");
check("VC-1: a verified token yields its own oid + email", JSON.stringify(await verifiedJourneyCaller(GOOD, verify)) === JSON.stringify({ entra_object_id: "oid-owner", entra_email: "owner@example.com" }));
check("VC-2: missing / short / non-string token -> null", (await verifiedJourneyCaller(undefined, verify)) === null && (await verifiedJourneyCaller("short", verify)) === null && (await verifiedJourneyCaller(123, verify)) === null);
check("VC-3: a token that fails verification -> null", (await verifiedJourneyCaller("forged-id-token-xxxxxxxxxxxxxxxxxx", verify)) === null);
check("VC-4: a verified token without an email -> null", (await verifiedJourneyCaller(NOEMAIL, verify)) === null);

console.log("\n--- registerBridgeFcmToken ---");
calls.length = 0;
let r = await registerBridgeFcmTokenImpl({ token: "attacker-phone", caller: VICTIM } as any, { invoke, verify });
check("RB-1: no idToken + body caller = victim -> refused, proxy never called", r.ok === false && r.error === "unauthorized" && calls.length === 0, JSON.stringify({ r, calls }));
calls.length = 0;
r = await registerBridgeFcmTokenImpl({ idToken: "forged-id-token-xxxxxxxxxxxxxxxxxx", token: "attacker-phone", caller: VICTIM } as any, { invoke, verify });
check("RB-2: forged idToken -> refused, proxy never called", r.ok === false && calls.length === 0);
calls.length = 0;
r = await registerBridgeFcmTokenImpl({ idToken: GOOD, token: "my-phone", caller: VICTIM } as any, { invoke, verify });
check("RB-3: verified caller registers for ITSELF, body caller ignored", r.ok === true && calls.length === 1 && calls[0].caller.entra_email === "owner@example.com" && calls[0].toolName === "register_push_token" && calls[0].args.app === "huddle", JSON.stringify(calls));

console.log("\n--- invokeJourneyToolDebug ---");
calls.length = 0;
let d = await invokeJourneyToolDebugImpl({ toolName: "register_push_token", args: { fcm_token: "attacker-phone" }, caller: VICTIM } as any, { invoke, verify });
check("DB-1: register_push_token with no idToken -> refused, proxy never called", d.ok === false && calls.length === 0, JSON.stringify(d));
calls.length = 0;
d = await invokeJourneyToolDebugImpl({ idToken: "forged-id-token-xxxxxxxxxxxxxxxxxx", toolName: "get_tasks", args: {}, caller: VICTIM } as any, { invoke, verify });
check("DB-2: any tool with a forged idToken -> refused", d.ok === false && calls.length === 0);
calls.length = 0;
d = await invokeJourneyToolDebugImpl({ idToken: GOOD, toolName: "get_tasks", args: {}, caller: VICTIM } as any, { invoke, verify });
check("DB-3: verified caller runs the tool as ITSELF, body caller ignored", d.ok === true && calls.length === 1 && calls[0].caller.entra_email === "owner@example.com", JSON.stringify(calls));

console.log("\n--- wiring (source) ---");
const proxySrc = await Bun.file(new URL("../src/features/huddle/lib/journey/proxy.functions.ts", import.meta.url)).text();
const hudSrc = await Bun.file(new URL("../src/features/huddle/lib/huddle.functions.ts", import.meta.url)).text();
const dbgBody = proxySrc.slice(proxySrc.indexOf("export const invokeJourneyToolDebug"), proxySrc.indexOf("// Re-export for consumers"));
const regBody = hudSrc.slice(hudSrc.indexOf("export const registerBridgeFcmToken"), hudSrc.indexOf("export async function drainQueuedTurns"));
check("W-1: invokeJourneyToolDebug's handler delegates to invokeJourneyToolDebugImpl and never reads data.caller", /invokeJourneyToolDebugImpl\(data,/.test(dbgBody) && !/data\.caller/.test(dbgBody));
check("W-2: registerBridgeFcmToken's handler delegates to registerBridgeFcmTokenImpl and never reads data.caller", /registerBridgeFcmTokenImpl\(data,/.test(regBody) && !/data\.caller/.test(regBody));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
