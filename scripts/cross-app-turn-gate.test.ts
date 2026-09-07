// WHAT:       Offline guard suite for the D-16 cross-app agent-turn gate -- the authentication,
//             the acting-subject resolution, the caller-asserted-identity refusal, the input
//             adapter and the response projection behind POST /api/public/run-agent-turn.
// WHY:        The route decides an AUTHORISATION gate. Its predecessor (the anonymous
//             `sendHuddleMessage` server function) let any caller name the acting user in the body
//             -- measured in BATCH-5-RESULTS.md test 5.2 as HTTP 200 with no credential sent. Every
//             guard that closes that hole is asserted here so it can be mutation-proved: an auth
//             guard nobody can prove is worse than none, because it is believed.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   nexus-hub docs/cross-app-agent/AC-run-agent-turn.md (46 independent criteria) and
//             docs/cross-app-agent/FIX-run-agent-turn.md (mutation outcomes, verbatim).
//
// Run:  npm run test:cross-app     (bun scripts/cross-app-turn-gate.test.ts)
// No network, no API spend, no board writes: every function under test is pure, and the turn itself
// is never invoked -- so this suite cannot create a task, a reminder or a memory row.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  MAX_BODY_BYTES,
  SUBJECT_ENV,
  TEXT_MAX,
  authenticateCaller,
  buildTurnInput,
  defaultMembers,
  findCallerAssertedIdentity,
  normalizeKey,
  projectTurnResult,
  resolveActingSubject,
} from "../src/features/huddle/lib/cross-app/turn-gate";
import { AGENTS } from "../src/features/huddle/data/agents";

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

function headers(map: Record<string, string> = {}) {
  return {
    get(name: string): string | null {
      const k = Object.keys(map).find((x) => x.toLowerCase() === name.toLowerCase());
      return k === undefined ? null : map[k];
    },
  };
}

const SECRET = "s3cret-shared-token";
const SUBJECT = "owner@example.test";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------- A. authentication (AC-1..AC-9)
console.log("\nA. authentication");

check(
  "A1 JOURNEY_PROXY_TOKEN unset -> 503 not_configured (fail closed, never 'no auth required')",
  withEnv({ JOURNEY_PROXY_TOKEN: undefined }, () => {
    const r = authenticateCaller(headers({ "x-webhook-secret": "anything" }));
    return !r.ok && r.status === 503 && r.error === "not_configured";
  }),
);

check(
  "A2 JOURNEY_PROXY_TOKEN empty string -> 503, NOT 'the correct secret is the empty string'",
  withEnv({ JOURNEY_PROXY_TOKEN: "" }, () => {
    const noHeader = authenticateCaller(headers({}));
    const emptyHeader = authenticateCaller(headers({ "x-webhook-secret": "" }));
    return (
      !noHeader.ok &&
      noHeader.status === 503 &&
      !emptyHeader.ok &&
      emptyHeader.status === 503
    );
  }),
);

check(
  "A3 correct secret -> passes (not 401, not 503)",
  withEnv({ JOURNEY_PROXY_TOKEN: SECRET }, () =>
    authenticateCaller(headers({ "x-webhook-secret": SECRET })).ok,
  ),
);

check(
  "A4 wrong / truncated / extended / case-variant / padded secrets ALL -> 401",
  withEnv({ JOURNEY_PROXY_TOKEN: SECRET }, () => {
    const guesses = [
      "wrong",
      SECRET.slice(0, SECRET.length - 1), // truncated -- a prefix check would let this in
      SECRET.slice(0, 3),
      SECRET + "x",
      SECRET.toUpperCase(),
      ` ${SECRET}`,
      `${SECRET} `,
      SECRET + "\0",
      "",
    ];
    return guesses.every((g) => {
      const r = authenticateCaller(headers({ "x-webhook-secret": g }));
      return !r.ok && r.status === 401 && r.error === "unauthorized";
    });
  }),
);

check(
  "A5 absent header and wrong header are INDISTINGUISHABLE (same status, same error)",
  withEnv({ JOURNEY_PROXY_TOKEN: SECRET }, () => {
    const absent = authenticateCaller(headers({}));
    const wrong = authenticateCaller(headers({ "x-webhook-secret": "nope" }));
    return (
      !absent.ok &&
      !wrong.ok &&
      absent.status === wrong.status &&
      absent.error === wrong.error &&
      absent.status === 401
    );
  }),
);

