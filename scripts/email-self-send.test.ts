// WHAT:       Offline guard suite for the D4b recipient-scoped, three-tier agent email gate: tier
//             resolution, recipient extraction/normalisation, the empty-recipient vacuous truth, the
//             verbatim-mention boundary, and every fail-closed path.
// WHY:        The gate decides whether real mail leaves the tenant. Its predecessor was global -- the
//             owner could not receive his own digest without also enabling third-party send. Owner,
//             2026-09-07: "default self send email should be von.ellis@.... tiggapoohtv can be
//             excluded and dev@ is typically the send from Emily but I may explicitly ask to send to
//             it." Every criterion asserted here is mutation-proved in the FIX doc: an authorisation
//             guard nobody can prove is worse than none, because it is believed.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   nexus-hub docs/cross-app-agent/AC-email-self-send.md (38 independent criteria) and
//             docs/cross-app-agent/FIX-email-self-send.md (mutation table, verbatim outcomes)
//
// Run:  npm run test:email-gate     (bun scripts/email-self-send.test.ts)
// No network, no database, no API spend, no board writes, and NO POSSIBILITY OF MAIL BEING SENT: the
// module under test is pure and never touches Graph.

import {
  NEVER_SELF_ADDRESSES,
  classifySendScope,
  collectRecipients,
  draftReasonSentence,
  mentionsAddressVerbatim,
  normalizeAddress,
  resolveTier,
  splitRecipientField,
  type SelfEmailRow,
} from "../src/features/huddle/lib/email/self-send-gate";

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

// The owner's real profile, as read live from identity.profile_emails on 2026-09-07.
const AUTO_ADDR = "von.ellis@enterpriseds.io";
const ONREQ_ADDR = "dev@enterpriseds.io";
const EXCLUDED_ADDR = "tiggapoohtv@yahoo.com";
const SELF_ROWS: SelfEmailRow[] = [
  { email: AUTO_ADDR, source: "entra" },
  { email: ONREQ_ADDR, source: "manual" },
];
const OK = { selfRows: SELF_ROWS, tiersReadable: true } as const;

function scope(over: Partial<Parameters<typeof classifySendScope>[0]> = {}) {
  return classifySendScope({ selfRows: SELF_ROWS, tiersReadable: true, ...over });
}

console.log("\n--- 1. Tier resolution & data model (AC-1..AC-6) ---");

