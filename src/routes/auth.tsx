import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  clearAuthTrace,
  getAuthTrace,
  getCurrentUser,
  initMsal,
  signIn,
  traceAuth,
  type AuthTraceEntry,
} from "@/lib/entra-auth";

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    traceAuth("route:/auth:beforeLoad:start");
    await initMsal();
    if (getCurrentUser()) {
      traceAuth("route:/auth:redirect-home", { hasUser: true });
      throw redirect({ to: "/" });
    }
    traceAuth("route:/auth:allow", { hasUser: false });
  },
  head: () => ({
    meta: [
      { title: "Sign in — Huddle" },
      {
        name: "description",
        content: "Sign in to Huddle with your Microsoft account.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const [trace, setTrace] = useState<AuthTraceEntry[]>([]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    setTrace(getAuthTrace());
  }, []);

  const handleLogin = async () => {
    try {
      clearAuthTrace();
      setTrace([]);
      traceAuth("auth-page:button-click");
      setTrace(getAuthTrace());
      await signIn();
    } catch (err) {
      traceAuth("auth-page:signin-error", {
        name: err instanceof Error ? err.name : "unknown",
        message: err instanceof Error ? err.message : String(err),
      });
      setTrace(getAuthTrace());
      console.error("[auth] signIn failed", err);
    }
  };

  const handleCopyTrace = async () => {
    const latestTrace = getAuthTrace();
    setTrace(latestTrace);
    try {
      await navigator.clipboard.writeText(JSON.stringify(latestTrace, null, 2));
      setCopyState("copied");
    } catch (err) {
      setCopyState("failed");
      console.info("[huddle-auth] copy this trace", latestTrace, err);
    }
  };

  const handleClearTrace = () => {
    clearAuthTrace();
    setTrace([]);
    setCopyState("idle");
  };

  const lastTraceEvent = trace.at(-1)?.event ?? "none";
  const authFailure = getAuthFailure(trace);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-hairline bg-surface p-8 shadow-lg">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <svg
              className="h-7 w-7"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.75}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 8h2a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2h2m10 0V6a3 3 0 00-3-3h-4a3 3 0 00-3 3v2m10 0H7"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Huddle</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Chat, huddle, and run a team of AI agents
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <hr className="flex-1 border-hairline" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Sign in
          </span>
          <hr className="flex-1 border-hairline" />
        </div>

        <button
          onClick={handleLogin}
          className="inline-flex w-full items-center justify-center gap-3 rounded-md border border-hairline bg-background px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          <svg className="h-5 w-5 flex-shrink-0" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 2h9.5v9.5H2z" fill="#F25022" />
            <path d="M12.5 2H22v9.5h-9.5z" fill="#7FBA00" />
            <path d="M2 12.5h9.5V22H2z" fill="#00A4EF" />
            <path d="M12.5 12.5H22V22h-9.5z" fill="#FFB900" />
          </svg>
          Continue with Microsoft
        </button>

        {authFailure ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
            <p className="font-medium">{authFailure.title}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{authFailure.message}</p>
          </div>
        ) : null}

        <p className="text-center text-[11px] text-muted-foreground">
          Secured by Microsoft Entra External ID.
        </p>

        <div className="space-y-2 rounded-md border border-hairline bg-muted/40 p-3 text-[11px] text-muted-foreground">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate font-mono">Auth trace: {lastTraceEvent}</span>
            <span className="shrink-0 font-mono">{trace.length}</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCopyTrace}
              className="inline-flex flex-1 items-center justify-center rounded-md border border-hairline bg-background px-2 py-1.5 font-medium text-foreground transition hover:bg-muted"
            >
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "See console"
                  : "Copy trace"}
            </button>
            <button
              type="button"
              onClick={handleClearTrace}
              className="inline-flex items-center justify-center rounded-md border border-hairline bg-background px-2 py-1.5 font-medium text-foreground transition hover:bg-muted"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getAuthFailure(trace: AuthTraceEntry[]) {
  const attemptEvents = ["auth-page:button-click", "signin:start", "signin:redirect:start"];
  let latestAttemptIndex = -1;

  for (let index = trace.length - 1; index >= 0; index -= 1) {
    if (attemptEvents.includes(trace[index].event)) {
      latestAttemptIndex = index;
      break;
    }
  }

  if (latestAttemptIndex === -1) return null;

  const attemptTrace = trace.slice(latestAttemptIndex);
  const completed = attemptTrace.some((entry) =>
    [
      "signin:popup:complete",
      "msal:active-account:set-from-redirect",
      "msal:active-account:recovered-from-cache",
      "route:/auth:redirect-home",
    ].includes(entry.event),
  );

  if (completed) return null;

  const errorEntry = [...attemptTrace].reverse().find((entry) => entry.event.includes(":error"));
  const errorTime = errorEntry ? Date.parse(errorEntry.t) : Number.NaN;

  if (!errorEntry || (Number.isFinite(errorTime) && Date.now() - errorTime > 2 * 60 * 1_000)) {
    return null;
  }

  const message =
    typeof errorEntry?.details?.message === "string" ? errorEntry.details.message : "";

  if (message.includes("AADSTS9002326")) {
    return {
      title: "Microsoft rejected this redirect URI",
      message:
        "This app registration is configured as a Web client, but browser sign-in must use the Single-page application platform. In Microsoft Entra External ID, add this site's origin under Authentication → Single-page application redirect URIs, then remove the same origin from Web redirect URIs if it is listed there.",
    };
  }

  if (message) {
    return {
      title: "Sign-in did not complete",
      message,
    };
  }

  return null;
}
