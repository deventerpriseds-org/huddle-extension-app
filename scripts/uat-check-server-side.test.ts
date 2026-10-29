// WHAT:       Offline guard suite for the server-side UAT sign-in check: the secret never reaches the
//             browser build, the server compare answers a bare boolean, and the browser only asks the
//             server when `?uat_token=` is actually in the URL.
// WHY:        deploy-swa.yml used to write VITE_UAT_BYPASS_TOKEN=<org secret> into the build env, so
//             Vite inlined a Nexus-accepted write credential into the public bundle. Each guard below
//             is mutation-proved in docs/FIX-uat-check-server-side.md.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/FIX-uat-check-server-side.md
//
// Run:  npm run test:uat-server-check   (bun scripts/uat-check-server-side.test.ts)
// No network: every function under test is pure or takes an injected fake.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkUatTokenServer, matchUatToken, UAT_TOKEN_ENV } from "../src/lib/uat-bypass.server";
import { hasUatTokenParam, resolveUatBypassFromUrl } from "../src/lib/uat-bypass-url";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const ROOT = join(import.meta.dir, "..");
const LEAKY = "VITE_" + "UAT_BYPASS_TOKEN"; // split so this file does not match its own grep

// ── (a) the secret is never handed to the client build ─────────────────────────────────────────
console.log("(a) no client-side copy of the secret");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|html)$/.test(name)) out.push(p);
  }
  return out;
}
const srcHits = walk(join(ROOT, "src")).filter((f) => readFileSync(f, "utf8").includes(LEAKY));
check("A1 no src/ file mentions the VITE_ copy of the token", srcHits.length === 0, srcHits.join(", "));
const envUatReaders = walk(join(ROOT, "src")).filter((f) =>
  /import\.meta\.env\.[A-Z_]*UAT/.test(readFileSync(f, "utf8")),
);
check("A2 no src/ file reads any import.meta.env.*UAT* value", envUatReaders.length === 0, envUatReaders.join(", "));

const deploy = readFileSync(join(ROOT, ".github/workflows/deploy-swa.yml"), "utf8");
check("A3 deploy-swa.yml never mentions the VITE_ copy of the token", !deploy.includes(LEAKY));
const envProd = deploy.slice(deploy.indexOf("Register redirect URI"), deploy.indexOf("> .env.production"));
check(
  "A4 the .env.production (client build env) block carries no UAT secret",
  envProd.length > 0 && !/UAT/.test(envProd),
);
const appSettings = deploy.slice(deploy.indexOf("az staticwebapp appsettings set"), deploy.indexOf("- name: Deploy to Static Web Apps"));
check(
  "A5 UAT_BYPASS_TOKEN is synced to the SWA SERVER app settings from the existing org secret",
  /UAT_BYPASS_TOKEN="\$\{\{ secrets\.UAT_BYPASS_TOKEN \}\}" \\\n/.test(appSettings),
);

// ── (b) the server compare ─────────────────────────────────────────────────────────────────────
console.log("(b) server-side compare");
const TOKEN = "uat-test-token-7f3c9a1e5b";
check("B1 exact match -> true", matchUatToken(TOKEN, TOKEN) === true);
check("B2 wrong token -> false", matchUatToken("nope", TOKEN) === false);
check("B3 prefix of the token -> false", matchUatToken(TOKEN.slice(0, -1), TOKEN) === false);
check("B4 token plus a suffix -> false", matchUatToken(TOKEN + "x", TOKEN) === false);
check("B5 case-changed token -> false", matchUatToken(TOKEN.toUpperCase(), TOKEN) === false);
check("B6 empty supplied -> false", matchUatToken("", TOKEN) === false);
check("B7 non-string supplied -> false", matchUatToken({ token: TOKEN }, TOKEN) === false);
check("B8 setting unset -> false even for an empty supplied value", matchUatToken("", undefined) === false);
check("B9 setting empty string -> false", matchUatToken("", "") === false);
check("B10 oversized supplied -> false", matchUatToken("a".repeat(10_000), "a".repeat(10_000)) === false);
check(
  "B11 reads the server env var by name",
  UAT_TOKEN_ENV === "UAT_BYPASS_TOKEN" &&
    checkUatTokenServer(TOKEN, { UAT_BYPASS_TOKEN: TOKEN }) === true &&
    checkUatTokenServer(TOKEN, {}) === false,
);
const answers = [checkUatTokenServer(TOKEN, { UAT_BYPASS_TOKEN: TOKEN }), checkUatTokenServer("x", { UAT_BYPASS_TOKEN: TOKEN })];
check(
  "B12 the answer is a bare boolean and serialises to nothing but true/false",
  answers.every((a) => typeof a === "boolean") && JSON.stringify(answers) === "[true,false]",
);
const fnSrc = readFileSync(join(ROOT, "src/lib/uat-bypass.functions.ts"), "utf8");
check(
  "B13 the server function returns only the boolean (=== true), never the env or the input",
  /return checkUatTokenServer\(data\.token\) === true;/.test(fnSrc) &&
    !/process\.env/.test(fnSrc) &&
    !/return\s+data/.test(fnSrc),
);

