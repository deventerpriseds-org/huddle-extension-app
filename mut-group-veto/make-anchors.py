# WHAT:       Writes the mutate.sh anchor/replacement files for the group-veto rows fix (v1..v3), each anchor CUT
#             FROM THE SOURCE (exact bytes, asserted to occur exactly once), never typed.
# WHY:        Mutation-prove the two new data groups in agents.ts (docs/FIX-nexus-write-loop4.md, "Group-veto rows").
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   mut-group-veto/mutations.out. Run from the repo root: python3 mut-group-veto/make-anchors.py
import pathlib
import re

SRC = pathlib.Path("src/features/huddle/data/agents.ts").read_text()
OUT = pathlib.Path("mut-group-veto")


def cut(pattern: str) -> str:
    hits = re.findall(pattern, SRC, flags=re.S)
    assert len(hits) == 1, (pattern, len(hits))
    assert SRC.count(hits[0]) == 1, pattern
    return hits[0]


# v1: the dining / food veto group's new words removed (defect: meals / cooking with a course code -> Iris leads)
v1 = cut(r'      "meal", "meals", "meal prep", "cook", "cooking", "recipe", "groceries", "grocery", "snack",\n')
# v2: the NEXUS-program clause veto removed (defect: "reschedule my interview in NEXUS" -> Iris leads)
v2 = cut(r'      \[NEXUS_PROGRAM_CLAUSE, "i"\],\n')
# v3: the program word list back to the two program words it held before (defect: "border", "vehicle", "account" ...
#     not program vocabulary -> O1 / O3 read "in NEXUS" as the app)
v3 = cut(r'const NEXUS_PROGRAM_WORDS = \[\n.*?\n\];\n')
v3_repl = 'const NEXUS_PROGRAM_WORDS = [\n  "membership", "interview",\n];\n'

for mid, anchor, repl in (("v1", v1, ""), ("v2", v2, ""), ("v3", v3, v3_repl)):
    (OUT / f"{mid}.anchor").write_text(anchor)
    (OUT / f"{mid}.repl").write_text(repl)
    print(mid, "anchor", len(anchor), "bytes; repl", len(repl), "bytes")