check(
  "A6 header lookup is case-insensitive (X-Webhook-Secret works, as the runtime delivers it)",
  withEnv({ JOURNEY_PROXY_TOKEN: SECRET }, () =>
    authenticateCaller(headers({ "X-Webhook-Secret": SECRET })).ok,
  ),
);

check("A7 body cap is declared and non-trivial", MAX_BODY_BYTES >= 1_000);

// ------------------------------------------------------- B. the acting subject (AC-11..AC-13, 16)
console.log("\nB. acting subject -- server-held, fail closed");

check(
  "B1 subject env unset -> 503 subject_not_configured, no turn possible",
  withEnv({ [SUBJECT_ENV]: undefined }, () => {
    const r = resolveActingSubject();
    return !r.ok && r.status === 503 && r.error === "subject_not_configured";
  }),
);

check(
  "B2 subject env blank/whitespace -> 503 (blank is not a subject)",
  withEnv({ [SUBJECT_ENV]: "   " }, () => {
    const r = resolveActingSubject();
    return !r.ok && r.status === 503;
  }),
);

check(
  "B3 subject env set -> resolves to exactly that value, trimmed",
  withEnv({ [SUBJECT_ENV]: `  ${SUBJECT}  ` }, () => {
    const r = resolveActingSubject();
    return r.ok && r.value.entra_email === SUBJECT;
  }),
);

check(
  "B4 two sequential resolutions are byte-identical (stable, deterministic subject)",
  withEnv({ [SUBJECT_ENV]: SUBJECT }, () => {
    const a = resolveActingSubject();
    const b = resolveActingSubject();
    return a.ok && b.ok && JSON.stringify(a.value) === JSON.stringify(b.value);
  }),
);

// ------------------------------------------- C. THE MASTER INVARIANT -- identity is body-immune
console.log("\nC. master invariant -- the subject is a pure function of server config (AC-10)");

// Deliberately includes spellings the block-list does NOT carry (emailAddress, loginHint,
// requestedBy, ctx.person.mail) -- the invariant must hold for names nobody anticipated, because a
// block-list that is only tested against its own entries proves nothing.
const SPOOF_BODIES: [string, Record<string, unknown>][] = [
  ["bare", { text: "hello" }],
  ["top-level caller", { text: "hello", caller: { entra_email: "attacker@evil.test" } }],
  ["top-level entra_email", { text: "hello", entra_email: "attacker@evil.test" }],
  ["top-level email", { text: "hello", email: "attacker@evil.test" }],
  ["nested context.caller", { text: "hello", context: { caller: { entra_email: "attacker@evil.test" } } }],
  ["cased Caller", { text: "hello", Caller: { EntraEmail: "attacker@evil.test" } }],
  ["screaming ENTRA_EMAIL", { text: "hello", ENTRA_EMAIL: "attacker@evil.test" }],
  ["runAs", { text: "hello", runAs: "attacker@evil.test" }],
  ["on_behalf_of", { text: "hello", on_behalf_of: "attacker@evil.test" }],
  ["array-nested", { text: "hello", items: [{ caller: { entra_email: "attacker@evil.test" } }] }],
  ["UNLISTED emailAddress", { text: "hello", emailAddress: "attacker@evil.test" }],
  ["UNLISTED loginHint", { text: "hello", loginHint: "attacker@evil.test" }],
  ["UNLISTED requestedBy", { text: "hello", requestedBy: "attacker@evil.test" }],
  ["UNLISTED ctx.person.mail", { text: "hello", ctx: { person: { mail: "attacker@evil.test" } } }],
];

check(
  "C1 buildTurnInput yields an IDENTICAL caller for all 14 body variants, listed or not",
  withEnv({ [SUBJECT_ENV]: SUBJECT }, () => {
    const subject = resolveActingSubject();
    if (!subject.ok) return false;
    const callers = SPOOF_BODIES.map(([, body]) => {
      const built = buildTurnInput(body, subject.value);
      return built.ok ? JSON.stringify(built.value.caller) : "REJECTED";
    });
    return callers.every((c) => c === JSON.stringify({ entra_email: SUBJECT }));
  }),
);

check(
  "C2 no attacker value appears ANYWHERE in the built turn input for any variant",
  withEnv({ [SUBJECT_ENV]: SUBJECT }, () => {
    const subject = resolveActingSubject();
    if (!subject.ok) return false;
    return SPOOF_BODIES.every(([, body]) => {
      const built = buildTurnInput(body, subject.value);
      if (!built.ok) return false;
      return !JSON.stringify(built.value).includes("attacker@evil.test");
    });
  }),
);

