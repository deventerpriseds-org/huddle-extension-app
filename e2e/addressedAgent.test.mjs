// Offline unit test for resolveAddressedAgent — the SHARED barge name-resolver (client instant-ack +
// server authoritative routing both use it). Proves: (1) the headline fix — a name spoken MID-SENTENCE
// resolves to that agent (the live "…Finn, are you here?" → Terry answered bug); (2) precision guards —
// ordinary words never hijack a name; (3) STT tolerance survives via the recent-speaker anchor. Run: bun.
import { resolveAddressedAgent } from "../src/features/huddle/lib/addressedAgent.ts";

let pass = 0,
  fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  => ${JSON.stringify(got)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
}

// Present in THIS ceremony. Finn is present (the live repro called for Finn). Eli is NOT present.
const P = [
  { id: "terry-locke", firstName: "Terry" },
  { id: "sam-trent", firstName: "Sam" },
  { id: "cole-blake", firstName: "Cole" },
  { id: "elle-rowan", firstName: "Elle" },
  { id: "iris-chase", firstName: "Iris" },
  { id: "finn-reid", firstName: "Finn" },
  { id: "liam-kingsley", firstName: "Liam" },
];

console.log("resolveAddressedAgent — real + adversarial cases\n");

// ── HEADLINE: a name spoken MID-SENTENCE resolves (the live "user calls Finn, Terry answers" bug). The
// old first-token-only logic returned none for these and the barge fell to the interlocutor (Terry).
check(
  '"Great, while you\'re doing that, uh, Finn, are you here?" -> Finn',
  resolveAddressedAgent("Great, while you're doing that, uh, Finn, are you here?", P, "terry-locke").agentId,
  "finn-reid",
);
check('"No, I called for Finn." -> Finn', resolveAddressedAgent("No, I called for Finn.", P, "terry-locke").agentId, "finn-reid");
check('"is Finn here?" -> Finn', resolveAddressedAgent("Hey, is Finn here?", P, "terry-locke").agentId, "finn-reid");
check('"I have something for Finn to do." -> Finn', resolveAddressedAgent("I have something for Finn to do.", P, "terry-locke").agentId, "finn-reid");

// ── Clean summons (a lone name, any trailing punctuation) -> instant ack.
check("Hey Sam", resolveAddressedAgent("Hey Sam.", P), { kind: "agent", agentId: "sam-trent", isSummons: true });
check("Sam? (trailing ? is still a summons)", resolveAddressedAgent("Sam?", P), { kind: "agent", agentId: "sam-trent", isSummons: true });
check("Terry", resolveAddressedAgent("Terry", P), { kind: "agent", agentId: "terry-locke", isSummons: true });

// ── Addressed + a real request -> not a summons (single-responder turn).
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

// ── STT tolerance via the RECENT-SPEAKER anchor (the documented "Al"/"El" -> Elle when Elle is talking).
// Scoping fuzzy to who holds the floor is what keeps a common word from fuzzily hijacking a random agent.
check("Hey Al + Elle speaking -> Elle", resolveAddressedAgent("Hey, Al.", P, "elle-rowan"), {
  kind: "agent",
  agentId: "elle-rowan",
  isSummons: true,
});
check("El + recentSpeaker Elle -> Elle", resolveAddressedAgent("El", P, "elle-rowan"), {
  kind: "agent",
  agentId: "elle-rowan",
  isSummons: true,
});
// A truncation of a name (≥3 chars) resolves WITHOUT needing the speaker anchor — a clean prefix.
check('"Terr, you there?" -> Terry (truncation)', resolveAddressedAgent("Terr, you there?", P).agentId, "terry-locke");

// ── PRECISION GUARDS — ordinary words must NEVER hijack a name (the wrong-agent class of bug the user
// hit). These are the whole reason the resolver is precision-biased (exact/truncation only, no general
// fuzzy). A miss here falls safely to the interlocutor; a false match sends the barge to the wrong agent.
check('"same as before" -> none (NOT Sam)', resolveAddressedAgent("Same as before.", P, "terry-locke"), { kind: "none" });
check('"I never mentioned uploaded files." -> none (not Iris)', resolveAddressedAgent("I never mentioned uploaded files.", P, "iris-chase"), { kind: "none" });
check('"It\'s not the University" -> none', resolveAddressedAgent("It's not the University of Pennsylvania.", P, "terry-locke"), { kind: "none" });
check('"No, just continue" -> none', resolveAddressedAgent("No, just go ahead and continue.", P, "terry-locke"), { kind: "none" });
check("what is blocked (no name) -> none", resolveAddressedAgent("What is blocked?", P), { kind: "none" });
check("gibberish -> none", resolveAddressedAgent("mhm okay right", P), { kind: "none" });

// ── A real leading name still resolves even with a following clause.
check('"Iris, why are you speaking" -> Iris', resolveAddressedAgent("Iris, why are you speaking?", P).agentId, "iris-chase");

// ── A name used as a VOCATIVE mid/late in the barge now resolves to that agent (same all-token
// mechanism as the Finn fix). This is intended: the user named a present teammate, so that teammate
// answers. (The old first-token-only logic returned none here — which is exactly why "…Finn…" failed.)
check('"I met you, Terry." -> Terry', resolveAddressedAgent("I met you, Terry.", P, "iris-chase").agentId, "terry-locke");

// ── 2-char mangle with NO speaker anchor is legitimately unresolvable → none (falls to the
// interlocutor server-side). In a live ceremony there is always a current/recent speaker, so this
// no-context case is artificial; the with-anchor cases above cover the real path.
check('"El" no context -> none (safe fallthrough)', resolveAddressedAgent("El", P), { kind: "none" });
check('"Hey Al" no context -> none (safe fallthrough)', resolveAddressedAgent("Hey, Al.", P), { kind: "none" });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
