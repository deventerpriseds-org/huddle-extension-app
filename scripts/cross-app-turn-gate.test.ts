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
  CROSS_APP_TURN_ID_PREFIX,
  MAX_BODY_BYTES,
  SUBJECT_ENV,
  TEXT_MAX,
  authenticateCaller,
  buildTurnInput,
  crossAppAgentBackends,
  crossAppTurnId,
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
  // UPDATED 2026-09-08 (AC-turn-is-real B1). The intent is unchanged -- the route must REUSE the
  // existing turn machinery rather than reimplement it -- but the entrypoint moved from the direct
  // `runHuddleTurn` call to `runDurableHuddleTurn`, the shared durable path `enqueueHuddleTurn`
  // also runs. Asserted on routeCODE, not routeSrc: the header comment names the old function on
  // purpose, and matching prose would let the real call vanish while this stayed green.
  "G1 the route calls the EXISTING durable turn path from huddle.functions",
  /runDurableHuddleTurn/.test(routeCode) && /@\/features\/huddle\/lib\/huddle\.functions/.test(routeCode),
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

// Scoped to THIS CHANGE'S OWN COMMITS, not to the working tree, and that distinction is load-bearing.
// The first version compared the D4 gate files byte-for-byte against d0f8511 and went red the moment a
// CONCURRENT lane (D4b, the three-tier email gate) started editing them in this shared checkout -- a
// false alarm blaming D-16 for another lane's legitimate in-flight work. The claim D-16 actually makes
// is narrower and is the one worth guarding: no commit belonging to this change touches those files.
const D4_GATE_FILES = [
  "src/features/huddle/lib/voice/realtime-tools.server.ts",
  "src/features/huddle/lib/email/graph-email.server.ts",
  "src/features/huddle/lib/tasks/../identity/agent-workflow-config.server.ts",
];
let d16TouchedD4 = "unknown";
try {
  d16TouchedD4 = execFileSync(
    "git",
    ["log", "--format=%h %s", "--grep=D-16", "d0f8511..HEAD", "--", ...D4_GATE_FILES],
    { encoding: "utf8" },
  ).trim();
} catch {
  d16TouchedD4 = "unknown";
}

check(
  "G9 REGRESSION: no D-16 commit touches a D4 email send-gate file",
  d16TouchedD4 === "",
  d16TouchedD4 === "unknown" ? "git log failed" : d16TouchedD4,
);

// G10 exists because of a defect this change ITSELF introduced and an independent verifier caught:
// three `#` comment lines were placed BETWEEN the backslash-continued arguments of the
// `az staticwebapp appsettings set` call. Bash splices a line continuation BEFORE it parses
// comments, so the comment swallowed the rest of the command -- silently dropping
// CROSS_APP_TURN_SUBJECT *and two unrelated pre-existing settings* -- and still exited 0, so CI
// would have gone green on a half-configured deploy. Reproduced: the broken block emitted 4
// arguments, the fixed one 28. This guard EXECUTES the real block with `az` stubbed rather than
// pattern-matching for comments, so it catches any future way of truncating that argument list.
const deploySrc = readFileSync(".github/workflows/deploy-swa.yml", "utf8").split("\n");
const azStart = deploySrc.findIndex((l) => l.includes("az staticwebapp appsettings set"));
let azEnd = azStart;
while (azEnd >= 0 && deploySrc[azEnd].trimEnd().endsWith("\\")) azEnd++;
const azBlock = deploySrc
  .slice(azStart, azEnd + 1)
  .join("\n")
  .replace(/\$\{\{[^}]*\}\}/g, "SUBST")
  .replace("az staticwebapp appsettings set", "echo_args");
const azArgs =
  azStart < 0
    ? []
    : execFileSync(
        "bash",
        [
          "-c",
          'echo_args(){ for a in "$@"; do echo "ARG: $a"; done; }\nSWA_NAME=n\nAZURE_RESOURCE_GROUP=g\n' +
            "AZURE_PG_URL_RESOLVED=u\nSWA_HOST=h\n" +
            azBlock,
        ],
        { encoding: "utf8" },
      )
        .split("\n")
        .filter((l) => l.startsWith("ARG: "));

