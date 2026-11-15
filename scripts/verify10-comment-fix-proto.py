p='/home/user/huddle-extension-app/.claude/worktrees/agent-a0692379bc9df20a7/src/features/huddle/lib/external-feeds/html-visible.ts'
s=open(p).read()
n0=len(s)
reps=[
('const cuts: [number, number][] = [];','const cuts: [number, number][] = []; const commentEnds = new Set<number>();'),
('if (l && l.endOffset > l.startOffset) cuts.push([l.startOffset, l.endOffset]);','if (l && l.endOffset > l.startOffset) { cuts.push([l.startOffset, l.endOffset]); if (n.nodeName === "#comment") commentEnds.add(l.endOffset); }'),
('const merged: [number, number][] = [];','const merged: [number, number][] = []; const mergedC: boolean[] = [];'),
('if (last && a <= last[1]) last[1] = Math.max(last[1], b);\n    else merged.push([a, b]);','if (last && a <= last[1]) { if (b >= last[1]) mergedC[merged.length - 1] = commentEnds.has(b) || (b === last[1] && mergedC[merged.length - 1]); last[1] = Math.max(last[1], b); }\n    else { merged.push([a, b]); mergedC.push(commentEnds.has(b)); }'),
('for (const [a0, b0] of merged) {','for (const [i, [a0, b0]] of merged.entries()) {'),
('out += html.slice(pos, Math.max(pos, a)) + " ";','out += html.slice(pos, Math.max(pos, a)) + (mergedC[i] ? "<!---->" : " ");'),
]
for a,b in reps:
    assert s.count(a)==1, a
    s=s.replace(a,b)
open(p,'w').write(s)
print("patched")
