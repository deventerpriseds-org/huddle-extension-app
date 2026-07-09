import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { getCurrentUser, initMsal, traceAuth } from "@/lib/entra-auth";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    traceAuth("route:/_authenticated:beforeLoad:start");
    await initMsal();
    if (!getCurrentUser()) {
      traceAuth("route:/_authenticated:redirect-auth", {
        hasUser: false,
      });
      throw redirect({ to: "/auth" });
    }
    traceAuth("route:/_authenticated:allow", { hasUser: true });
  },
  component: () => <Outlet />,
});
