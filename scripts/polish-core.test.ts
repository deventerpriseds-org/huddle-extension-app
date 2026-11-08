// WHAT:       Offline test for Polish's pure core: prompt rules, span splice, settings coercion, word diff.
// WHY:        The selection edit promises "the rest stays as is" — this pins that every character outside
//             the selected span survives, and that untrusted settings cannot inject an unknown tone/engine.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `bun scripts/polish-core.test.ts` (npm run test:polish)

import {
  BUILTIN_PROFILES,
  applyResult,
  buildPolishPrompt,
  normalizeSettings,
  settingsDiffer,
  settingsSummary,
  wordDiff,
  splitSubject,
  polishedToHtml,
  polishedToMarkdown,
  suggestFileName,
} from "../src/features/huddle/lib/polish/polish-core";

let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) fail++;
};

const email = BUILTIN_PROFILES[0];

// 1. Span splice keeps every character outside the selection.
{
  const text = "Hello team.\n\nThe vendor slipped, which is on them, not us.\n\nThanks";
  const start = text.indexOf("which");
  const end = text.indexOf(" not us.") + " not us.".length;
  const out = applyResult(
    { mode: "span", text, start, end, instruction: "less blaming" },
    "⟦which gives us time to rehearse.⟧",
  );
  check("span: prefix kept", out.startsWith(text.slice(0, start)), out);
  check("span: suffix kept", out.endsWith(text.slice(end)), out);
  check("span: marks stripped", !out.includes("⟦") && !out.includes("⟧"), out);
  check("span: replacement present", out.includes("which gives us time to rehearse."), out);
}

// 2. The span prompt marks exactly the selected passage.
{
  const text = "one two three four";
  const { input } = buildPolishPrompt("Work email", email, {
    mode: "span",
    text,
    start: 4,
    end: 7,
    instruction: "x",
  });
  check("span prompt marks selection", input.includes("one ⟦two⟧ three four"), input);
}

// 3. Settings reach the system prompt; rules are listed one per line.
{
  const s = {
    ...email,
    tones: ["Warm", "Confident"] as typeof email.tones,
    rules: "Never use leverage\n\nLead with the result",
  };
  const { system } = buildPolishPrompt("Board update", s, { mode: "polish", draft: "q3 good" });
  check("prompt names purpose", system.includes("Purpose: Board update."));
  check("prompt carries tones", system.includes("Tone: Warm and Confident."));
  check(
    "prompt lists rules",
    system.includes("- Never use leverage\n- Lead with the result"),
    system,
  );
  check("prompt forbids invention", system.includes("Never invent details"));
}

// 4. Untrusted settings are coerced: unknown tone/engine dropped, formality clamped, tones capped at 2.
{
  const n = normalizeSettings({
    tones: ["Warm", "Hacker", "Direct", "Casual"],
    formality: 99,
    engine: "gpt-9",
    strength: "full",
  });
  check(
    "normalize: unknown tone dropped + cap 2",
    JSON.stringify(n.tones) === '["Warm","Direct"]',
    JSON.stringify(n.tones),
  );
  check("normalize: formality clamped", n.formality === 5, String(n.formality));
  check("normalize: bad engine falls back", n.engine === email.engine, n.engine);
  check("normalize: good strength kept", n.strength === "full");
}

// 5. Dirty detection + summary.
{
  check("not dirty vs itself", !settingsDiffer(email, { ...email }));
  check("dirty after change", settingsDiffer(email, { ...email, formality: 2 }));
  check("summary marks unsaved", settingsSummary("Work email", email, true).endsWith("unsaved"));
}

// 6. Wrapper echo stripped.
{
  check(
    "fences stripped",
    applyResult({ mode: "polish", draft: "x" }, "<<<\nHi team\n>>>") === "Hi team",
  );
}

// 7. Word diff reconstructs the new text from same+add parts.
{
  const a = "hey team so quick thing";
  const b = "Hi team, one quick thing";
  const parts = wordDiff(a, b);
  const rebuilt = parts
    .filter((p) => p.kind !== "del")
    .map((p) => p.text)
    .join("");
  check("diff rebuilds new text", rebuilt === b, JSON.stringify(parts));
  check(
    "diff marks a removal",
    parts.some((p) => p.kind === "del" && p.text.includes("hey")),
  );
}

// 8. Send-to helpers.
{
  const t = "Subject: Go-live moved\n\nHi team,\n\n• Hold comms\n• Update runbook\n\nThanks";
  const sp = splitSubject(t);
  check(
    "subject split",
    sp.subject === "Go-live moved" && sp.body.startsWith("Hi team,"),
    JSON.stringify(sp),
  );
  check("no subject -> empty", splitSubject("Hi there").subject === "");
  const html = polishedToHtml(t);
  check(
    "html bullets -> ul/li",
    html.includes("<ul><li>Hold comms</li><li>Update runbook</li></ul>"),
    html,
  );
  check("html escapes", polishedToHtml("a < b & c").includes("a &lt; b &amp; c"));
  check("markdown bullets", polishedToMarkdown("• one\n• two") === "- one\n- two");
  check("file name from subject", suggestFileName(t) === "Go-live moved");
  check(
    "file name strips slashes",
    !/[\\/:]/.test(suggestFileName("Q3/Q4: plan")),
    suggestFileName("Q3/Q4: plan"),
  );
}