check(
  "AC-1a: the entra-source primary derives AUTO with no explicit policy",
  resolveTier(AUTO_ADDR, OK) === "auto",
  resolveTier(AUTO_ADDR, OK),
);
check(
  "AC-1b: a manual-source alias derives ON-REQUEST, never AUTO",
  resolveTier(ONREQ_ADDR, OK) === "on-request",
  resolveTier(ONREQ_ADDR, OK),
);
check(
  "AC-2: an address absent from profile_emails is THIRD-PARTY",
  resolveTier("random@external.com", OK) === "third-party",
  resolveTier("random@external.com", OK),
);
check(
  "AC-3a: the excluded address is EXCLUDED even though it is absent from profile_emails",
  resolveTier(EXCLUDED_ADDR, OK) === "excluded",
  resolveTier(EXCLUDED_ADDR, OK),
);
// AC-3's own mutation: insert a synthetic entra-source profile_emails row for the excluded address.
// A "happens to be absent from the table" implementation would now return AUTO.
check(
  "AC-3b: still EXCLUDED even with an entra-source profile_emails row inserted for it",
  resolveTier(EXCLUDED_ADDR, {
    selfRows: [...SELF_ROWS, { email: EXCLUDED_ADDR, source: "entra" }],
    tiersReadable: true,
  }) === "excluded",
);
check(
  "AC-3c: still EXCLUDED even when the tier map explicitly tries to promote it to auto",
  resolveTier(EXCLUDED_ADDR, {
    selfRows: [...SELF_ROWS, { email: EXCLUDED_ADDR, source: "entra" }],
    tierMap: { [EXCLUDED_ADDR]: "auto" },
    tiersReadable: true,
  }) === "excluded",
);
check(
  "AC-4: a readable-but-EMPTY tier map leaves ONLY the entra primary AUTO (never all rows AUTO)",
  resolveTier(AUTO_ADDR, { selfRows: SELF_ROWS, tierMap: {}, tiersReadable: true }) === "auto" &&
    resolveTier(ONREQ_ADDR, { selfRows: SELF_ROWS, tierMap: {}, tiersReadable: true }) ===
      "on-request",
);
check(
  "AC-5: an UNREADABLE tier map demotes every address -- nothing is AUTO",
  resolveTier(AUTO_ADDR, { selfRows: SELF_ROWS, tiersReadable: false }) === "third-party" &&
    resolveTier(ONREQ_ADDR, { selfRows: SELF_ROWS, tiersReadable: false }) === "third-party",
);
check(
  "AC-6: an EMPTY self set (profile_emails unreadable) makes even the primary THIRD-PARTY",
  resolveTier(AUTO_ADDR, { selfRows: [], tiersReadable: true }) === "third-party",
);
check(
  "AC-2b: a stray tier-map entry cannot promote a stranger's address to self",
  resolveTier("stranger@external.com", {
    selfRows: SELF_ROWS,
    tierMap: { "stranger@external.com": "auto" },
    tiersReadable: true,
  }) === "third-party",
);
check(
  "the tier map may DEMOTE a known self address to excluded (data may add an exclusion)",
  resolveTier(ONREQ_ADDR, {
    selfRows: SELF_ROWS,
    tierMap: { [ONREQ_ADDR]: "excluded" },
    tiersReadable: true,
  }) === "excluded",
);
check(
  "the tier map may PROMOTE a known manual alias to auto (the owner's documented lever)",
  resolveTier(ONREQ_ADDR, {
    selfRows: SELF_ROWS,
    tierMap: { [ONREQ_ADDR]: "auto" },
    tiersReadable: true,
  }) === "auto",
);
check("NEVER_SELF_ADDRESSES actually contains the address the owner excluded", NEVER_SELF_ADDRESSES.includes(EXCLUDED_ADDR));

console.log("\n--- 2. Recipient extraction & the vacuous-truth trap (AC-7..AC-12) ---");

// AC-7 / failure mode #1: [].every(...) === true in JS. If the gate is a bare .every() this is "send".
check(
  "AC-7a: NO recipients is 'no-recipients', NOT 'send' (the vacuous-truth guard)",
  scope({ to: "" }).decision === "no-recipients",
  scope({ to: "" }).decision,
);
check(
  "AC-7b: to/cc/bcc all omitted is 'no-recipients', NOT 'send'",
  scope({}).decision === "no-recipients",
  scope({}).decision,
);
check(
  "AC-7c: a whitespace-only / comma-only recipient field is still 'no-recipients'",
  scope({ to: "  ,  , " }).decision === "no-recipients",
  scope({ to: "  ,  , " }).decision,
);
check(
  "AC-7d: JS really does return true for [].every -- the trap this guard exists for",
  ([] as string[]).every(() => false) === true,
);
check(
  "AC-8a: display-name form resolves to the bare address",
  normalizeAddress(`Von Ellis <${AUTO_ADDR}>`) === AUTO_ADDR,
  normalizeAddress(`Von Ellis <${AUTO_ADDR}>`),
);
check(
  "AC-8b: angle-bracket-only form resolves",
  normalizeAddress(`<${AUTO_ADDR}>`) === AUTO_ADDR,
);
check(
  "AC-8c: trailing-parenthetical form resolves",
  normalizeAddress(`${AUTO_ADDR} (Von Ellis)`) === AUTO_ADDR,
  normalizeAddress(`${AUTO_ADDR} (Von Ellis)`),
);
check(
  "AC-8d: a display-name recipient still classifies AUTO end to end",
  scope({ to: `Von Ellis <${AUTO_ADDR}>` }).decision === "send",
);
check(
  "AC-9: mixed case + surrounding whitespace normalises and sends",
  scope({ to: "   VON.ELLIS@EnterpriseDS.io  " }).decision === "send",
);
check(
  "AC-10a: a comma-joined string is split into separate recipients",
  splitRecipientField("a@x.com, b@y.com").length === 2,
);
check(
  "AC-10b: 'self,third-party' as ONE comma string is BLOCKED, not one opaque blob",
  (() => {
    const s = scope({ to: `${AUTO_ADDR},thirdparty@external.com` });
    return s.decision === "draft" && s.recipients.length === 2;
  })(),
);
check(
  "AC-11: the same address twice in different case counts as ONE recipient",
  collectRecipients({ to: `${AUTO_ADDR}, ${AUTO_ADDR.toUpperCase()} ` }).length === 1,
  String(collectRecipients({ to: `${AUTO_ADDR}, ${AUTO_ADDR.toUpperCase()} ` }).length),
);
check(
  "AC-12a: a malformed entry is KEPT as a blocking recipient, never silently dropped",
  (() => {
    const s = scope({ to: `${AUTO_ADDR}, not-an-email` });
    return s.decision === "draft" && s.recipients.length === 2 && s.blocked.length === 1;
  })(),
);
check(
  "AC-12b: a bare '@' does not normalise to an address",
  normalizeAddress("@") === "" && normalizeAddress("not-an-email") === "",
);
check(
  "AC-12c: a malformed-only recipient list drafts (it is not 'no-recipients')",
  scope({ to: "not-an-email" }).decision === "draft",
  scope({ to: "not-an-email" }).decision,
);

