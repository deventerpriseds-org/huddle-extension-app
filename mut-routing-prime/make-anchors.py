# WHAT:       Writes the mutate.sh anchor/replacement FILES for docs/FIX-nexus-write-routing.md: one mutation per new
#             D12 veto group (words + patterns), the negative guards inside the patterns (Google Drive, cost-benefit,
#             bare "run", "stay on top"), and the (A) prime-owners hint (data, directory, group base/strict, 1:1).
#             Each anchor is taken from the exact source text and checked to occur EXACTLY once.
# WHY:        Anchors typed by hand silently fail to match (NOT-APPLIED); this script fails loudly instead.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   docs/FIX-nexus-write-routing.md (Mutations). Run: python3 mut-routing-prime/make-anchors.py
#             then bash mut-routing-prime/run-mutations.sh
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AG = "src/features/huddle/data/agents.ts"
CAP = "src/features/huddle/lib/capabilities.ts"
RT = "src/features/huddle/lib/routing.ts"

def line_with(path, needle):
    src = open(os.path.join(ROOT, path), encoding="utf8").read()
    hits = [l for l in src.split("\n") if needle in l]
    if len(hits) != 1:
        sys.exit(f"{path}: needle {needle!r} on {len(hits)} lines")
    return hits[0] + "\n"

# id -> (file, anchor text, replacement text, must-fail test name)
M = {}
def drop_line(mid, path, needle, must):
    a = line_with(path, needle)
    M[mid] = (path, a, "", must)
def sub(mid, path, needle, old, new, must):
    a = line_with(path, needle)
    if a.count(old) != 1:
        sys.exit(f"{mid}: {old!r} occurs {a.count(old)} times in the anchor line")
    M[mid] = (path, a, a.replace(old, new), must)

# (B) veto groups -- deleting the group's data reinstates D12 for that lane
drop_line("v-email", AG, '"email", "e-mail", "emailed"', "R12-email warm")
drop_line("v-email-pattern", AG, '\\\\bwrite (?:a (?:note|letter|message) )?to', "R12-email-pattern warm")
# (multi-line array entries: the pattern STRING is replaced by a never-matching one; deleting the line would
# leave ["i"], i.e. the regex /i/ that matches almost everything)
never = lambda mid, needle, must: M.__setitem__(mid, (AG, line_with(AG, needle), '        "(?!)",\n', must))
never("v-calendar", '\\\\b(?:on|to|in|into|onto|from|off) my calendar', "R12-calendar warm")
drop_line("v-reminder", AG, '"remind", "reminder",', "R12-reminder warm")
drop_line("v-dining", AG, '"restaurant", "dinner", "lunch"', "R12-dining warm")
drop_line("v-car", AG, '"rent a car", "rental car"', "R12-car warm")
never("v-car-pattern", '(?:drive|driving) (?:to (?!', "R12-car-pattern warm")
drop_line("v-lodging", AG, '"airbnb", "lodging"', "R12-lodging warm")
drop_line("v-lodging-pattern", AG, 'to stay\\\\b|', "R12-lodging-pattern warm")
drop_line("v-money", AG, '"budget", "budgeting", "afford"', "R12-money warm")
drop_line("v-money-pattern", AG, '\\\\bcosts?\\\\b(?!', "R12-money-pattern warm")
drop_line("v-fitness", AG, '"runs", "running", "jog"', "R12-fitness warm")
drop_line("v-fitness-pattern", AG, 'for a run\\\\b', "R12-fitness-pattern warm")
drop_line("v-travel", AG, '"travel", "traveling"', "R12-travel warm")
# (B) the negative guards inside the new vetoes -- removing one makes a coursework ask lose Elle/Iris
sub("g-drive", AG, '(?:drive|driving) (?:to (?!', '(?<!\\\\b(?:google|my|the|a|shared|team|one)\\\\s)', "", "R-CW-gdrive warm")
sub("g-drive-nexus", AG, '(?:drive|driving) (?:to (?!', 'to (?!(?:my )?nexus\\\\b)|', 'to |', "R-CW-drive-nexus warm")
sub("g-cost", AG, '\\\\bcosts?\\\\b(?!', '(?![- ](?:benefit|accounting|analysis|of capital|structure|leadership|center|centre)\\\\b)', "", "R-CW-cost warm")
sub("g-run", AG, '"runs", "running", "jog"', '"runs", ', '"runs", "run", ', "R-CW-run warm")
sub("g-stay", AG, 'to stay\\\\b|', '(?:at|near|in|with|overnight)', '(?:at|near|in|with|overnight|on)', "R-CW-stay warm")
# (A) the hint
sub("h-data", AG, '"they are the preferred owners whenever the owner asks', '"they are the preferred owners whenever the owner asks to ADD or UPDATE his Nexus coursework assignments " +', '"" +', "R-A2 the hint data says \"preferred owners\"")
sub("h-dir", CAP, "return `- ${cap.label} → ${who}", '${cap.routerHint ? `: ${cap.routerHint}` : ""}', "", "R-A1-hint")
sub("h-group", RT, "const system = (invocation.strictPrompt ? strictSystem : baseSystem) +", ' + (primeOwners ? `\\n${primeOwners}` : "")', "", "R-A3 base router system prompt carries")
sub("h-strict", RT, "const system = (invocation.strictPrompt ? strictSystem : baseSystem) +", "(invocation.strictPrompt ? strictSystem : baseSystem) + (primeOwners", "invocation.strictPrompt ? strictSystem : baseSystem + (primeOwners", "R-A3s strict router system prompt carries")
drop_line("h-resolver", RT, '(primeOwners ? `${primeOwners}\\n\\n` : "") +', "R-A4 1:1 owner resolver prompt carries")

with open(os.path.join(HERE, "mutations.tsv"), "w", encoding="utf8") as idx:
    for mid, (path, anchor, repl, must) in M.items():
        open(os.path.join(HERE, f"{mid}.anchor"), "w", encoding="utf8").write(anchor)
        open(os.path.join(HERE, f"{mid}.repl"), "w", encoding="utf8").write(repl)
        idx.write(f"{mid}\t{path}\t{must}\n")
print(f"{len(M)} mutations written")
