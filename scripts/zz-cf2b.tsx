import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ChatText } from "../src/features/huddle/components/ChatText";
for (const t of ["1. a\n3. b\n7. c", "3. a\n2. b\n1. c", "1. a\n1. b\n1. c", "0. zero\n1. one"]) console.log(JSON.stringify(t), "=>", renderToStaticMarkup(createElement(ChatText, { text: t })).replace(/ class="[^"]*"/g, ""));
