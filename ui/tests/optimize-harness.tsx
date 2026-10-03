import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider, useSearch } from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { SavingsPage } from "../src/routes/Savings";
import { CommitmentsPage } from "../src/routes/Commitments";
import { PerformancePage } from "../src/routes/Performance";
import { AiBillingPage } from "../src/routes/AiBilling";
import "../src/styles.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRootRoute({
  validateSearch: (raw: Record<string, unknown>) => ({ scope: typeof raw.scope === "string" ? raw.scope : undefined, screen: typeof raw.screen === "string" ? raw.screen : "savings" }),
});
function Screen() {
  const search = useSearch({ strict: false }) as { screen: string };
  return <main className="mx-auto max-w-[1500px] p-6">{search.screen === "performance" ? <PerformancePage /> : search.screen === "ai" ? <AiBillingPage /> : search.screen === "commitments" ? <CommitmentsPage /> : <SavingsPage />}</main>;
}
const page = createRoute({ getParentRoute: () => root, path: "/", component: Screen });
const router = createRouter({ routeTree: root.addChildren([page]), basepath: "/v2/tests/optimize-browser.html" });
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={client}><LazyMotion features={domAnimation}><RouterProvider router={router} /></LazyMotion></QueryClientProvider></React.StrictMode>);
