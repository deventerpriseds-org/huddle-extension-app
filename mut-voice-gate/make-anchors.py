# WHAT:       Writes the mutation anchor/replacement FILES for the voice-gate fix (m1..m13), each anchor copied from
#             the committed source and asserted to occur exactly once.
# WHY:        docs/FIX-nexus-write-voice-gate.md -- every new guard is mutation-proved with mutate.sh; anchors come
#             from files (never shell args) so a stale anchor reports NOT-APPLIED instead of a false INERT.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   mut-voice-gate/verdicts.out (written by run-mutations.sh).
# Run from the repo root: python3 mut-voice-gate/make-anchors.py
import pathlib, sys

HOOK = "src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts"
SHARED = "src/features/huddle/lib/nexus/nexus-write-shared.ts"
SERVER = "src/features/huddle/lib/voice/realtime-tools.server.ts"

M = {
    # id: (file, anchor, replacement)
    "m1": (HOOK, "    nexusGateRef.current = createNexusWriteSpeechGate(); // V3/V4: nothing this call left can gate the next\n", ""),
    "m2": (HOOK, "      nexusGateRef.current = createNexusWriteSpeechGate(); // V3/V4: a new call starts with a fresh gate\n", ""),
    # reinstate the V3 order: return on hang-up BEFORE settling the gate
    "m3": (
        HOOK,
        "                  writeGate.noteToolOutput(name, r.ok ? output : JSON.stringify({ ok: false, error: r.error }));\n"
        "                  if (genRef.current !== gen || dc.readyState !== \"open\") return;\n",
        "                  if (genRef.current !== gen || dc.readyState !== \"open\") return;\n"
        "                  writeGate.noteToolOutput(name, r.ok ? output : JSON.stringify({ ok: false, error: r.error }));\n",
    ),
    # settle the CURRENT gate (a later call's) instead of the captured one
    "m4": (HOOK, "                  writeGate.noteToolOutput(name, r.ok ? output", "                  nexusGateRef.current.noteToolOutput(name, r.ok ? output"),
    # V2: typed entry no longer resets
    "m5": (HOOK, "      nexusGateRef.current.reset();\n      dc.send(", "      dc.send("),
    # V5: committed no longer resets
    "m6": (
        HOOK,
        "              if (micMutedRef.current) break;\n              nexusGateRef.current.reset(typeof msg.item_id === \"string\" ? msg.item_id : undefined);\n",
        "              if (micMutedRef.current) break;\n",
    ),
    # V5: transcription resets un-keyed (would double-reset a later write's exchange)
    "m7": (
        HOOK,
        "              nexusGateRef.current.reset(typeof msg.item_id === \"string\" ? msg.item_id : undefined);\n              setCaptions(",
        "              nexusGateRef.current.reset();\n              setCaptions(",
    ),
    # V5: gate no longer dedupes a user turn's second signal
    "m8": (SHARED, "        if (seenTurns.includes(turnKey)) return;\n", ""),
    # V1: server catch back to the pre-fix shape for the write tool
    "m9": (
        SERVER,
        "name === NEXUS_WRITE_TOOL_NAME ? { ok: false, persisted: \"unknown\", error, tool: name } : { ok: false, error, tool: name }",
        "{ error, tool: name }",
    ),
    # V1 parser: only ok:false counts (the pre-fix rule)
    "m10": (
        SHARED,
        "(parsed.ok === false || (parsed.error != null && parsed.error !== \"\" && parsed.error !== false))",
        "parsed.ok === false",
    ),
    # V1 parser: unknown downgraded to false
    "m11": (SHARED, "persisted: parsed.persisted === \"unknown\" ? \"unknown\" : false,", "persisted: false,"),
    # V1 parser over-match: an empty error string would count as a failure
    "m12": (
        SHARED,
        "(parsed.error != null && parsed.error !== \"\" && parsed.error !== false)",
        "(parsed.error != null)",
    ),
    # keyless (typed) resets deduped against each other
    "m13": (
        SHARED,
        "      if (turnKey) {\n        if (seenTurns.includes(turnKey)) return;\n        seenTurns.push(turnKey);\n",
        "      {\n        if (seenTurns.includes(turnKey as string)) return;\n        seenTurns.push(turnKey as string);\n",
    ),
}

here = pathlib.Path(__file__).parent
ok = True
for mid, (f, anchor, repl) in M.items():
    src = pathlib.Path(f).read_text()
    n = src.count(anchor)
    if n != 1:
        print(f"{mid}: anchor occurs {n} times in {f}", file=sys.stderr)
        ok = False
    (here / f"{mid}.anchor").write_text(anchor)
    (here / f"{mid}.repl").write_text(repl)
    (here / f"{mid}.file").write_text(f)
print("anchors written" if ok else "ANCHOR PROBLEMS")
sys.exit(0 if ok else 1)
