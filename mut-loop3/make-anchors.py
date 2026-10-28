#!/usr/bin/env python3
# WHAT:  Writes the loop-3 mutation set (anchor + replacement FILES, one pair per guard) into mut-loop3/,
#        plus mutations.tsv (id, file, must-fail test name) that run-mutations.sh reads.
# WHY:   docs/FIX-nexus-write-loop3.md: every new guard is mutation-proved with mutate.sh; anchors come from
#        files (never shell arguments) and each is checked here to occur EXACTLY once in its source before
#        it is written, so a typo is caught now rather than reported later as NOT-APPLIED.
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
# EVIDENCE: docs/FIX-nexus-write-loop3.md (Mutations).
# Run from the repo root: python3 mut-loop3/make-anchors.py
import os, sys

W = "src/features/huddle/lib/nexus/nexus-write.server.ts"
S = "src/features/huddle/lib/nexus/nexus-write-shared.ts"
C = "src/features/huddle/lib/capabilities.ts"
A = "src/features/huddle/data/agents.ts"
CC = "src/features/huddle/lib/nexus/course-context.ts"
F = "src/features/huddle/lib/huddle.functions.ts"
H = "src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts"

M = [
    # ── D7 canonical title ──
    ("k1", W, '  s = s.replace(/[\\p{Default_Ignorable_Code_Point}\\p{Cf}]/gu, "");\n  s = s.toLowerCase();', '  s = s.toLowerCase();', "L3-D7a"),
    ("k2", W, '  let s = String(raw ?? "").normalize("NFKC");\n  s = s.replace(/[\\p{Default', '  let s = String(raw ?? "");\n  s = s.replace(/[\\p{Default', "L3-D7a"),
    ("k3", W, '  s = s.replace(/[^\\p{L}\\p{N}]+/gu, " ");\n  s = s.replace(/(\\p{L})', '  s = s.replace(/ +/g, " ");\n  s = s.replace(/(\\p{L})', "L3-D7a"),
    ("k4", W, '  s = s.replace(/(\\p{L})(?=\\p{N})/gu, "$1 ").replace(/(\\p{N})(?=\\p{L})/gu, "$1 ");\n', '', "L3-D7a"),
    ("k5", W, '          return `${stem} ${tok.slice(stem.length)}`;', '          return tok;', "L3-D7a"),
    ("k6", W, '  let t = canonicalTitle(title);', '  let t = String(title ?? "").toLowerCase();', "L3-D7a"),
    ("k7", W, '|orientations?|intensives?|weekends?|consorti(?:um|a)|conferences?|cohorts?)\\b/;', '|orientations?)\\b/;', "L3-D7a"),
    # ── item 6: unchanged stored title on UPDATE ──
    ("u1", W, '      title = "";\n    }', '      void 0;\n    }', "L3-K6a"),
    # ── D8 course-zone dedup day ──
    ("z1", W, '    const dayZone = courseZoneOf(course);\n    const dup = findDuplicate(', '    const dayZone = due.zone;\n    const dup = findDuplicate(', "L3-D8b"),
    ("z2", W, 'const days = new Set([localDay(cand.dueMs, zone), ...(cand.writtenDay ? [cand.writtenDay] : [])]);', 'const days = new Set([localDay(cand.dueMs, zone)]);', "L3-D8c"),
    ("z3", W, '    return { ok: true, iso: isoZ(ms), ms, timeAssumed: false, zone: DEFAULT_COURSE_TZ };', '    return { ok: true, iso: isoZ(ms), ms, timeAssumed: false, zone };', "L3-D8m"),
    ("z4", W, '(due.writtenDay ?? localDay(due.ms, DEFAULT_COURSE_TZ))', 'localDay(due.ms, DEFAULT_COURSE_TZ)', "L3-D8k"),
    ("z5", W, '  return typeof raw === "string" ? courseDayZone(raw) : DEFAULT_COURSE_TZ;', '  return DEFAULT_COURSE_TZ;', "L3-D8i"),
    # ── D6 routing: data from Nexus, vetoes first ──
    ("r1", C, '  if (anyWord(ctx.vetoes) || anyPattern(ctx.vetoPatterns)) return false;\n  if (anyWord(ctx.strong) || anyPattern(ctx.strongPatterns) || anySource(ctx.strongSources)) return true;',
              '  if (anyWord(ctx.strong) || anyPattern(ctx.strongPatterns) || anySource(ctx.strongSources)) return true;\n  if (anyWord(ctx.vetoes) || anyPattern(ctx.vetoPatterns)) return false;', "L3-D6o"),
    ("r2", C, ' || anySource(ctx.strongSources)) return true;', ') return true;', "L3-D6e"),
    ("r3", A, '    strongPatterns: [\n      // "Nexus" as the APP', '    strongPatterns: [\n      ["\\\\b[A-Z]{2,4}[- ]?\\\\d{3}[A-Z]?\\\\b", ""],\n      // "Nexus" as the APP', "L3-D6a"),
    ("r4", A, '    strong: ["syllabus", "syllabi"],', '    strong: ["syllabus", "syllabi", "mba", "dba", "instructor", "professor"],', "L3-D6q"),
    ("r5", CC, '  if (!cache || !nexusCourseContextFresh(nowMs)) return false;', '  if (!cache) return false;', "L3-D6l"),
    ("r6", F, '    await primeNexusCourseContext();\n', '    void primeNexusCourseContext;\n', "L3-D6u"),
    ("r7", CC, '.length >= 2 && n.length >= 8) names.push(n);', '.length >= 1) names.push(n);', "L3-D6k"),
    # ── D10/D11 turn-level code-built honesty ──
    ("h1", S, '  if (nexusWriteAnyUnpersisted(results)) {\n    const message = nexusWriteFailureMessage(results);', '  if (false) {\n    const message = nexusWriteFailureMessage(results);', "L3-H1"),
    ("h2", S, 'text: i === carrier ? message : NEXUS_WRITE_WITHHELD_REPLY }', 'text: i === carrier ? message : r.text }', "L3-H12"),
    ("h3", S, '      out[idx] = { ...out[idx], text: text ? `${text}\\n\\n${list}` : list };', '      out[idx] = { ...out[idx] };', "L3-H14"),
    ("h4", F, '            turnNexusWriteUses.push(writeUse);\n', '', "L3-D11f"),
    ("h5", F, '    nexusWriteUses: turnNexusWriteUses.map((u) => ({ ...u })),\n', '', "L3-D11c"),
    ("h6", F, 'const turnNexusWriteUses: TurnNexusWriteUse[] = [...(resume?.nexusWriteUses ?? [])];', 'const turnNexusWriteUses: TurnNexusWriteUse[] = [];', "L3-D11d"),
    ("h7", F, '    replies: presentedReplies(),\n', '    replies,\n', "L3-D10w every exit is presented: the final result"),
    ("h8", S, '    return { index, title, assignment_id: id, action: "failed", persisted: "unknown", error };', '    return { index, title, assignment_id: id, action: "inserted", persisted: true, error };', "L3-H17"),
    # ── D9 voice gate ──
    ("v1", S, '      if (pending > 0) {\n        if (text.trim()) buffer.push(text.trim());', '      if (false) {\n        if (text.trim()) buffer.push(text.trim());', "L3-V1"),
    ("v2", S, '      return { full: msg, speak: msg, mode: "whole" };', '      return { full: `${raw}\\n\\n${msg}`, speak: `${raw} ${msg}`, mode: "whole" };', "L3-V2"),
    ("v3", S, '      if (failed()) return settle({ full: "", speak: "", mode: "none" }); // the failure message', '      if (false) return settle({ full: "", speak: "", mode: "none" }); // the failure message', "L3-V3"),
    ("v4", S, '      if (!failed() && buffer.length === 0) return null;\n      return settle(deliver("", true));', '      return null;', "L3-V12"),
    ("v5", S, '      if (pending > 0 || (uses.length > 0 && !delivered)) resetRequested = true;', '      if (false) resetRequested = true;', "L3-V7"),
    ("v6", H, '              const flushed = nexusGateRef.current.flush();', '              const flushed = null as ReturnType<typeof nexusGateRef.current.flush>;', "L3-V22"),
    ("v7", H, '              if (out.mode === "whole") {', '              if (false) {', "L3-V20"),
]

here = os.path.dirname(os.path.abspath(__file__))
bad = 0
rows = []
for mid, path, anchor, repl, pat in M:
    src = open(path, encoding="utf-8").read()
    n = src.count(anchor)
    if n != 1:
        print(f"!! {mid}: anchor occurs {n}x in {path}")
        bad += 1
        continue
    open(os.path.join(here, f"{mid}.anchor"), "w", encoding="utf-8").write(anchor)
    open(os.path.join(here, f"{mid}.repl"), "w", encoding="utf-8").write(repl)
    rows.append(f"{mid}\t{path}\t{pat}")
open(os.path.join(here, "mutations.tsv"), "w", encoding="utf-8").write("\n".join(rows) + "\n")
print(f"wrote {len(rows)} mutations, {bad} bad anchors")
sys.exit(1 if bad else 0)
