# WHAT: writes the verifier's loop-3 mutation anchors/replacements as FILES, each anchor copied from the exact source
#       text and checked to occur exactly once (mutate.sh refuses otherwise).
# WHY:  C8 of VERIFY-nexus-write-tool-3 -- mutations of the loop-3 guards chosen by the verifier, not the fixer.
# SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-3.md
# Run from the repo root: python3 -I mut-verify-114-3/make-anchors.py
import pathlib, sys

S = "src/features/huddle/lib/nexus/"
M = [
    ("p1", S + "nexus-write-shared.ts",
     "return replies.map((r, i) => ({ ...r, text: i === carrier ? message : NEXUS_WRITE_WITHHELD_REPLY }));",
     "return replies.map((r, i) => ({ ...r, text: i === carrier ? message : r.text }));"),
    ("p2", S + "nexus-write-shared.ts",
     "        if (text.trim()) buffer.push(text.trim());\n        return { full: \"\", speak: \"\", mode: \"none\" }; // a write is in flight: say NOTHING yet",
     "        return { full: text, speak: text, mode: \"whole\" };"),
    ("p3", S + "nexus-write.server.ts",
     "  s = s.replace(/(\\p{L})(?=\\p{N})/gu, \"$1 \").replace(/(\\p{N})(?=\\p{L})/gu, \"$1 \");",
     "  s = s.replace(/(\\p{N})(?=\\p{L})/gu, \"$1 \");"),
    ("p4", S + "nexus-write.server.ts",
     "{ title, dueMs: due.ms, zone: dayZone, writtenDay: due.writtenDay }",
     "{ title, dueMs: due.ms, zone: \"Asia/Tokyo\", writtenDay: due.writtenDay }"),
    ("p5", "src/features/huddle/lib/huddle.functions.ts",
     "const turnNexusWriteUses: TurnNexusWriteUse[] = [...(resume?.nexusWriteUses ?? [])];",
     "const turnNexusWriteUses: TurnNexusWriteUse[] = [];"),
    ("p6", "src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts",
     "const flushed = nexusGateRef.current.flush();",
     "const flushed = null as ReturnType<typeof nexusGateRef.current.flush>;"),
    ("p7", "src/features/huddle/lib/capabilities.ts",
     "  if (anyWord(ctx.vetoes) || anyPattern(ctx.vetoPatterns)) return false;\n",
     ""),
]
out = pathlib.Path("mut-verify-114-3")
for mid, f, anchor, repl in M:
    n = pathlib.Path(f).read_text().count(anchor)
    if n != 1:
        sys.exit(f"{mid}: anchor occurs {n} times in {f}")
    (out / f"{mid}.anchor").write_text(anchor)
    (out / f"{mid}.repl").write_text(repl)
    print(mid, "ok", f)
