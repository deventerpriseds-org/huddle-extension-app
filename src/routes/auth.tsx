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
        content: "Sign in to Huddle with your Google account.",
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
          <svg className="h-5 w-5 flex-shrink-0" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
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
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "See console" : "Copy trace"}
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
  const errorEntry = [...trace]
    .reverse()
    .find((entry) => entry.event.includes(":error") || typeof entry.details?.message === "string");
  const message = typeof errorEntry?.details?.message === "string" ? errorEntry.details.message : "";

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
