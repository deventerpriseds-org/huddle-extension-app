import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ChatText } from "../src/features/huddle/components/ChatText";
import { parseInline, noticeText } from "../src/features/huddle/lib/chat-format";
const r = (s: string) => renderToStaticMarkup(createElement(ChatText as any, { text: s }));
const rows: [string, string][] = [
["S-1","• a\n• b"],["S-2a","- a\n- b"],["S-2b","* a\n* b"],["S-3","+ a\n+ b"],["S-4","• a\n\n• b\n\n• c"],
["S-5a","1. a\n2. b"],["S-5b","1) a\n2) b"],["S-6","3. a\n2. b\n1. c"],["S-7","- item\n  - sub item"],["S-8","- [ ] buy milk"],
["S-9a","**Up next**"],["S-9b","**Up next:**"],["S-9c","**Up next**:"],["S-10","__Up next__"],["S-11a","*note*"],["S-11b","_note_"],
["S-12","Reply text _(fallback: x; y)_"],["S-13","***really***"],["S-14","## Today"],["S-15","## next steps"],
["S-16a","# of tasks: 5"],["S-16b","#1 priority"],["S-16c","#hashtag"],["S-17","> quoted line"],["S-18a",">50% done"],["S-18b","5 > 3"],
["S-19","> a\n>\n> b"],["S-20","`npm run x`"],["S-21","```\n# Not a heading\n- not a list\n```"],["S-22","https://zoom.us/j/1?pwd=SECRET"],
["S-23a","See https://x.com/a."],["S-23b","(https://x.com/a)"],["S-23c","https://x.com/a,"],["S-24","https://en.wikipedia.org/wiki/Foo_(bar)"],
["S-25","[wiki](https://en.wikipedia.org/wiki/Foo_(bar))"],["S-26","<https://x.com>"],["S-27","**https://x.com/a**"],
["S-28a","javascript:alert(1)"],["S-28b","[x](javascript:alert(1))"],["S-28c","data:text/html,<script>x</script>"],
["S-29a","<b>hi</b>"],["S-29b","<img src=x onerror=alert(1)>"],["S-30","mailto:a@b.com a@b.com +1 (555) 010-0000"],
["S-32","Note here.\n10. That's the deadline"],["S-33a","-5°F tonight"],["S-33b","- 5 tasks left"],["S-34","✅ Done\n✅ Next\n⚠️ Blocked"],
["S-35","Hello Sir,\n\njust a reminder"],["S-37","Best,  \nVon"],["S-38","a\r\n• b\r\n• c\r"],["S-39","| a | b |\n|---|---|\n| 1 | 2 |"],
["S-40","---\n***"],["S-41","• item\n  continued on next line"],
["X-math","2*3*4 and a * b * c and 5*x*y"],["X-snake","snake_case_name and my_var_ and _private and __init__"],
["X-file","open report_final_v2.docx and *.ts files and ~/a_b_/c"],["X-urlU","https://x.com/a_b_c_d and https://x.com/*a*/b"],
["X-urlU2","see https://x.com/_a_ now"],["X-bul","* not italic*"],["X-bul2","* a *b* c"],["X-boldit","***x*** and **_y_** and *__z__*"],
["X-mixed","*a* *b* _c_ _d_"],["X-adj","*a*_b_"],["X-glob","rm *.log *.tmp"],["X-paren","(_note_) [*n*] \"*q*\""],
["X-pre-inline","```js\nconst a_b_c = 2*3*4; // **x**\n```"],["X-unclosed","```\ncode never closed\n- x"],
["X-fenceIndented","  ```\n  x\n  ```"],["X-inlineFence","text ```inline``` text"],["X-italicXSS","*<img src=x onerror=alert(1)>*"],
["X-h1","# Today"],["X-h7","####### seven"],["X-hEmpty","##"],["X-hNoSpace","##nospace"],["X-quoteEmpty",">"],["X-quoteTab",">\tx"],
["X-plus","+1 on that"],["X-plus2","+ 5 more"],["X-starnum","**3** tasks"],["X-email_","von_ellis@enterpriseds.io"],
["X-fenceList","- a\n```\nx\n```\n- b"],["X-fenceBlankInside","```\na\n\n\n\nb\n```"],["X-fenceListBlank","```\n- a\n\n- b\n```"],
];
for (const [k, s] of rows) console.log(k.padEnd(16), JSON.stringify(s).slice(0, 60).padEnd(62), "=>", r(s));
console.log("notice", noticeText("(couldn't respond — quota)"), "|", noticeText("(couldn’t respond — x)"), "|", noticeText("(couldn't respond - quota)"), "|", noticeText("I couldn't respond earlier — sorry"), "|", noticeText("(fallback plan: Zoom)"), "|", noticeText("Fallback: use Zoom"));
const big = Array.from({ length: 400 }, (_, i) => `• item ${i} https://x.com/${"a".repeat(300)} *e* _f_`).join("\n") + "\n" + "x".repeat(16000);
let t = performance.now(); r(big); console.log("S-42 ms", (performance.now() - t).toFixed(1), "len", big.length);
t = performance.now();
parseInline("_".repeat(20000)); parseInline("*a".repeat(20000)); parseInline("x_".repeat(20000) + "!"); parseInline("*" + "a ".repeat(5000)); parseInline(" _a" + " a".repeat(10000)); parseInline("*a" + "a*".repeat(10000));
console.log("redos ms", (performance.now() - t).toFixed(1));
