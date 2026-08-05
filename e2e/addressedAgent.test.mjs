// Offline unit test for resolveAddressedAgent — proves the real STT-mangled inputs from the live
// transcript resolve correctly (present-members-only + recent-speaker tiebreak). Run: node this file
// after `npx tsc` compiles, OR import via bun. We inline-compile by importing the .ts through a tiny
// shim is overkill — instead this test re-implements nothing; it imports the compiled logic by reading
// the source through the TS-less path: we require the transpiled JS. Simplest: run with `bun`.
import { resolveAddressedAgent } from "../src/features/huddle/lib/addressedAgent.ts";

let pass = 0,
  fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  => ${JSON.stringify(got)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
}

// Present in THIS ceremony (Eli is NOT present — this is what disambiguates "El"/"Al" -> Elle).
const P = [
  { id: "terry-locke", firstName: "Terry" },
  { id: "sam-trent", firstName: "Sam" },
  { id: "cole-blake", firstName: "Cole" },
  { id: "elle-rowan", firstName: "Elle" },
  { id: "iris-chase", firstName: "Iris" },
  { id: "liam-kingsley", firstName: "Liam" },
];
// Roster where BOTH Elle and Eli are present — the genuinely ambiguous case.
const P2 = [...P, { id: "eli-vaughn", firstName: "Eli" }];

console.log("resolveAddressedAgent — real + adversarial cases\n");

// The headline: a clean summons must resolve the addressed agent as a SUMMONS.
check("Hey Sam", resolveAddressedAgent("Hey Sam.", P), { kind: "agent", agentId: "sam-trent", isSummons: true });
check("Sam?", resolveAddressedAgent("Sam?", P), { kind: "agent", agentId: "sam-trent", isSummons: true });
check("Terry", resolveAddressedAgent("Terry", P), { kind: "agent", agentId: "terry-locke", isSummons: true });

// The real mangled inputs from the transcript. In the live run Elle was the current speaker, so the
// recent-speaker tiebreak resolves "Al"/"El" -> Elle. Without ANY context, bare "Al" is legitimately
// ambiguous (Elle vs Sam) and correctly asks to clarify rather than guess.
check("Hey Al + Elle speaking -> Elle", resolveAddressedAgent("Hey, Al.", P, "elle-rowan"), {
  kind: "agent",
  agentId: "elle-rowan",
  isSummons: true,
});
check("Hey Al, no context -> ambiguous (safe)", resolveAddressedAgent("Hey, Al.", P).kind, "ambiguous");
check("El -> Elle", resolveAddressedAgent("El", P), { kind: "agent", agentId: "elle-rowan", isSummons: true });

// Addressed + a real request -> not a summons (single-responder turn).
check("Terry, what is blocked?", resolveAddressedAgent("Terry, what is blocked?", P), {
  kind: "agent",
  agentId: "terry-locke",
  isSummons: false,
});
check("Sam, mark the pitch done", resolveAddressedAgent("Sam, mark the investor pitch done", P), {
  kind: "agent",
  agentId: "sam-trent",
  isSummons: false,
});

// No name -> none (group router / content).
check("what is blocked (no name)", resolveAddressedAgent("What is blocked?", P), { kind: "none" });
check("gibberish", resolveAddressedAgent("mhm okay right", P), { kind: "none" });

// REGRESSION — function-word openers must NOT hijack to a name (the live "Iris" bug). A barge that
// begins with a pronoun/article previously prefix-matched its first letter to a name ("i" -> "Iris").
check('"I never mentioned uploaded files" -> none (not Iris)', resolveAddressedAgent("I never mentioned uploaded files.", P, "iris-chase"), { kind: "none" });
check('"I met you, Terry" -> not Iris', resolveAddressedAgent("I met you, Terry.", P, "iris-chase").agentId ?? "none", "none");
check('"It\'s not the University" -> none', resolveAddressedAgent("It's not the University of Pennsylvania.", P, "terry-locke"), { kind: "none" });
check('"No, just continue" -> none', resolveAddressedAgent("No, just go ahead and continue.", P, "terry-locke"), { kind: "none" });
check('"I don\'t know why you\'re involved, Iris" -> none (complaint, not address)', resolveAddressedAgent("I don't know why you're involved, Iris.", P, "iris-chase"), { kind: "none" });
// A real leading name still resolves even with a following clause.
check('"Iris, why are you speaking" -> Iris (real address)', resolveAddressedAgent("Iris, why are you speaking?", P).agentId, "iris-chase");

// Genuinely ambiguous (Elle AND Eli present), no context -> clarify.
const amb = resolveAddressedAgent("El", P2);
check("El w/ Elle+Eli present -> ambiguous", amb.kind, "ambiguous");
console.log(`     (candidates: ${JSON.stringify(amb.candidates)})`);
// ...but with recent speaker = Elle, tie breaks to Elle.
check("El + recentSpeaker Elle -> Elle", resolveAddressedAgent("El", P2, "elle-rowan"), {
  kind: "agent",
  agentId: "elle-rowan",
  isSummons: true,
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
