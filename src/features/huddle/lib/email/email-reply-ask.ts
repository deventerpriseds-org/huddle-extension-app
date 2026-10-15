// WHAT:       The email-reply card's data shape (rides on an agent reply like confirmAsk does) and the
//             propose_email_reply tool that puts it there.
// WHY:        Owner, 2026-10-15: the reply offer must be a BUTTON with its context baked in, not "say yes".
//             Import-free so the client and server share ONE definition of the card shape.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/memory.md "STANDING RULE ... BUTTON with its context baked in".

/** On the reply / HuddleMessage. The card carries display text; every ACTION re-reads the server row
 *  by `emailId` (chat.email_replies), never this copy. `resolved` is client-only, like confirmAsk's. */
export interface EmailReplyAsk {
  emailId: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  /** The reply Iris proposed. Empty when she did not call the tool (card still offers Dismiss). */
  replyBody: string;
  resolved?: "drafted" | "dismissed";
}

export const PROPOSE_EMAIL_REPLY_TOOL = {
  type: "function",
  name: "propose_email_reply",
  description:
    "Call this in the SAME message whenever you suggest (or revise) a reply to an email the owner " +
    "received — after a new-email alert, or when he asks you to change a suggested reply. It stores your " +
    "reply against that email and puts Save to Drafts / No reply needed buttons under your message. It " +
    "does NOT save a draft or send anything. Give email_id when you have it; otherwise from_address.",
  parameters: {
    type: "object",
    properties: {
      email_id: {
        type: "string",
        description: "The EMAIL ID given to you in the new-email alert, exactly.",
      },
      from_address: {
        type: "string",
        description:
          "If you have no email_id (e.g. he asked you to revise a reply): the sender's email address.",
      },
      reply_body: {
        type: "string",
        description:
          "The reply text exactly as you suggested it in your message, written as the owner (first person), " +
          "without the quoted original.",
      },
    },
    required: ["reply_body"],
  },
} as const;

/** Parse the tool's recorded detail back into the card. Shape-checked; anything off -> undefined. */
export function emailReplyAskFromDetail(detail: unknown): EmailReplyAsk | undefined {
  if (typeof detail !== "string") return undefined;
  try {
    const p = JSON.parse(detail) as Record<string, unknown>;
    if (typeof p.emailId !== "string" || !p.emailId) return undefined;
    return {
      emailId: p.emailId,
      fromName: typeof p.fromName === "string" ? p.fromName : "",
      fromAddress: typeof p.fromAddress === "string" ? p.fromAddress : "",
      subject: typeof p.subject === "string" ? p.subject : "",
      replyBody: typeof p.replyBody === "string" ? p.replyBody : "",
    };
  } catch {
    return undefined;
  }
}
