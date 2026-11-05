import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ChatText } from "../src/features/huddle/components/ChatText";
const R = (t: string) => renderToStaticMarkup(createElement(ChatText, { text: t }));
const cases: Record<string, string> = {
  A1_rep: "**Up next**\n\nHere is `code` and https://zoom.us/j/1?pwd=x.\n\n- one\n- two\n\n1. a\n2. b",
  A1_xss:
    "<img src=x onerror=alert(1)> **<b>x</b>** [click](javascript:alert(1)) javascript:alert(1) [d](data:text/html,x) ftp://a.b/c [ok](https://ok.com/a)",
  A1_mdhttp: '[evil](https://a.com/"onmouseover=alert(1)) and https://x.com/a"b<c',
  A1_caseHTTP: "HTTPS://EVIL.com/x and Https://a.b",
  L1_ol: "1. first\n\nnote\n\n3. third",
  L1_quote: ">50% of tasks done",
  L1_head: "# of tasks: 5",
  L1_under: "call __init__ then __main__",
  A2_blank: "- a\n\n- b\n\n\n- c",
  A2_nums: "Revenue 1,234.56 up 3.5% — 2024-11-05 at 9:30. Pay $1.00 now",
  N_ol_mixed: "1) one\n2. two\n10. ten",
  N_ol_gap_bullets: "1. a\n\n2. b\n\n3. c",
  N_quote_ok: "> quoted line\n> second",
  N_head_ok: "## Today\ntext",
  N_head_lower: "# heading lowercase",
  N_headunicode: "# Été plans",
  N_dash: "-5 degrees today\n-- signed\n- real item",
  N_star: "*emphasis* and * not list\n*bold start",
  N_ol_year: "2024. was a good year",
  N_ol_year3: "200. items shipped",
  N_ol_zero: "0. zero item\n1. one",
  N_time: "9.30 meeting",
  N_bold_multi: "**a** and **b** and ** c **",
  N_code_bold: "`**not bold**` and **`code`**",
  N_greet: "Hello Sir,\n\njust a reminder",
  N_nested: "- a\n  - nested\n- b",
  N_quote_list: "> - a\n> - b",
  N_heading_hash_end: "# Title ##",
  N_hashtag: "#Launch day",
  N_url_paren: "see (https://en.wikipedia.org/wiki/Foo_(bar)) ok",
  N_emoji_bullet: "• Item one\n· item two",
  N_plain: "Just a normal sentence with a > sign and a # hash and 3) things.",
  N_math: "2 * 3 * 4 = 24",
  N_mid_ol: "Steps:\n1. a\n2. b",
  N_ul_then_ol: "- a\n1. b",
};
for (const [k, v] of Object.entries(cases)) {
  console.log(`--- ${k}\nIN : ${JSON.stringify(v)}\nOUT: ${R(v)}`);
}
