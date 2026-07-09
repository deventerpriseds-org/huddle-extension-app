import { createFileRoute, redirect } from "@tanstack/react-router";
import { getCurrentUser, signIn } from "@/lib/entra-auth";

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: () => {
    if (getCurrentUser()) {
      throw redirect({ to: "/" });
    }
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
  const handleLogin = async () => {
    try {
      await signIn();
    } catch (err) {
      console.error("[auth] signIn failed", err);
    }
  };

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

        <p className="text-center text-[11px] text-muted-foreground">
          Secured by Microsoft Entra External ID.
        </p>
      </div>
    </div>
  );
}
