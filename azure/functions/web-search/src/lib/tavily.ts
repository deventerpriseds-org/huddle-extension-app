import type { InvocationContext } from "@azure/functions";
import type { WebSearchRequest } from "./validate";

const TAVILY_URL = "https://api.tavily.com/search";
const TIMEOUT_MS = 25_000;
const MAX_UPSTREAM_BODY = 2 * 1024; // 2KB

export interface TavilyResult {
  status: number;
  // On success: Tavily's JSON verbatim (unwrapped).
  // On failure: our error envelope.
  body: unknown;
}

/**
 * Build the Tavily request body from the validated huddle request and call
 * Tavily. Forwards the validated fields verbatim — no rename, no translate,
 * no api_key in the body (Tavily accepts the bearer header).
 *
 * Same-day range guard: Tavily rejects a range where start_date === end_date.
 * We forward only start_date and drop end_date in that case.
 *
 * NOTE: journey-voice's edge function does NOT implement this guard (it has no
 * start_date/end_date equality branch), so this is an additive safeguard the
 * huddle contract asked for, not a literal mirror of journey.
 */
export async function callTavily(
  req: WebSearchRequest,
  apiKey: string,
  ctx: InvocationContext,
): Promise<TavilyResult> {
  const requestBody: Record<string, unknown> = {
    query: req.query,
    topic: req.topic,
    search_depth: req.search_depth,
    max_results: req.max_results,
    include_answer: req.include_answer,
    include_raw_content: req.include_raw_content,
  };

  if (req.days !== undefined) requestBody.days = req.days;
  if (req.include_domains?.length) requestBody.include_domains = req.include_domains;
  if (req.exclude_domains?.length) requestBody.exclude_domains = req.exclude_domains;

  // Same-day range guard.
  if (req.start_date && req.end_date && req.start_date === req.end_date) {
    requestBody.start_date = req.start_date;
    // end_date intentionally dropped.
  } else {
    if (req.start_date) requestBody.start_date = req.start_date;
    if (req.end_date) requestBody.end_date = req.end_date;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const started = Date.now();
    const response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    ctx.log(`[web-search] Tavily responded ${response.status} in ${Date.now() - started}ms`);

    if (!response.ok) {
      const raw = await response.text();
      return {
        status: 502,
        body: {
          error: "tavily_upstream_error",
          upstreamStatus: response.status,
          upstreamBody: raw.slice(0, MAX_UPSTREAM_BODY),
        },
      };
    }

    // Return Tavily's JSON verbatim, unwrapped.
    const data = await response.json();
    return { status: 200, body: data };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    ctx.error(`[web-search] Tavily call failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      status: 502,
      body: {
        error: aborted ? "tavily_timeout" : "tavily_fetch_failed",
        upstreamStatus: 0,
        upstreamBody: aborted
          ? `request exceeded ${TIMEOUT_MS}ms`
          : (err instanceof Error ? err.message : String(err)).slice(0, MAX_UPSTREAM_BODY),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
