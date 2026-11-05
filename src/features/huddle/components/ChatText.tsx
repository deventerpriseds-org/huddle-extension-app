// WHAT:       Renders an agent's chat message as clean blocks: paragraphs, bullet and numbered lists,
//             headings, quotes, **bold**, `code` and clickable links. React nodes only -- no HTML string
//             is ever injected, and only http(s) URLs become links.
// WHY:        HuddleView showed `{m.text}` raw in whitespace-pre-wrap, so model spacing (a blank line
//             between every bullet) and Markdown (`**Up next**`) showed literally (owner, 2026-11-05).
// SUPERSEDES: the raw `{m.text}` in HuddleView's agent bubble.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   lib/chat-format.ts header; scripts/chat-format.test.ts.
import { Fragment, useMemo } from "react";
import { parseChatBlocks, type Inline } from "../lib/chat-format";

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.t === "bold")
          return (
            <strong key={i} className="font-semibold">
              {p.v}
            </strong>
          );
        if (p.t === "code")
          return (
            <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[12.5px]">
              {p.v}
            </code>
          );
        if (p.t === "link")
          return (
            <a
              key={i}
              href={p.href}
              target="_blank"
              rel="noopener noreferrer"
              title={p.href}
              className="break-all underline underline-offset-2"
              style={{ color: "var(--ai)" }}
            >
              {p.label}
            </a>
          );
        return <Fragment key={i}>{p.v}</Fragment>;
      })}
    </>
  );
}

export function ChatText({ text }: { text: string }) {
  const blocks = useMemo(() => parseChatBlocks(text), [text]);
  return (
    <div className="space-y-2 break-words" data-testid="chat-text">
      {blocks.map((b, i) => {
        if (b.t === "h")
          return (
            <p key={i} className="font-semibold">
              <Inlines parts={b.v} />
            </p>
          );
        if (b.t === "ul" || b.t === "ol") {
          const List = b.t === "ul" ? "ul" : "ol";
          return (
            <List
              key={i}
              className={
                b.t === "ul"
                  ? "list-disc space-y-0.5 pl-5 marker:text-muted-foreground"
                  : "list-decimal space-y-0.5 pl-5 marker:text-muted-foreground"
              }
            >
              {b.items.map((it, j) => (
                <li key={j} className="pl-0.5">
                  <Inlines parts={it} />
                </li>
              ))}
            </List>
          );
        }
        const lines = b.lines;
        const body = lines.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            <Inlines parts={l} />
          </Fragment>
        ));
        if (b.t === "quote")
          return (
            <blockquote key={i} className="border-l-2 border-hairline pl-3 text-muted-foreground">
              {body}
            </blockquote>
          );
        return <p key={i}>{body}</p>;
      })}
    </div>
  );
}