// 9. Cross-app body (POST /api/public/polish): shapes accepted / refused, identity never accepted.
{
  const { PolishPublicBodySchema } =
    await import("../src/features/huddle/lib/polish/polish-schema");
  const { findCallerAssertedIdentity } =
    await import("../src/features/huddle/lib/cross-app/turn-gate");
  check("public: profiles ok", PolishPublicBodySchema.safeParse({ action: "profiles" }).success);
  check(
    "public: polish ok",
    PolishPublicBodySchema.safeParse({
      action: "polish",
      profileId: "slack",
      request: { mode: "polish", draft: "hi" },
    }).success,
  );
  check(
    "public: polish without request refused",
    !PolishPublicBodySchema.safeParse({ action: "polish" }).success,
  );
  check(
    "public: unknown action refused",
    !PolishPublicBodySchema.safeParse({ action: "send_email" }).success,
  );
  check(
    "public: asserted identity caught",
    findCallerAssertedIdentity({
      action: "polish",
      caller: { entra_email: "x@y.z" },
      request: { mode: "polish", draft: "hi" },
    }) !== null,
  );
  check(
    "public: legit body has no identity",
    findCallerAssertedIdentity({
      action: "polish",
      profileId: "slack",
      settings: { audience: "team" },
      request: { mode: "span", text: "a b c", start: 0, end: 1, instruction: "x" },
    }) === null,
  );
}

// 10. The route authenticates BEFORE it reads the body, and keeps both identity guards.
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(
    new URL("../src/routes/api/public/polish.ts", import.meta.url),
    "utf8",
  );
  const authAt = src.indexOf("authenticateCaller(request.headers)");
  const readAt = src.indexOf("request.json()");
  check(
    "route: authenticates first",
    authAt > -1 && readAt > -1 && authAt < readAt,
    `${authAt} vs ${readAt}`,
  );
  check("route: refuses asserted identity", src.includes("findCallerAssertedIdentity(payload)"));
  check("route: subject is server-held", src.includes("resolveActingSubject()"));
}

// 11. Phase 1 of the shared tools service: eds-tools first, local engine as fallback.
{
  const { runPolish, edsToolsOutcome } =
    await import("../src/features/huddle/lib/polish/polish.server");
  const saved = { t: process.env.JOURNEY_PROXY_TOKEN, k: process.env.OPENAI_API_KEY };
  process.env.JOURNEY_PROXY_TOKEN = "tok";
  delete process.env.OPENAI_API_KEY; // local engine answers "missing model key" -> proves which path ran
  const req = { mode: "polish" as const, draft: "hi" };
  const reply = (status: number, body: unknown) => async () =>
    ({ status, json: async () => body }) as unknown as Response;
  let sent: {
    url: string;
    headers: Record<string, string>;
    body: { settings?: { formality?: number } };
  } | null = null;
  const capture = async (url: string | URL | Request, init?: RequestInit) => {
    sent = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    };
    return {
      status: 200,
      json: async () => ({ ok: true, text: "Done", model: "m" }),
    } as unknown as Response;
  };
  const a = await runPolish(
    "Work email",
    { formality: 2 },
    req,
    undefined,
    capture as typeof fetch,
  );
  check("eds-tools: 200 used", a.ok === true && a.engine === "eds-tools", JSON.stringify(a));
  check(
    "eds-tools: token + app header sent",
    sent?.headers["x-webhook-secret"] === "tok" && sent?.headers["x-eds-app"] === "huddle",
  );
  check(
    "eds-tools: settings coerced before send",
    sent?.body.settings?.formality === 2,
    JSON.stringify(sent?.body),
  );
  const b = await runPolish("x", {}, req, undefined, (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  check("eds-tools: network error -> local fallback", b.engine === "local", JSON.stringify(b));
  const c = await runPolish(
    "x",
    {},
    req,
    undefined,
    reply(401, { ok: false, error: "unauthorized" }) as typeof fetch,
  );
  check("eds-tools: 401 -> local fallback", c.engine === "local", JSON.stringify(c));
  const d = await runPolish(
    "x",
    {},
    req,
    undefined,
    reply(400, { ok: false, error: "draft is required" }) as typeof fetch,
  );
  check(
    "eds-tools: 400 refusal is final (no fallback)",
    d.engine === "eds-tools" && d.ok === false,
    JSON.stringify(d),
  );
  check("outcome: non-JSON body -> fallback", edsToolsOutcome(200, null) === "fallback");
  check(
    "outcome: 502 model failure -> use",
    edsToolsOutcome(502, { ok: false, error: "x" }) === "use",
  );
  delete process.env.JOURNEY_PROXY_TOKEN;
  const e = await runPolish("x", {}, req, undefined, capture as typeof fetch);
  check("no token configured -> local, never calls out", e.engine === "local");
  if (saved.t !== undefined) process.env.JOURNEY_PROXY_TOKEN = saved.t;
  if (saved.k !== undefined) process.env.OPENAI_API_KEY = saved.k;
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
