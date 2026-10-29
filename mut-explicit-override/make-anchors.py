# WHAT:       Writes the mutate.sh anchor/replacement FILES for the explicit-Nexus override
#             (docs/FIX-nexus-write-routing.md, "Explicit Nexus override (2026-10-29)"): the override itself (order,
#             data, 1:1, hint) and every negative guard inside it (NEXUS card/program/trusted traveler/fitness tracker,
#             "apply to NEXUS", clause-initial verb, write verb required, Nexus as a DESTINATION, "the nexus of").
#             Each anchor is a whole source line taken from the file and checked to occur EXACTLY once.
# WHY:        Anchors typed by hand silently fail to match (NOT-APPLIED); this script fails loudly instead.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-routing.md. Run: python3 mut-explicit-override/make-anchors.py
#             then bash mut-explicit-override/run-mutations.sh (output: mut-explicit-override/mutations.out)
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AG = "src/features/huddle/data/agents.ts"
CAP = "src/features/huddle/lib/capabilities.ts"

def src(path):
    return open(os.path.join(ROOT, path), encoding="utf8").read()

def line_with(path, needle):
    hits = [l for l in src(path).split("\n") if needle in l]
    if len(hits) != 1:
        sys.exit(f"{path}: needle {needle!r} on {len(hits)} lines")
    return hits[0] + "\n"

M = {}  # id -> (file, anchor, replacement, must-fail test name)
def drop(mid, path, needle, must):
    M[mid] = (path, line_with(path, needle), "", must)
def sub(mid, path, needle, old, new, must):
    a = line_with(path, needle)
    if a.count(old) != 1:
        sys.exit(f"{mid}: {old!r} occurs {a.count(old)} times in the anchor line")
    M[mid] = (path, a, a.replace(old, new), must)

POS1 = '"add the MGT-782 email marketing case analysis to Nexus"'
POS2 = '"put my travel industry essay due Nov 3 into Nexus"'
POS3 = '"update the Airbnb pricing case study due date in Nexus"'

# ── the override ──
drop("m-order", CAP, "if (anyPattern(ctx.explicitOverride)) return true;", f"R-X warm {POS1} -> holders are Elle/Iris")
drop("m-order-1to1-cam", CAP, "if (anyPattern(ctx.explicitOverride)) return true;", f"R-X warm 1:1 Cam hands {POS1} to Elle/Iris")
drop("m-order-1to1-keep", CAP, "if (anyPattern(ctx.explicitOverride)) return true;", f"R-X cold 1:1 Elle/Iris keep {POS3}")
ov = line_with(CAP, "if (anyPattern(ctx.explicitOverride)) return true;")
ve = line_with(CAP, "if (anyWord(ctx.vetoes) || anyPattern(ctx.vetoPatterns)) return false;")
if (ov + ve) not in src(CAP) or src(CAP).count(ov + ve) != 1:
    sys.exit("m-after-veto: override + veto lines are not adjacent exactly once")
M["m-after-veto"] = (CAP, ov + ve, ve + ov, f"R-X warm {POS3} -> holders are Elle/Iris")
drop("m-data", AG, 'explicitOverride: [[NEXUS_EXPLICIT_WRITE, "i"]],', f"R-X cold {POS2} -> holders are Elle/Iris")
drop("m-hint", AG, '"An EXPLICIT request to add, put, log, save, update, change, move or reschedule something TO, IN or INTO Nexus " +', "R-X-hint")

# ── negative guards ──
NOT_APP = "(?!\\\\s+(?:card|cards|program"  # the NEXUS_NOT_THE_APP line
sub("g-card", AG, NOT_APP, "card|cards|", "", 'R-XN-card warm "add the renewal date to my NEXUS card" matches NO')
sub("g-program", AG, NOT_APP, "program|programme|", "", 'R-XN-program warm "update the interview date in my NEXUS program" matches NO')
sub("g-trusted", AG, NOT_APP, "|trusted|traveler|traveller", "", 'R-XN-trusted warm "add my kid to NEXUS trusted traveler" matches NO')
sub("g-trusted-in", AG, NOT_APP, "|trusted|traveler|traveller", "", 'R-XN-trusted cold "update my address in NEXUS trusted traveler before the deadline" matches NO')
sub("g-fitness", AG, NOT_APP, "|fitness", "", 'R-XN-fitness warm "can you log my 5k run to Nexus fitness tracker by the deadline" matches NO')
VERB = '"(?:add|put|log|save|enter|record|update|change|move|reschedule|set)\\\\b" +'
sub("g-apply", AG, VERB, "(?:add|", "(?:apply|add|", 'R-XN-apply warm "apply to NEXUS for me before my Toronto trip" matches NO')
CLAUSE = '"(?:^|[.!?;:\\\\n]\\\\s*|\\\\b(?:and|then)\\\\s+)" +'
sub("g-clause", AG, CLAUSE, "(?:^|[.!?;:\\\\n]\\\\s*|\\\\b(?:and|then)\\\\s+)", "(?:\\\\b)",
    'R-XN-email warm "email my professor that I will add the MGT-782 essay to Nexus tonight" matches NO')
sub("g-clause-put", AG, CLAUSE, "(?:^|[.!?;:\\\\n]\\\\s*|\\\\b(?:and|then)\\\\s+)", "(?:\\\\b)",
    'R-XN-email cold "email my professor about the essay I put in Nexus" matches NO')
sub("g-verb", AG, VERB, "(?:add|put|log|save|enter|record|update|change|move|reschedule|set)\\\\b",
    "(?:(?:add|put|log|save|enter|record|update|change|move|reschedule|set)\\\\b)?",
    'R-XN-question warm "when is my travel essay due in Nexus" matches NO')
sub("g-verb-did", AG, VERB, "(?:add|put|log|save|enter|record|update|change|move|reschedule|set)\\\\b",
    "(?:(?:add|put|log|save|enter|record|update|change|move|reschedule|set)\\\\b)?",
    'R-XN-question cold "did the email marketing paper make it into Nexus" matches NO')
# the naive implementation ("any Nexus mention overrides the vetoes") -- what the destination + verb requirement prevents
NAIVE = '    explicitOverride: [["\\\\bnexus\\\\b", "i"]],\n'
M["g-naive-down"] = (AG, line_with(AG, 'explicitOverride: [[NEXUS_EXPLICIT_WRITE, "i"]],'), NAIVE, 'R-XN-down warm "is Nexus down" matches NO')
M["g-naive-email"] = (AG, line_with(AG, 'explicitOverride: [[NEXUS_EXPLICIT_WRITE, "i"]],'), NAIVE, 'R-XN-email warm "email my professor about Nexus" matches NO')
DEST = "`(?:\\\\b(?:to|in|into)\\\\s+(?:my\\\\s+)?nexus"
sub("g-the", AG, DEST, "(?:my\\\\s+)?nexus", "(?:(?:my|the)\\\\s+)?nexus",
    'R-XN-nexus-of warm "update my travel essay to the nexus of airlines and hotels" matches NO')

with open(os.path.join(HERE, "mutations.tsv"), "w", encoding="utf8") as tsv:
    for mid, (path, a, r, must) in M.items():
        if src(path).count(a) != 1:
            sys.exit(f"{mid}: anchor occurs {src(path).count(a)} times in {path}")
        open(os.path.join(HERE, f"{mid}.anchor"), "w", encoding="utf8").write(a)
        open(os.path.join(HERE, f"{mid}.repl"), "w", encoding="utf8").write(r)
        tsv.write(f"{mid}\t{path}\t{must}\n")
print(f"wrote {len(M)} mutations")