check(
  "C3 the caller survives a subject change -- it tracks CONFIG, not the body",
  (() => {
    const body = { text: "hello", caller: { entra_email: "attacker@evil.test" } };
    const a = withEnv({ [SUBJECT_ENV]: "one@example.test" }, () => {
      const s = resolveActingSubject();
      return s.ok ? buildTurnInput(body, s.value) : null;
    });
    const b = withEnv({ [SUBJECT_ENV]: "two@example.test" }, () => {
      const s = resolveActingSubject();
      return s.ok ? buildTurnInput(body, s.value) : null;
    });
    return (
      !!a?.ok &&
      !!b?.ok &&
      a.value.caller.entra_email === "one@example.test" &&
      b.value.caller.entra_email === "two@example.test"
    );
  })(),
);

// ------------------------------------------- D. loud refusal of caller-asserted identity (AC-14)
console.log("\nD. caller-asserted identity is refused uniformly");

const MUST_REFUSE: [string, unknown][] = SPOOF_BODIES.filter(
  ([label]) => label !== "bare" && !label.startsWith("UNLISTED"),
);

check(
  "D1 every listed identity spelling is detected, at any depth and any casing",
  MUST_REFUSE.every(([, body]) => findCallerAssertedIdentity(body) !== null),
  MUST_REFUSE.filter(([, b]) => findCallerAssertedIdentity(b) === null)
    .map(([l]) => l)
    .join(", "),
);

check(
  "D2 a body with no identity field is NOT refused (unknown ordinary fields tolerated, AC-31)",
  findCallerAssertedIdentity({ text: "hi", foo: "bar", nested: { x: 1 }, tags: ["a", "b"] }) === null,
);

check(
  "D3 detection is casing- and separator-independent for the SAME field (uniformity, AC-14)",
  ["caller", "Caller", "CALLER", "entra_email", "entra-email", "EntraEmail", "ENTRA_EMAIL"].every(
    (k) => findCallerAssertedIdentity({ text: "hi", [k]: "x" }) !== null,
  ),
);

check(
  "D4 normalizeKey collapses case and separators",
  normalizeKey("Entra-Email") === "entraemail" && normalizeKey("ENTRA_EMAIL") === "entraemail",
);

check(
  "D5 a deeply nested identity key is still found",
  findCallerAssertedIdentity({ a: { b: { c: { d: { caller: 1 } } } } }) !== null,
);

check(
  "D6 the reported field path names the offender and nothing else (leaks no subject value)",
  withEnv({ [SUBJECT_ENV]: SUBJECT }, () => {
    const hit = findCallerAssertedIdentity({ text: "hi", context: { caller: { entra_email: "a@b.c" } } });
    return hit === "context.caller" && !hit.includes(SUBJECT);
  }),
);

// ------------------------------------------------------------- E. input validation (AC-26..AC-35)
console.log("\nE. input validation and defaults");

const subjectFixture = { entra_email: SUBJECT };

check(
  "E1 missing text -> 400 missing_text",
  (() => {
    const r = buildTurnInput({}, subjectFixture);
    return !r.ok && r.status === 400 && r.error === "missing_text";
  })(),
);

check(
  "E2 empty text -> 400 (never a turn on empty content)",
  (() => {
    const r = buildTurnInput({ text: "" }, subjectFixture);
    return !r.ok && r.status === 400;
  })(),
);

check(
  "E3 non-string text -> 400",
  (() => {
    const r = buildTurnInput({ text: 42 }, subjectFixture);
    return !r.ok && r.status === 400;
  })(),
);

check(
  `E4 text at exactly ${TEXT_MAX} chars is accepted (the schema's own boundary, not a stricter one)`,
  (() => {
    const r = buildTurnInput({ text: "x".repeat(TEXT_MAX) }, subjectFixture);
    return r.ok && r.value.text.length === TEXT_MAX;
  })(),
);

check(
  `E5 text at ${TEXT_MAX + 1} chars is REFUSED, never silently truncated`,
  (() => {
    const r = buildTurnInput({ text: "x".repeat(TEXT_MAX + 1) }, subjectFixture);
    return !r.ok && r.status === 400 && r.error === "text_too_long";
  })(),
);

check(
  "E6 accepted text is passed through byte-for-byte (no trimming, no rewriting)",
  (() => {
    const text = "  Draft the plan.\n\nAnd @finn-reid check it.  ";
    const r = buildTurnInput({ text }, subjectFixture);
    return r.ok && r.value.text === text;
  })(),
);

