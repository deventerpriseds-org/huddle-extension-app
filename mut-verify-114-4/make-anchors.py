# WHAT: writes the loop-4 verifier's mutation anchors/replacements (q1..q7) as files, each anchor copied from the
#       source at HEAD and asserted to occur exactly once. WHY: C8 of VERIFY-nexus-write-tool-4 (anchors from files,
#       never shell args). SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-4.md
# Run from the repo root: python3 -I mut-verify-114-4/make-anchors.py
import pathlib, sys
R = pathlib.Path(".")
A = "src/features/huddle/data/agents.ts"
S = "src/features/huddle/lib/nexus/nexus-write-shared.ts"
H = "src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts"
T = "src/features/huddle/lib/voice/realtime-tools.server.ts"
M = {
 # override verb list loses "put" (behavioural: POS "put … into Nexus" rows)
 "q1": (A, '"(?:add|put|log|save|enter|record|update|change|move|reschedule|set)\\\\b" +', '"(?:add|log|save|enter|record|update|change|move|reschedule|set)\\\\b" +'),
 # NEXUS-not-the-app loses trusted/traveler (NEG trusted rows)
 "q2": (A, "|tracker|trusted|traveler|traveller))", "|tracker))"),
 # D12 email veto group deleted
 "q3": (A, '      "email", "e-mail", "emailed", "emailing", "message", "messaged", "messaging", "inbox",\n', ""),
 # D12 lodging veto pattern deleted
 "q4": (A, '      ["\\\\b(?:place|somewhere|where) to stay\\\\b|\\\\bstay(?:ing)? (?:at|near|in|with|overnight)\\\\b", "i"],\n', ""),
 # V5 keyed reset: a late transcription for the same item resets again
 "q5": (S, "        if (seenTurns.includes(turnKey)) return;\n", ""),
 # V3: settle the write AFTER the hang-up early return (the loop-3 defect)
 "q6": (H, '                  writeGate.noteToolOutput(name, r.ok ? output : JSON.stringify({ ok: false, error: r.error }));\n                  if (genRef.current !== gen || dc.readyState !== "open") return;\n',
           '                  if (genRef.current !== gen || dc.readyState !== "open") return;\n                  writeGate.noteToolOutput(name, r.ok ? output : JSON.stringify({ ok: false, error: r.error }));\n'),
 # V1 server: a throw returns the loop-3 {error,tool} shape
 "q7": (T, '{ ok: false, persisted: "unknown", error, tool: name }', '{ error, tool: name }'),
}
for k, (f, a, r) in M.items():
    src = (R / f).read_text()
    n = src.count(a)
    print(k, f, "count", n)
    if n != 1:
        sys.exit(f"{k} anchor count {n}")
    (R / "mut-verify-114-4" / f"{k}.anchor").write_text(a)
    (R / "mut-verify-114-4" / f"{k}.repl").write_text(r)