// ── (c) the browser only asks when the param is present ──────────────────────────────────────
console.log("(c) client asks the server only when ?uat_token= is present");
function fakeHost(search: string) {
  const log: string[] = [];
  const host = {
    location: { search, pathname: "/", hash: "#h" },
    history: {
      replaceState: (_d: unknown, _u: string, url?: string) => {
        log.push(`replace:${url}`);
        const q = (url ?? "").split("?")[1]?.split("#")[0] ?? "";
        host.location.search = q ? `?${q}` : "";
      },
    },
  };
  return { host, log };
}

{
  const { host, log } = fakeHost("?huddle=dm-terry-locke");
  let calls = 0;
  const r = await resolveUatBypassFromUrl(host, async () => {
    calls++;
    return true;
  });
  check("C1 no uat_token -> server never called, false, URL untouched", calls === 0 && r === false && log.length === 0);
}
{
  const { host } = fakeHost("");
  let calls = 0;
  const r = await resolveUatBypassFromUrl(host, async () => {
    calls++;
    return true;
  });
  check("C2 empty query -> server never called", calls === 0 && r === false);
}
{
  const { host } = fakeHost("?uat_token=");
  let calls = 0;
  await resolveUatBypassFromUrl(host, async () => {
    calls++;
    return true;
  });
  check("C3 empty uat_token value -> server never called", calls === 0);
}
{
  const { host, log } = fakeHost(`?uat_token=${TOKEN}&huddle=dm-flex-grimes`);
  const seen: string[] = [];
  const r = await resolveUatBypassFromUrl(host, async (t) => {
    seen.push(t);
    log.push(`verify-saw-search:${host.location.search}`);
    return true;
  });
  check("C4 present -> server called exactly once with the supplied value", seen.length === 1 && seen[0] === TOKEN);
  check("C5 server says true -> bypass active", r === true);
  check(
    "C6 token stripped from the URL BEFORE the server call, other params kept",
    log[0] === "replace:/?huddle=dm-flex-grimes#h" && log[1] === "verify-saw-search:?huddle=dm-flex-grimes",
    log.join(" | "),
  );
}
{
  const { host, log } = fakeHost(`?uat_token=wrong`);
  const r = await resolveUatBypassFromUrl(host, async () => false);
  check("C7 server says false -> not active, token still stripped", r === false && log[0] === "replace:/#h");
}
{
  const { host } = fakeHost(`?uat_token=${TOKEN}`);
  const r = await resolveUatBypassFromUrl(host, async () => {
    throw new Error("network");
  });
  check("C8 server/network error -> false (falls through to normal sign-in), no throw", r === false);
}
{
  const { host } = fakeHost(`?uat_token=${TOKEN}`);
  const r = await resolveUatBypassFromUrl(host, async () => "true");
  check("C9 a non-boolean truthy answer is NOT treated as a match", r === false);
}
check("C10 hasUatTokenParam detects presence only", hasUatTokenParam("?uat_token=x") && !hasUatTokenParam("?huddle=x") && !hasUatTokenParam("?uat_token="));

const auth = readFileSync(join(ROOT, "src/lib/entra-auth.ts"), "utf8");
const startFn = auth.slice(auth.indexOf("function startUatCheck"), auth.indexOf("function checkUatBypass"));
check(
  "C11 entra-auth gates the server-fn import on the param check (no import/request on normal loads)",
  startFn.indexOf("!hasUatTokenParam(window.location.search)) return null") > -1 &&
    startFn.indexOf("!hasUatTokenParam(window.location.search)) return null") <
      startFn.indexOf('import("@/lib/uat-bypass.functions")'),
);
check(
  "C12 entra-auth has no static import of the server function module",
  !/^import[^\n]*uat-bypass\.functions/m.test(auth),
);
const initFn = auth.slice(auth.indexOf("export function initMsal"), auth.indexOf("function initMsalCore"));
check(
  "C13 initMsal: normal load goes straight to the unchanged MSAL path",
  /return initMsalCore\(\);\n\}/.test(initFn),
);
check(
  "C14 initMsal: a rejected/failed UAT check falls through to the real MSAL sign-in",
  /if \(uatCheck\) return uatCheck\.then\(\(matched\) => \(matched \? undefined : initMsalCore\(\)\)\);/.test(initFn),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