check(
  "E7 a bare {text} body produces a COMPLETE turn input -- every Input-required field present",
  (() => {
    const r = buildTurnInput({ text: "hello" }, subjectFixture);
    if (!r.ok) return false;
    const v = r.value;
    return (
      typeof v.text === "string" &&
      typeof v.huddleId === "string" &&
      v.huddleId.length > 0 &&
      (v.scope === "group" || v.scope === "one-to-one") &&
      Array.isArray(v.members) &&
      v.members.length > 0 &&
      Array.isArray(v.history)
    );
  })(),
);

check(
  "E8 default members are non-empty and EVERY id exists in the live roster (z.enum(AgentIds) safe)",
  (() => {
    const ids = new Set(AGENTS.map((a) => a.id as string));
    const m = defaultMembers();
    return m.length > 0 && m.every((id) => ids.has(id));
  })(),
  `defaultMembers=${defaultMembers().length} roster=${AGENTS.length}`,
);

check(
  "E9 the defaulted huddleId is STABLE across calls (not a fresh conversation per request)",
  (() => {
    const a = buildTurnInput({ text: "one" }, subjectFixture);
    const b = buildTurnInput({ text: "two" }, subjectFixture);
    return a.ok && b.ok && a.value.huddleId === b.value.huddleId;
  })(),
);

check(
  "E10 caller-supplied huddleId/scope/members/timeZone are honoured when present",
  (() => {
    const r = buildTurnInput(
      {
        text: "hi",
        huddleId: "dm-terry-locke",
        scope: "one-to-one",
        members: ["terry-locke"],
        timeZone: "America/New_York",
      },
      subjectFixture,
    );
    return (
      r.ok &&
      r.value.huddleId === "dm-terry-locke" &&
      r.value.scope === "one-to-one" &&
      r.value.members.length === 1 &&
      r.value.timeZone === "America/New_York"
    );
  })(),
);

check(
  "E11 an empty members array falls back to the roster (never reaches Input's .min(1) as [])",
  (() => {
    const r = buildTurnInput({ text: "hi", members: [] }, subjectFixture);
    return r.ok && r.value.members.length > 0;
  })(),
);

// ------------------------------------------------------------- F. response projection (AC-38, 40)
console.log("\nF. response projection");

check(
  "F1 replies pass through; toolUses is projected to {agentId,tool,ok}",
  (() => {
    const p = projectTurnResult({
      replies: [{ agentId: "finn-reid", text: "done" }],
      toolUses: [{ agentId: "finn-reid", tool: "prioritize", ok: true, summary: `mailed ${SUBJECT}` }],
    });
    return (
      p.replies.length === 1 &&
      p.toolUses.length === 1 &&
      p.toolUses[0].tool === "prioritize" &&
      !("summary" in (p.toolUses[0] as object))
    );
  })(),
);

check(
  "F2 free-text model output that could quote the subject is NOT echoed back to the caller",
  (() => {
    const p = projectTurnResult({
      replies: [],
      toolUses: [{ tool: "x", ok: true, summary: `sent to ${SUBJECT}` }],
      prompts: [`you are acting for ${SUBJECT}`],
      reasoning: [`the owner is ${SUBJECT}`],
      suggestedTasks: [{ title: SUBJECT }],
    });
    return !JSON.stringify(p).includes(SUBJECT);
  })(),
);

check(
  "F3 a missing/garbage result never throws -- it projects to empty arrays",
  (() => {
    const a = projectTurnResult(undefined);
    const b = projectTurnResult({ replies: "nope", toolUses: 7 });
    return a.replies.length === 0 && b.replies.length === 0 && b.toolUses.length === 0;
  })(),
);

// -------------------------------------------------- G. structural / source-shape (AC-18, 22, 41-42)
console.log("\nG. structural guards on the route itself");

const ROUTE = "src/routes/api/public/run-agent-turn.ts";
const routeSrc = readFileSync(ROUTE, "utf8");
const gateSrc = readFileSync("src/features/huddle/lib/cross-app/turn-gate.ts", "utf8");

// Comments legitimately NAME the things these assertions forbid in CODE (the route's own header
// explains what `process.env.JOURNEY_PROXY_TOKEN` is, and cites the nexus-hub evidence files). An
// assertion that cannot tell code from prose reports a defect in the documentation as a defect in
// the product -- which is exactly what the first run of this suite did.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const routeCode = stripComments(routeSrc);
const gateCode = stripComments(gateSrc);


