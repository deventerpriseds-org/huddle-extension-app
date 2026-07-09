import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { getCurrentUser, initMsal } from "@/lib/entra-auth";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    await initMsal();
    if (!getCurrentUser()) {
      throw redirect({ to: "/auth" });
    }
  },
  component: () => <Outlet />,
});
