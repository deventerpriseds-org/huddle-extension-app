# WHAT: applies (or reverts) one verifier mutation by id, only to READ which test names fail (mutate.sh said
#       UNDETERMINED). Never committed in the mutated state; always followed by `git checkout -- <file>`.
# WHY: C8 of VERIFY-nexus-write-tool-4. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
# EVIDENCE: docs/VERIFY-nexus-write-tool-4.md
# Run: python3 -I mut-verify-114-4/apply.py <file> <id>
import pathlib, sys
f, k = sys.argv[1], sys.argv[2]
d = pathlib.Path("mut-verify-114-4")
a, r = (d / f"{k}.anchor").read_text(), (d / f"{k}.repl").read_text()
p = pathlib.Path(f)
s = p.read_text()
assert s.count(a) == 1, "anchor count != 1"
p.write_text(s.replace(a, r))
print("applied", k)
