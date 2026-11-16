import os, sys
d = sys.argv[1]
os.makedirs(d, exist_ok=True)
m = {
    "m1": ("    if (c.involvement.hide) {\n", "    if (false) {\n"),
    "m2": ('  return { hide: true, kind, reason: "uninvolved" };\n', '  return { hide: false, kind, reason: "uninvolved" };\n'),
    "m3": ('  if (!messages.length || messages.some((m) => !Array.isArray(m.mentionedUserIds))) return { hide: false, kind, reason: "cant_tell_no_mention_data" };\n', "\n"),
    "m4": ("    if (via) plan.email.resolved.push({ f, via });\n", "    if (false) plan.email.resolved.push({ f, via });\n"),
    "m5": ("s.coversUntilMs >= latestOtherMs && ", ""),
}
for k, (a, r) in m.items():
    open(os.path.join(d, k + ".anchor"), "w").write(a)
    open(os.path.join(d, k + ".repl"), "w").write(r)
print("ok")