check(
  "G10 the deploy app-settings command actually PASSES every setting (no truncated continuation)",
  azStart >= 0 &&
    ["CROSS_APP_TURN_SUBJECT", "AZURE_STORAGE_CONNECTION_STRING", "HUDDLE_APP_URL", "HUDDLE_EMAIL_FROM", "JOURNEY_PROXY_TOKEN"].every(
      (name) => azArgs.some((a) => a.includes(name)),
    ),
  `${azArgs.length} args emitted`,
);

// ---------------------------------------------------------------------------------------------
// H -- AC-turn-is-real guards (2026-09-08). Every one of these asserts a value that must be
// PRESENT, not merely that something wrong is absent. Both shipped defects of this bridge were
// fields that should have been there and were not, and both suites were green (AC E6).
// ---------------------------------------------------------------------------------------------

const subj = { entra_email: "owner@example.com" };

// E5 -- the adapter's output shape, asserted POSITIVELY. `data.agents` being absent is what made a
// forwarded turn memory-blind in BOTH directions: the write gate
// (huddle.functions.ts `ragAgents ... filter(cfg.store === "azure" && cfg.chunks)`) and
// auto-retrieval (`ragCfg && ragCfg.store === "azure" && ragCfg.chunks`) are two independent `if`s
// reading the same missing config. Live proof of the consequence: bridge probe run 34191804298
// returned {"ok":true,"replies":[{"agentId":"elle-rowan","text":"ACK"}]} -- a fully successful
// forward -- and azure-pg-query run 34192165151 then found ZERO rows for its marker in rag_chunks.
const builtOne = buildTurnInput({ text: "hi", members: ["elle-rowan"], huddleId: "dm-elle-rowan" }, subj);
const agentsOne = builtOne.ok ? (builtOne.value as { agents?: Record<string, { rag?: { store?: string; chunks?: boolean; triples?: boolean } }> }).agents : undefined;
check(
  "H1 buildTurnInput HAS an `agents` key (absent = memory write AND retrieval both gated off)",
  !!agentsOne && typeof agentsOne === "object",
  `agents = ${JSON.stringify(agentsOne)}`,
);
check(
  "H2 every member's agents entry is rag.store 'azure' with chunks AND triples on",
  !!agentsOne &&
    ["elle-rowan"].every(
      (id) =>
        agentsOne[id]?.rag?.store === "azure" &&
        agentsOne[id]?.rag?.chunks === true &&
        agentsOne[id]?.rag?.triples === true,
    ),
  JSON.stringify(agentsOne?.["elle-rowan"]?.rag),
);

// The default (no `members` in the body) must be covered too -- Nexus sends an explicit member
// today, but a bare {"text":"..."} is documented as a complete request.
const builtDefault = buildTurnInput({ text: "hi" }, subj);
const agentsDefault = builtDefault.ok ? (builtDefault.value as { agents: Record<string, { rag: { store: string; chunks: boolean } }> }).agents : {};
check(
  "H3 the DEFAULT member set also gets rag config -- every member, no gaps",
  Object.keys(agentsDefault).length === defaultMembers().length &&
    defaultMembers().every(
      (id) => agentsDefault[id]?.rag?.store === "azure" && agentsDefault[id]?.rag?.chunks === true,
    ),
  `${Object.keys(agentsDefault).length} entries vs ${defaultMembers().length} members`,
);
check(
  "H4 agents carries entries for the members and nobody else",
  !!agentsOne && Object.keys(agentsOne).join(",") === "elle-rowan",
  Object.keys(agentsOne ?? {}).join(","),
);

// The new key must not itself be identity-shaped, or the route's own 400 guard would refuse a body
// that echoed it back. (Checked on the agents sub-object: the built input also carries `caller`,
// which findCallerAssertedIdentity is SUPPOSED to flag.)
check(
  "H5 the agents block trips no identity key at any depth",
  findCallerAssertedIdentity({ agents: crossAppAgentBackends(["elle-rowan", "iris-chase"]) }) === null,
  String(findCallerAssertedIdentity({ agents: crossAppAgentBackends(["elle-rowan"]) })),
);

