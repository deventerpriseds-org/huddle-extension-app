# WHAT:       Prints the D14 test table rows for scripts/nexus-write-routing.test.ts from the MEASURED origin/main
#             probe outputs (mut-d14/probe-d14-all.main.{warm,cold}.out), so no expected value is typed by hand.
# WHY:        D14 acceptance: group leader and 1:1 lane = origin/main, warm and cold.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   mut-d14/probe-d14-all.main.warm.out, mut-d14/probe-d14-all.main.cold.out
# Usage: python3 -I mut-d14/gen-rows.py <dir holding probe-d14-all.main.*.out>
import json
import sys

d = sys.argv[1]
rows = {}
for c in ("warm", "cold"):
    with open(f"{d}/probe-d14-all.main.{c}.out") as fh:
        for line in fh:
            tag, _cache, g, l, self_, text, _prime = line.rstrip("\n").split("\t")
            r = rows.setdefault(tag, {"text": text, "self": self_})
            lane = l.split("=", 1)[1]
            r[c] = (g.split("=", 1)[1], "null" if lane == "-" else lane)
keep = [f"N{i}" for i in range(1, 12) if i != 9] + [f"E{i}" for i in range(1, 7)] + [f"F{i}" for i in range(1, 5)]
for t in keep:
    r = rows[t]
    gw, lw = r["warm"]
    gc, lc = r["cold"]
    print("      " + json.dumps([t, r["text"], r["self"], gw, gc, lw, lc]) + ",")
print("// N9", json.dumps(rows["N9"]))
