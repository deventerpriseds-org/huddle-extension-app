import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ChatText } from "../src/features/huddle/components/ChatText";
const R = (t: string) =>
  renderToStaticMarkup(createElement(ChatText, { text: t }))
    .replace(/ class="[^"]*"/g, "")
    .replace(/ style="[^"]*"/g, "")
    .replace(/<div data-testid="chat-text">|<\/div>$/g, "");
const cases: [string, string][] = [
  ["S-1", "• a\n• b"], ["S-2", "- a\n- b"], ["S-2b", "* a\n* b"], ["S-3", "+ a\n+ b"], ["S-4", "• a\n\n• b\n\n• c"],
  ["S-5", "1. a\n2. b"], ["S-5b", "1) a\n2) b"], ["S-6", "3. a\n2. b\n1. c"], ["S-7", "- item\n  - sub item"], ["S-8", "- [ ] buy milk"],
  ["S-9a", "**Up next**"], ["S-9b", "**Up next:**"], ["S-9c", "**Up next**:"], ["S-10", "__Up next__"], ["S-11a", "*note*"], ["S-11b", "_note_"],
  ["S-12", "_(fallback: x; y)_"], ["S-13", "***really***"], ["S-13b", "**_y_**"], ["S-13c", "***x***"], ["S-14", "## Today"], ["S-15", "## next steps"],
  ["S-16", "# of tasks: 5\n#1 priority\n#hashtag"], ["S-17", "> quoted line"], ["S-18", ">50% done\n5 > 3"], ["S-19", "> a\n>\n> b"], ["S-20", "`npm run x`"],
  ["S-21", "```\n# Not a heading\n- not a list\n```"], ["S-22", "https://zoom.us/j/1?pwd=SECRET"], ["S-23a", "See https://x.com/a."], ["S-23b", "(https://x.com/a)"], ["S-23c", "https://x.com/a,"],
  ["S-24", "https://en.wikipedia.org/wiki/Foo_(bar)"], ["S-25", "[wiki](https://en.wikipedia.org/wiki/Foo_(bar))"], ["S-26", "<https://x.com>"], ["S-27", "**https://x.com/a**"],
  ["S-28", "javascript:alert(1) [x](javascript:alert(1)) data:text/html,<script>x</script>"], ["S-29", "<b>hi</b> <img src=x onerror=alert(1)>"], ["S-30", "mailto:a@b.com a@b.com +1 (555) 010-0000"],
  ["S-32a", "Note here.\n10. That's the deadline"], ["S-32b", "2026. What a year"], ["S-32c", "Steps:\n2. a"], ["S-32d", "Intro.\n1. a"], ["S-33", "-5°F tonight\n\n- 5 tasks left"], ["S-34", "✅ Done\n✅ Next\n⚠️ Blocked"],
  ["S-35", "Hello Sir,\n\njust a reminder"], ["S-37", "Best,  \nVon"], ["S-37b", "Best,\\\nVon"], ["S-38", "a\r\nb\rc"], ["S-39", "| a | b |\n|---|---|\n| 1 | 2 |"], ["S-40", "---\n\n***"], ["S-41", "• item\n  continued on next line"],
  ["X1", "I <3 you"], ["X2", "a < b > c"], ["X3", "<b>https://x.com</b>"], ["X4", "<https://x.com/a>b>"], ["X5", "<javascript:alert(1)>"], ["X6", "**see https://x.com/a now**"],
  ["X7", "foo***bar***baz"], ["X8", "2***3***4"], ["X9", "***"], ["X10", "**a** and ***b*** and *c*"], ["X11", "Note.\n2. second\n3. third"], ["X12", "Para one\n1. a\n2. b"],
  ["X13", "Note.\n10) deadline"], ["X14", "Lead:\n10. x\n11. y"], ["X15", "- a\nNote.\n2. b"], ["X16", "1. a\nNote\n2. b"], ["X17", "<https://x.com/\"onmouseover=alert(1)>"],
  ["X18", "[x](https://x.com/\"onclick=alert(1))"], ["X19", "**https://x.com/a b**"], ["X20", "***https://x.com***"], ["X21", "<https://x.com>>"], ["X22", "```js\n  indented\n\n\n  x  \n```"],
  ["X23", "text\n```\nunclosed\n- item"], ["X24", "**bold *it* bold**"], ["X25", "<ftp://x.com>"], ["X26", "<http://x>"], ["X27", "I scored 5 < 7 and <3 <https://a.io> ok"],
  ["X28", "Day 1.\n2. Two"], ["X29", "Hi.\n\n10. That's"], ["X30", "Note here.\n  10. indented"], ["X31", "Total: 3 items.\n2. Second"], ["X32", "**Note:** 2*3*4 = 24 and a_b_c"],
];
for (const [k, t] of cases) console.log(k.padEnd(6), JSON.stringify(t).slice(0, 60).padEnd(62), "=>", R(t));
const big = Array.from({ length: 400 }, (_, i) => `• item ${i} **b** https://x.com/${"a".repeat(i % 3 ? 10 : 300)}`).join("\n");
const t0 = performance.now();
R(big);
console.log("S-42 len", big.length, "ms", (performance.now() - t0).toFixed(1));
