import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { getCurrentUser } from "@/lib/entra-auth";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: () => {
    if (!getCurrentUser()) {
      throw redirect({ to: "/auth" });
    }
  },
  component: () => <Outlet />,
});