console.log("\n--- 3. Tier behaviour end to end (AC-13..AC-21) ---");

check("AC-13: AUTO address alone SENDS", scope({ to: AUTO_ADDR }).decision === "send");
check(
  "AC-14: ON-REQUEST address alone DRAFTS when the owner did not name it",
  scope({ to: ONREQ_ADDR, ownerTurnText: "email me the weekly summary" }).decision === "draft",
);
check(
  "AC-15: ON-REQUEST address SENDS when the owner named it verbatim",
  scope({ to: ONREQ_ADDR, ownerTurnText: `send that to ${ONREQ_ADDR} please` }).decision === "send",
);
check(
  "AC-15b: the verbatim match is case-insensitive on both sides",
  scope({ to: ONREQ_ADDR, ownerTurnText: "send it to DEV@EnterpriseDS.IO" }).decision === "send",
);
// AC-16: the agent's own text must never be a source of authorisation. The only way to pass text into
// this function is `ownerTurnText`; a caller that has no owner text passes null and gets a draft.
check(
  "AC-16: with NO owner turn text (the only thing an agent could not fake), ON-REQUEST drafts",
  scope({ to: ONREQ_ADDR, ownerTurnText: null }).decision === "draft",
);
check(
  "AC-17a: the address inside a longer URL is NOT a mention",
  mentionsAddressVerbatim(`see http://${ONREQ_ADDR}.tracker.example/click`, ONREQ_ADDR) === false,
);
check(
  "AC-17b: the address as a URL userinfo component is NOT a mention (deliberate, fail closed)",
  mentionsAddressVerbatim(`check https://${ONREQ_ADDR}/inbox`, ONREQ_ADDR) === false,
);
check(
  "AC-18: a LONGER address containing the self address as a substring is NOT a mention",
  mentionsAddressVerbatim(
    `not.${AUTO_ADDR}.contractor.example is the one`,
    AUTO_ADDR,
  ) === false,
);
check(
  "AC-18b: the plain, correctly-bounded mention still matches (the guard is not vacuous)",
  mentionsAddressVerbatim(`please cc ${AUTO_ADDR}, thanks`, AUTO_ADDR) === true,
);
check(
  "AC-18c: a mention at the very start and very end of the text matches",
  mentionsAddressVerbatim(ONREQ_ADDR, ONREQ_ADDR) === true,
);
check(
  "AC-19: EXCLUDED never sends, even when the owner names it verbatim",
  scope({ to: EXCLUDED_ADDR, ownerTurnText: `send it to ${EXCLUDED_ADDR}` }).decision === "draft",
);
check(
  "AC-20: naming a THIRD PARTY verbatim does NOT send -- mention is an on-request lever only",
  scope({
    to: "someone@external.com",
    ownerTurnText: "email someone@external.com the summary",
  }).decision === "draft",
);

