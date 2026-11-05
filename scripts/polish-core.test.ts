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

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