// B5 -- exactly ONE execution per forwarded turn. `enqueueTurn` is INSERT ... ON CONFLICT DO
// NOTHING and execution is claim-locked, so "exactly once" holds only if the id is STABLE across
// attempts. A freshly-minted id per attempt is the trap B5 names by name.
const idArgs = { subject: "owner@example.com", huddleId: "dm-elle-rowan", text: "when is my capstone due?" };
check(
  "H6 the durable turn id is DETERMINISTIC for one forwarded turn (a retry re-enters the same row)",
  crossAppTurnId({ ...idArgs, now: 1_757_000_000_000 }) ===
    crossAppTurnId({ ...idArgs, now: 1_757_000_000_000 + 30_000 }),
  `${crossAppTurnId({ ...idArgs, now: 1_757_000_000_000 })} vs ${crossAppTurnId({ ...idArgs, now: 1_757_000_000_000 + 30_000 })}`,
);
check(
  "H7 a DIFFERENT message gets a different id (an id that collapsed them would drop turns)",
  crossAppTurnId({ ...idArgs, now: 1_757_000_000_000 }) !==
    crossAppTurnId({ ...idArgs, text: "who is my thesis advisor?", now: 1_757_000_000_000 }),
);
check(
  "H8 an explicit idempotencyKey removes the time component entirely",
  crossAppTurnId({ ...idArgs, idempotencyKey: "nexus-turn-42", now: 1 }) ===
    crossAppTurnId({ ...idArgs, idempotencyKey: "nexus-turn-42", now: 9_999_999_999_999 }),
);
check(
  "H9 the id is prefixed so a forwarded row is identifiable in chat.pending_turns",
  crossAppTurnId(idArgs).startsWith(CROSS_APP_TURN_ID_PREFIX),
  crossAppTurnId(idArgs),
);

// B1/E3 (offline half) -- the route must reach the DURABLE path. E3 proper is a live check on
// chat.pending_turns and needs a deploy; this is the edit-time guard that stops the direct
// runHuddleTurn call from coming back, which is precisely how the turn became invisible.
// `routeSrc` / `routeCode` (comments stripped) are already built in section G above.
check(
  "H10 the route CALLS runDurableHuddleTurn (the chat.pending_turns path)",
  /runDurableHuddleTurn\s*\(/.test(routeCode),
);
check(
  "H11 the route does NOT call runHuddleTurn directly (that bypass IS defect D2)",
  !/[^a-zA-Z]runHuddleTurn\s*\(/.test(routeCode),
);

// D1/D2/D4 -- owner attribution has a WRITER, on both the insert and the dedup path. A fix that
// only adds the column to the INSERT list passes D1 and fails D2: every repeated utterance takes
// the ON CONFLICT branch and would stay NULL-owned forever.
const storeSrc = readFileSync("src/features/huddle/lib/rag/azure-pg.server.ts", "utf8");
check(
  "H12 writeChunk INSERTS owner_entra_oid",
  /INSERT INTO rag_chunks|const cols = `\(scope, agent_id, text, source, embedding, metadata, author_agent_ids, owner_entra_oid\)`/.test(storeSrc) &&
    storeSrc.includes("author_agent_ids, owner_entra_oid)"),
);
check(
  "H13 writeChunk's ON CONFLICT DO UPDATE also stamps owner_entra_oid (AC D2 -- the dedup path)",
  storeSrc.includes("owner_entra_oid = COALESCE(rag_chunks.owner_entra_oid, EXCLUDED.owner_entra_oid)"),
);
check(
  "H14 writeTriples INSERTS and re-stamps owner_entra_oid (AC D4)",
  storeSrc.includes("author_agent_ids, owner_entra_oid)") &&
    storeSrc.includes("owner_entra_oid = COALESCE(rag_triples.owner_entra_oid, EXCLUDED.owner_entra_oid)"),
);

// D5 -- the oid is RESOLVED from identity.profile_emails, never guessed, and NEVER defaulted to
// "the only profile in the table" (correct with one profile, silently wrong with two).
const turnSrc = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
check(
  "H15 the memory write resolves the owner via resolveObjectIdByEmail and passes it to the store",
  /resolveObjectIdByEmail\(data\.caller\?\.entra_email\)/.test(turnSrc) &&
    turnSrc.includes("ownerEntraOid,"),
);
check(
  "H16 nothing in the turn path reads identity.profiles directly (no sole-profile guess)",
  !/identity\.profiles/.test(turnSrc),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