console.log("\n--- 4. Mixed recipients across to / cc / bcc (AC-22..AC-26) ---");

check(
  "AC-22: self in to + third party in CC drafts the whole message",
  scope({ to: AUTO_ADDR, cc: "someone@external.com" }).decision === "draft",
);
check(
  "AC-23: self in to + third party in BCC drafts the whole message",
  scope({ to: AUTO_ADDR, bcc: "someone@external.com" }).decision === "draft",
  scope({ to: AUTO_ADDR, bcc: "someone@external.com" }).decision,
);
check(
  "AC-23b: the blocked recipient named in the reason is the BCC one",
  scope({ to: AUTO_ADDR, bcc: "someone@external.com" }).blocked[0]?.address ===
    "someone@external.com",
);
check(
  "AC-24: AUTO in to + ON-REQUEST in cc, not named, drafts",
  scope({ to: AUTO_ADDR, cc: ONREQ_ADDR, ownerTurnText: "send the digest" }).decision === "draft",
);
check(
  "AC-25: AUTO in to + ON-REQUEST in cc, named verbatim, sends",
  scope({ to: AUTO_ADDR, cc: ONREQ_ADDR, ownerTurnText: `cc ${ONREQ_ADDR} on it` }).decision ===
    "send",
);
check(
  "AC-26: both self addresses as ONE comma string, on-request named, sends",
  scope({
    to: `${AUTO_ADDR}, ${ONREQ_ADDR}`,
    ownerTurnText: `send to both, including ${ONREQ_ADDR}`,
  }).decision === "send",
);
check(
  "AC-26b: both self addresses as ONE comma string, on-request NOT named, drafts",
  scope({ to: `${AUTO_ADDR}, ${ONREQ_ADDR}`, ownerTurnText: "send to both" }).decision === "draft",
);
check(
  "an array-valued recipient field is swept too (SendEmailInput allows string[])",
  scope({ to: [AUTO_ADDR, "someone@external.com"] }).decision === "draft",
);

console.log("\n--- 5. Fail-closed paths (AC-30..AC-34) ---");

check(
  "AC-30: no resolvable caller (empty self set) drafts even to the primary",
  classifySendScope({ to: AUTO_ADDR, selfRows: [], tiersReadable: true }).decision === "draft",
);
check(
  "AC-31: an unreadable tier policy drafts even to the primary",
  classifySendScope({ to: AUTO_ADDR, selfRows: SELF_ROWS, tiersReadable: false }).decision ===
    "draft",
);
check(
  "AC-32: a surface with no owner turn text can still send to AUTO (and only AUTO)",
  scope({ to: AUTO_ADDR, ownerTurnText: null }).decision === "send" &&
    scope({ to: ONREQ_ADDR, ownerTurnText: null }).decision === "draft",
);
check(
  "the draft explanation names the offending address so the agent can be truthful",
  draftReasonSentence(scope({ to: "someone@external.com" }).blocked).includes(
    "someone@external.com",
  ),
  draftReasonSentence(scope({ to: "someone@external.com" }).blocked),
);
check(
  "the on-request refusal explains WHY, not just that it failed",
  (scope({ to: ONREQ_ADDR }).blocked[0]?.reason ?? "").includes("name that address yourself"),
  scope({ to: ONREQ_ADDR }).blocked[0]?.reason ?? "",
);

console.log("\n--- 6. Wiring, asserted against SOURCE (AC-16, AC-27, AC-28, AC-33) ---");

// runHuddleTurn cannot be invoked offline without a model, so its wiring is asserted the same way
// voice-toolset-hidden.test.ts Part 4e asserts the D4a gates: lexically. Weaker than a runtime check,
// still mutation-sensitive -- deleting the freeze, or handing the voice path owner text, fails here.
const turnSrc = await Bun.file(
  new URL("../src/features/huddle/lib/huddle.functions.ts", import.meta.url),
).text();
const turnLines = turnSrc.split("\n");
const freezeIdx = turnLines.findIndex((l) =>
  l.includes("const ownerTurnText: string = String(data.text ?? \"\")"),
);
const reassignIdx = turnLines.findIndex((l) => l.trim() === "data.text = pending.askText;");

