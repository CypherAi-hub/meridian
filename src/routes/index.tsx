import { createFileRoute } from "@tanstack/react-router";
import { OmniApp } from "@/components/omni/omni-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <OmniApp />;
}
