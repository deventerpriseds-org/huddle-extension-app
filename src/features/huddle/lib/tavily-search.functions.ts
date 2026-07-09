import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export interface TavilySearchArgs {
  query: string;
  topic?: "general" | "news" | "finance";
  search_depth?: "basic" | "advanced";
  time_range?: "day" | "week" | "month" | "year";
  start_date?: string;
  end_date?: string;
  include_domains?: string[];
  exclude_domains?: string[];
  max_results?: number;
}

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

export interface TavilySearchResponse {
  success: boolean;
  answer: string;
  sources: string[];
  results?: TavilySearchResult[];
  query: string;
  error?: string;
  paramsUsed?: TavilySearchArgs;
}

export const TavilyInput = z.object({
  query: z.string().min(1),
  topic: z.enum(["general", "news", "finance"]).optional(),
  search_depth: z.enum(["basic", "advanced"]).optional(),
  time_range: z.enum(["day", "week", "month", "year"]).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  include_domains: z.array(z.string()).optional(),
  exclude_domains: z.array(z.string()).optional(),
  max_results: z.number().int().min(1).max(20).optional(),
});

function env(): { key: string; configured: boolean } {
  const key = (process.env.TAVILY_API_KEY ?? "").trim();
  return { key, configured: !!key };
}

/**
 * Call the Tavily search API directly from the server.
 *
 * This mirrors the `supabase/functions/web-search` edge function used in
 * journey-voice, but runs inside a TanStack server function so it works in
 * this non-Supabase project until the Azure version is ready.
 */
export async function tavilySearch(args: TavilySearchArgs): Promise<TavilySearchResponse> {
  const { key, configured } = env();

  if (!configured) {
    return {
      success: false,
      answer: "Web search is not configured. Please add the TAVILY_API_KEY secret.",
      sources: [],
      query: args.query,
      error: "TAVILY_API_KEY not configured",
    };
  }

  const requestBody: Record<string, unknown> = {
    query: args.query,
    topic: args.topic || "general",
    search_depth: args.search_depth || "advanced",
    max_results: args.max_results || 10,
    include_answer: "advanced",
    include_raw_content: false,
    include_favicon: false,
  };

  if (args.time_range) requestBody.time_range = args.time_range;
  if (args.start_date) requestBody.start_date = args.start_date;
  if (args.end_date) requestBody.end_date = args.end_date;
  if (args.include_domains?.length) requestBody.include_domains = args.include_domains;
  if (args.exclude_domains?.length) requestBody.exclude_domains = args.exclude_domains;

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        success: false,
        answer: "I couldn't search for that information right now. Please try again.",
        sources: [],
        query: args.query,
        error: `Tavily API error ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as {
      answer?: string;
      results?: TavilySearchResult[];
    };

    const answer = data.answer || "No results found.";
    const sources = data.results?.map((r) => r.url) || [];
    const results = data.results?.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      published_date: r.published_date,
    }));

    return {
      success: true,
      answer,
      sources,
      results,
      query: args.query,
      paramsUsed: {
        topic: requestBody.topic,
        search_depth: requestBody.search_depth,
        time_range: requestBody.time_range,
        start_date: requestBody.start_date,
        end_date: requestBody.end_date,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      answer: "I encountered an error while searching. Let me help with what I know.",
      sources: [],
      query: args.query,
      error: msg,
    };
  }
}

export const tavilyWebSearch = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => TavilyInput.parse(raw))
  .handler(async ({ data }): Promise<TavilySearchResponse> => tavilySearch(data));

export const checkTavilyConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ configured: boolean; error?: string }> => {
    const { configured } = env();
    return { configured };
  },
);
