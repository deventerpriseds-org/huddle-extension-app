# WHAT:       Writes the loop-4 mutation anchors/replacements (mN.anchor / mN.repl) beside this file. Each anchor is
#             copied from the CURRENT source line (never typed) and checked to occur exactly once.
# WHY:        mutate.sh takes anchors from FILES; hand-typed anchors are how NOT-APPLIED happens.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-loop4.md (mutation table). Run from the repo root: python3 -I mut-loop4/make-anchors.py
import os
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
R = "src/features/huddle/lib/routing.ts"
C = "src/features/huddle/lib/capabilities.ts"
A = "src/features/huddle/data/agents.ts"
H = "src/features/huddle/lib/huddle.functions.ts"
V = "src/features/huddle/lib/voice/realtime-tools.server.ts"
# id: (file, substring that identifies the line, replacement line)
M = {
    # D13: a non-holder hands off on ANY coursework match again (the loop-4 defect)
    "m1": (R, "const handing = holders.filter((h) => capabilityHandsOffInOneToOne(h.cap, text));",
           "  const handing = holders;"),
    # D13: the data flag is ignored (every capability hands off always)
    "m2": (C, 'if (cap.oneToOneHandoff === "explicit-override") return capabilityExplicitOverride(cap, text);',
           "  // mutated: oneToOneHandoff ignored"),
    # D13: the capability no longer opts into explicit-override-only 1:1 hand-off (DATA removed)
    "m3": (A, 'oneToOneHandoff: "explicit-override",', "  // mutated: no oneToOneHandoff"),
    # D13-ovr: the override no longer needs an assignment object (loop-4 pattern)
    "m4": (A, 'NEXUS_ASSIGNMENT_OBJECTS.join("|")', "  `[^.?!;\\\\n]{0,100}?` +"),
    # M0: the prime-owners directory reaches every resolveOwnerLLM caller (grooming / task creation)
    "m5": (R, 'const primeOwners = primeHint ? primeOwnershipDirectory() : "";',
           "    const primeOwners = primeOwnershipDirectory();"),
    # M0: "assigned" (grooming) no longer overrides primeHint
    "m6": (R, "const primeHint = opts.primeHint === true && !assigned;",
           "    const primeHint = opts.primeHint === true;"),
    # M0: the chat hand-off stops opting in
    "m7": (H, "}, { primeHint: true })", "                })"),
    # M0 merge resolution: voice loses the Nexus write tool (took main's side)
    "m8": (V, "    ...nexusWriteTools(),", "    // mutated: no nexusWriteTools"),
    # M0 merge resolution: voice re-offers FOCUS_TOOL with journey off (took the PR's side)
    "m9": (V, "...(opts.journey !== false ? [FOCUS_TOOL] : []),", "    FOCUS_TOOL,"),
}
for mid, (f, needle, repl) in M.items():
    lines = open(os.path.join(ROOT, f)).read().split("\n")
    hits = [l for l in lines if needle in l]
    assert len(hits) == 1, (mid, f, len(hits))
    src = open(os.path.join(ROOT, f)).read()
    assert src.count(hits[0]) == 1, (mid, "anchor line not unique")
    open(os.path.join(HERE, mid + ".anchor"), "w").write(hits[0])
    open(os.path.join(HERE, mid + ".repl"), "w").write(repl)
    print(mid, f, "anchor ok")
