import { z } from "zod";

// Mirrors the request contract the huddle app sends to /api/web-search.
// Field set is the union of what journey-voice's edge function forwards to
// Tavily plus the explicit huddle contract (see README for the divergence
// notes between journey and this port).
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const RequestSchema = z
  .object({
    // query is forwarded verbatim, exactly as the user spoke it.
    query: z.string().min(1, "query is required"),
    topic: z.enum(["general", "news", "finance"]).default("general"),
    search_depth: z.enum(["basic", "advanced"]).default("advanced"),
    max_results: z.number().int().min(1).max(20).default(5),
    include_answer: z.boolean().default(true),
    include_raw_content: z.boolean().default(false),
    // days is only meaningful for topic=news (Tavily ignores it otherwise).
    days: z.number().int().positive().optional(),
    start_date: DATE.optional(),
    end_date: DATE.optional(),
    include_domains: z.array(z.string()).optional(),
    exclude_domains: z.array(z.string()).optional(),
  })
  .strict();

export type WebSearchRequest = z.infer<typeof RequestSchema>;
