// WHAT:       Verifier loop 5: reproduce the implementer's "1436 literals, 19 differ" newTextOnly/asksSomething sweep.
// WHY:        Claim 12. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: VERIFY-...-5.md
import ts from "typescript";
import { readFileSync } from "node:fs";
import * as B from "../src/features/huddle/lib/email/inbound-email";
import * as M from "./verify5-main/inbound-email";
const files = process.argv.slice(2);
const lits = new Set<string>();
for (const f of files) {
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) lits.add(n.text);
    else if (ts.isTemplateExpression(n)) lits.add(n.head.text + n.templateSpans.map((s) => s.literal.text).join(" "));
    ts.forEachChild(n, walk);
  };
  walk(sf);
}
let diff = 0;
const ask = (B as any).asksSomething, askM = (M as any).asksSomething;
for (const s of lits) {
  const nb = B.newTextOnly(s), nm = M.newTextOnly(s);
  const ab = ask ? JSON.stringify(ask(s)) : "", am = askM ? JSON.stringify(askM(s)) : "";
  if (nb !== nm || ab !== am) { diff++; console.log(`DIFF ${JSON.stringify(s.slice(0, 90))}\n   kept-branch=${JSON.stringify(nb.slice(-60))}`); }
}
console.log(`literals=${lits.size} differ=${diff} asksSomething(branch)=${typeof ask} (main)=${typeof askM}`);
