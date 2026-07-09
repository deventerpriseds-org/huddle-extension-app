import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { RequestSchema } from "../lib/validate";
import { callTavily } from "../lib/tavily";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function webSearch(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  if (req.method === "OPTIONS") {
    return { status: 204, headers: CORS };
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { status: 400, headers: CORS, jsonBody: { error: "invalid_json" } };
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      headers: CORS,
      jsonBody: { error: "invalid_request", issues: parsed.error.issues },
    };
  }

  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    ctx.error("[web-search] TAVILY_API_KEY not configured");
    return { status: 500, headers: CORS, jsonBody: { error: "missing_TAVILY_API_KEY" } };
  }

  const result = await callTavily(parsed.data, key, ctx);
  return { status: result.status, headers: CORS, jsonBody: result.body };
}

app.http("web-search", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "web-search",
  handler: webSearch,
});