check(
  "G1 the route calls the EXISTING runHuddleTurn from huddle.functions",
  /runHuddleTurn/.test(routeSrc) && /@\/features\/huddle\/lib\/huddle\.functions/.test(routeSrc),
);

check(
  "G2 the route reimplements no part of the turn (no router, no tool dispatch, no model call)",
  !/generateText\(|callOpenAIResponses\(|routeMessage\(|assembleWinners\(|invokeJourneyTool\(/.test(
    stripComments(routeSrc),
  ),
);

check(
  "G3 no caller-app name anywhere in the route or the gate CODE (app-agnostic by construction)",
  !/nexus/i.test(routeCode) && !/nexus/i.test(gateCode),
);

// The ONE construction site, isolated from the type declaration that shares its shape.
const callerAssignments = gateCode
  .split("\n")
  .filter((l) => /caller:\s*\{\s*entra_email:/.test(l) && !/entra_email:\s*string\b/.test(l));

// The route's ONE call into the adapter, matched EXACTLY. An earlier version of this assertion
// searched for `payload.caller`-shaped reads with a regex, and a mutation that wrote
// `(payload as { caller?: ... }).caller?.entra_email` slipped straight through it -- reported INERT
// by mutate.sh, which is the whole reason that outcome exists. Pinning the call site is not
// evadable by a cast, a rename or a nested access: anything other than the subject the gate
// resolved changes this line.
const buildCallSites = routeCode
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.includes("buildTurnInput("));

check(
  "G4 `caller` is CONSTRUCTED exactly once, from the resolved subject, never from the body",
  callerAssignments.length === 1 &&
    /subject\.entra_email/.test(callerAssignments[0]) &&
    !/body|payload/.test(callerAssignments[0]) &&
    buildCallSites.length === 1 &&
    buildCallSites[0] === "const built = buildTurnInput(payload, subject.value);" &&
    // No identity is read out of the request anywhere in the route: no `.caller` property access
    // and no `caller:` object key survive comment-stripping. (`findCallerAssertedIdentity` and the
    // `caller_identity_not_accepted` code contain neither form.)
    !/\.\s*caller\b/.test(routeCode) &&
    !/\bcaller\s*:/.test(routeCode),
  `assignments=${callerAssignments.length} callSites=${JSON.stringify(buildCallSites)}`,
);

check(
  "G5 authentication reads exactly JOURNEY_PROXY_TOKEN -- no new auth secret is introduced",
  (gateCode.match(/process\.env\.JOURNEY_PROXY_TOKEN/g) || []).length === 1 &&
    !/process\.env\.(?!JOURNEY_PROXY_TOKEN)[A-Z_]*(TOKEN|SECRET|KEY)/.test(gateCode) &&
    !/process\.env\./.test(routeCode),
);

check(
  "G6 the identity-refusal behaviour is documented IN the route file (legible without a diff)",
  /caller_identity_not_accepted/.test(routeSrc) &&
    /IDENTITY-SHAPED BODY FIELDS ARE REFUSED/.test(routeSrc),
);

function gitShow(path: string, ref = "origin/main"): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
  } catch {
    return null;
  }
}

const SIBLINGS = [
  "tasks-sync",
  "run-ceremony",
  "run-autowork",
  "run-turn",
  "run-grooming",
  "run-standup",
  "run-review-digest",
  "run-review-recheck",
  "test-push",
  "auth-trace",
];
check(
  "G7 REGRESSION: not one existing public route file is modified",
  SIBLINGS.every((name) => {
    const p = `src/routes/api/public/${name}.ts`;
    const base = gitShow(p);
    if (base === null) return false;
    return base === readFileSync(p, "utf8");
  }),
);

check(
  "G8 REGRESSION: huddle.functions.ts `Input` schema is byte-identical to origin/main",
  (() => {
    const slice = (s: string) => {
      const start = s.indexOf("const Input = z.object({");
      if (start < 0) return null;
      const end = s.indexOf("\n});", start);
      return end < 0 ? null : s.slice(start, end);
    };
    const base = gitShow("src/features/huddle/lib/huddle.functions.ts");
    const now = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
    const a = base && slice(base);
    const b = slice(now);
    return !!a && !!b && a === b;
  })(),
);

check(
  "G9 REGRESSION: the D4 email send-gate files are untouched by this change",
  ["src/features/huddle/lib/voice/realtime-tools.server.ts", "src/features/huddle/lib/email/graph-email.server.ts"].every(
    (p) => {
      const base = gitShow(p, "d0f8511");
      return base !== null && base === readFileSync(p, "utf8");
    },
  ),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
