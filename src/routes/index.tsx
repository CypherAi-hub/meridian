import { createFileRoute } from "@tanstack/react-router";
import { DeskApp } from "@/components/desk/desk-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <DeskApp />;
}
