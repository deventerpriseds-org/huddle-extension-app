# WHAT: writes the verifier's loop-2 mutation anchors/replacements (n1..n5) from exact source lines and
#       prints how many times each anchor occurs (must be 1).
# WHY: C8 of VERIFY-nexus-write-tool-2; anchors come from files, never shell arguments.
# SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-2.md
# Run (from the repo root): python3 -I mut-verify-114-2/make-anchors.py
import pathlib

d = pathlib.Path("mut-verify-114-2")
specs = {
    "n1": ("src/features/huddle/lib/nexus/nexus-write.server.ts",
           '  if (DENY_MEETING.test(t)) return "meeting/session";',
           '  if (false) return "meeting/session";'),
    "n2": ("src/features/huddle/lib/nexus/nexus-write.server.ts",
           "  return /^[A-Za-z]+\\/[A-Za-z_+-]+(?:\\/[A-Za-z_+-]+)?$/.test(z) && isValidZone(z) ? z : DEFAULT_COURSE_TZ;",
           "  return isValidZone(z) ? z : DEFAULT_COURSE_TZ;"),
    "n3": ("src/features/huddle/lib/nexus/nexus-write-shared.ts",
           "    (WRITE_TALK.test(s.text) || all.some((r) => mentionsItem(words, r)) ? removed : kept).push(s);",
           "    (all.some((r) => mentionsItem(words, r)) ? removed : kept).push(s);"),
    "n4": ("src/features/huddle/lib/nexus/nexus-write-shared.ts",
           "        if (!held) fn(...a);",
           "        fn(...a);"),
    "n5": ("src/features/huddle/data/agents.ts",
           '    strong: ["syllabus", "syllabi", "emba", "mba", "dba", "doctoral", "professor", "prof", "instructor", "coursework", "course work"],',
           '    strong: ["syllabus", "syllabi", "emba", "mba", "dba", "doctoral", "professor", "prof", "instructor", "coursework", "course work", "semester", "thesis"],'),
}
for k, (f, a, r) in specs.items():
    src = pathlib.Path(f).read_text()
    print(k, f, "occurrences=", src.count(a))
    (d / f"{k}.anchor").write_text(a)
    (d / f"{k}.repl").write_text(r)
