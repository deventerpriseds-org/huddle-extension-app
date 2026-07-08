import { createFileRoute } from "@tanstack/react-router";
import { HuddleApp } from "@/features/huddle/components/HuddleApp";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <>
      <HuddleApp />
      <Toaster position="top-right" richColors />
    </>
  );
}