check(
  "AC-33a: the owner's turn text is frozen into a const, not read at send time",
  freezeIdx >= 0,
  `freeze at line ${freezeIdx + 1}`,
);
check(
  "AC-33b: the freeze happens BEFORE the deep-confirm path reassigns data.text",
  freezeIdx >= 0 && reassignIdx >= 0 && freezeIdx < reassignIdx,
  `freeze line ${freezeIdx + 1}, reassign line ${reassignIdx + 1}`,
);
check(
  "AC-27a: BOTH text dispatch sites hand the frozen owner text to the send path",
  (turnSrc.match(/^\s*ownerTurnText,$/gm) ?? []).length === 2,
  `found ${(turnSrc.match(/^\s*ownerTurnText,$/gm) ?? []).length}`,
);
check(
  "AC-27b: BOTH text dispatch sites call sendOrDraftEmail, not sendGraphEmail directly",
  (turnSrc.match(/sendOrDraftEmail\(\{/g) ?? []).length === 2 &&
    !/const \{ sendGraphEmail \} = await import\("\.\/email\/graph-email\.server"\)/.test(turnSrc),
  `sendOrDraftEmail calls: ${(turnSrc.match(/sendOrDraftEmail\(\{/g) ?? []).length}`,
);

const voiceSrc = await Bun.file(
  new URL("../src/features/huddle/lib/voice/realtime-tools.server.ts", import.meta.url),
).text();
const voiceSendBlock = voiceSrc.slice(
  voiceSrc.indexOf('if (name === "send_email")'),
  voiceSrc.indexOf('if (name === "create_email_draft")'),
);
check(
  "AC-28a: the voice send path exists and routes through sendOrDraftEmail",
  voiceSendBlock.includes("sendOrDraftEmail({"),
);
// AC-28/AC-16 and failure mode #3: the voice surface has no owner words, and the model-authored
// `args.body`/`args.subject` must never be smuggled in as a stand-in for them.
// Comments in that block DISCUSS ownerTurnText at length (explaining why it is withheld), so the
// assertion must read CODE, not prose -- strip line comments before looking for an actual argument.
const voiceSendCode = voiceSendBlock
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
check(
  "AC-28b: the voice send path passes NO ownerTurnText argument (fail closed for on-request)",
  !/ownerTurnText\s*[,:]/.test(voiceSendCode),
  "voice passes ownerTurnText -- model output on the authorisation path",
);
check(
  "AC-28c: the voice send path never treats args.body/args.subject as owner intent",
  !/ownerTurnText\s*:\s*String\(args\./.test(voiceSendCode),
);

console.log("\n--- 7. The real orchestrator, run for real (no network, no mail) ---");

// This is the one RUNTIME assertion on the wiring rather than the pure core. It calls the actual
// sendOrDraftEmail with no caller identity and a third-party recipient -- the shape of an agent trying
// to mail a stranger -- and proves it can never come back ok:true. Offline there are no Graph
// credentials, so getAppToken throws BEFORE any fetch: nothing is sent, nothing is drafted, no
// network call is made. The wire is watched to prove that rather than assumed.
{
  let graphCallAttempted = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url,
    );
    if (url.includes("microsoftonline.com") || url.includes("graph.microsoft.com")) {
      graphCallAttempted = true;
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;

  const { sendOrDraftEmail } = await import("../src/features/huddle/lib/email/graph-email.server");
  const r = await sendOrDraftEmail({
    to: "someone@external.com",
    subject: "Test-D4b third-party recipient must never send",
    body: "should never leave the tenant",
  });
  globalThis.fetch = realFetch;

  check(
    "AC-20/AC-30 runtime: sendOrDraftEmail NEVER returns ok:true for a third party with no caller",
    r.ok === false,
    `ok = ${String(r.ok)}`,
  );
  check(
    "runtime: it made no Graph call at all in this offline configuration",
    graphCallAttempted === false,
  );
  check(
    "runtime: the result explains itself rather than throwing",
    typeof r.error === "string" && r.error.length > 0,
    (r.error ?? "").slice(0, 100),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
