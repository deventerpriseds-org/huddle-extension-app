# WHAT:       Cut mutation anchors for VERIFY-nexus-write-tool-5 C8 from the CURRENT source (exact bytes), assert each
#             occurs exactly once, write <id>.anchor / <id>.repl, and print the mutate.sh command lines.
# WHY:        Anchors typed from memory silently NOT-APPLY; cutting them from source and count-checking does not.
# SUPERSEDES: nothing (follows mut-verify-114-4/make-anchors.py).  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/VERIFY-nexus-write-tool-5.md (C8).
# Run: python3 -I mut-verify-114-5/make-anchors.py <tree-root>
import sys, pathlib
root = pathlib.Path(sys.argv[1]); out = root / "mut-verify-114-5"
M = [
  # id, file, anchor, replacement, test-cmd, must-fail
  ("r1", "src/features/huddle/lib/capabilities.ts",
   '  if (cap.oneToOneHandoff === "explicit-override") return capabilityExplicitOverride(cap, text);\n',
   '  if (cap.oneToOneHandoff === "explicit-override") return true;\n',
   "bun scripts/nexus-write-routing.test.ts", "Finn makes no deterministic hand-off"),
  ("r2", "src/features/huddle/data/agents.ts",
   '  `[^.?!;\\\\n]{0,80}?\\\\b(?:${NEXUS_ASSIGNMENT_OBJECTS.join("|")})\\\\b[^.?!;\\\\n]{0,80}?` +\n',
   '  `[^.?!;\\\\n]{0,160}?` +\n',
   "bun scripts/nexus-write-routing.test.ts", "R13-ovr-neg"),
  ("r3", "src/features/huddle/lib/routing.ts",
   '    const primeHint = opts.primeHint === true && !assigned;\n',
   '    const primeHint = !assigned;\n',
   "bun scripts/nexus-write-routing.test.ts", "R-M0-task creation"),
  ("r4", "src/features/huddle/lib/voice/realtime-tools.server.ts",
   '    ...nexusWriteTools(),\n',
   '',
   "bun scripts/nexus-write-tool.test.ts", "voice toolset pushes the write tools"),
  ("r5", "src/features/huddle/lib/voice/realtime-tools.server.ts",
   '    ...(opts.journey !== false ? [FOCUS_TOOL] : []),\n',
   '    FOCUS_TOOL,\n',
   "bun scripts/ask-shape.test.ts", "voice only offers focus_on when journey is on"),
  ("r6", "src/features/huddle/data/agents.ts",
   '  "passport", "vehicle", "membership", "renewal", "interview", "enrollment", "enrolment", "global entry",\n',
   '  "account", "passport", "vehicle", "membership", "renewal", "interview", "enrollment", "enrolment", "global entry",\n',
   "bun scripts/nexus-write-routing.test.ts", "add my essay to my Nexus account"),
  ("r7", "src/features/huddle/data/agents.ts",
   '  oneToOneHandoff: "explicit-override",\n',
   '',
   "bun scripts/nexus-write-routing.test.ts", "R13-ovr-data"),
]
for mid, f, a, r, cmd, pat in M:
    src = (root / f).read_text()
    n = src.count(a)
    assert n == 1, f"{mid}: anchor occurs {n} times in {f}"
    (out / f"{mid}.anchor").write_text(a)
    (out / f"{mid}.repl").write_text(r)
    print(f"{mid}\t{f}\t{cmd}\t{pat}")
