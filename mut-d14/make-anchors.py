# WHAT:       Cuts the D14 mutation anchors from src/features/huddle/data/agents.ts (each must occur EXACTLY once)
#             and writes <id>.anchor / <id>.repl into mut-d14/ for mutate.sh.
# WHY:        Anchors come from FILES cut from the real source, never typed into a shell (org rule).
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   mut-d14/mutations.out
# Run from the tree root: python3 -I mut-d14/make-anchors.py
import sys

SRC = "src/features/huddle/data/agents.ts"
src = open(SRC).read()
MUTS = {
    # m1 CLAUSE BOUNDARY gone: the whole ask is one clause again
    "m1": ("    explicitOverrideClauseBreak: NEXUS_OVERRIDE_CLAUSE_BREAK,\n", ""),
    # m2 DESTINATION requirement gone: "in (my) Nexus" anywhere counts (the loop-4 shape)
    "m2": (
        "in\\\\s+(?:my\\\\s+)?nexus\\\\b${NEXUS_NOT_THE_APP}${NEXUS_DATE_TAIL}\\\\s*$)",
        "in\\\\s+(?:my\\\\s+)?nexus\\\\b${NEXUS_NOT_THE_APP})",
    ),
    # m3 COMPETING-DESTINATION cancel gone
    "m3": ("    explicitOverrideCancels: NEXUS_OVERRIDE_CANCELS,\n", ""),
    # m4 PURPOSE ("for my … project") lookbehind gone
    "m4": (
        "\\\\b(?<!\\\\bfor\\\\s+(?:(?:my|the|a|an|our|this|that)\\\\s+)?(?:[a-z0-9'-]+\\\\s+){0,2})(?:${NEXUS_ASSIGNMENT_OBJECTS",
        "\\\\b(?:${NEXUS_ASSIGNMENT_OBJECTS",
    ),
}
bad = 0
for mid, (anchor, repl) in MUTS.items():
    n = src.count(anchor)
    print(f"{mid}: anchor occurs {n}x")
    if n != 1:
        bad = 1
    open(f"mut-d14/{mid}.anchor", "w").write(anchor)
    open(f"mut-d14/{mid}.repl", "w").write(repl)
sys.exit(bad)
