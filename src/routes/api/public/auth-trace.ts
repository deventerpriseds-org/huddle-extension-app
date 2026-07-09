import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

const MAX_BODY_BYTES = 32_000;

function redactString(value: string) {
  return value
    .replace(/([?&](?:code|client_info|id_token|access_token|refresh_token|state|session_state)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/#(?:code|client_info|id_token|access_token|refresh_token|state|session_state)=[^\s]+/gi, "#[redacted]")
    .slice(0, 1_500);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object" && value) {
    const safe: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, 30)) {
      if (/^(code|client_info|id_token|access_token|refresh_token|state|session_state)$/i.test(key)) {
        safe[key] = "[redacted]";
      } else {
        safe[key] = redactValue(nestedValue, depth + 1);
      }
    }
    return safe;
  }
  return String(value).slice(0, 500);
}

export const Route = createFileRoute("/api/public/auth-trace")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentLength = Number(request.headers.get("content-length") ?? 0);
        if (contentLength > MAX_BODY_BYTES) {
          return new Response(JSON.stringify({ ok: false, error: "payload_too_large" }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        console.info("[huddle-auth-trace]", JSON.stringify(redactValue(payload)));

        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});