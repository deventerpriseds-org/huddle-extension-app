// WHAT:       Pins the two halves of turning the composer bell ON (owner 2026-10-19, option B):
//             a browser that already GRANTED permission but has no push subscription subscribes on
//             load (it was granted while the server had no VAPID keys, so nothing was ever saved), and
//             the key-setup workflow stores both keys without printing the private one.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   Run: bun scripts/push-heal.test.ts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
const hook = readFileSync("src/features/huddle/hooks/usePush.ts", "utf8");
check("B1 on load with permission granted, a missing subscription is CREATED, not skipped",
  /const sub = \(await reg\.pushManager\.getSubscription\(\)\) \?\? \(await subscribeWithServerKey\(reg\)\);\s*if \(sub && !cancelled\) await persist\(sub, caller\);/.test(hook));
check("B2 subscribing needs the server's public key and gives up cleanly without one",
  /const \{ vapidPublicKey \} = await getPushConfig\(\);\s*if \(!vapidPublicKey\) return null;/.test(hook));
const wf = readFileSync(".github/workflows/vapid-keys.yml", "utf8");
check("B3 workflow stores BOTH secrets", /gh secret set VAPID_PUBLIC_KEY/.test(wf) && /gh secret set VAPID_PRIVATE_KEY/.test(wf));
check("B4 the private key is masked and never echoed", /::add-mask::\$\(cat \/tmp\/vapid_priv\)/.test(wf) && !/cat \/tmp\/vapid_priv\s*$/m.test(wf.replace(/::add-mask::\$\(cat \/tmp\/vapid_priv\)/, "")));
check("B5 existing keys are not rotated without force", /HAS_PUBLIC" = "true" \] && \[ "\$\{\{ inputs\.force \}\}" != "true" \]/.test(wf));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
