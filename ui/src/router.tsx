import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Link, lazyRouteComponent } from "@tanstack/react-router";
import { AppShell } from "./components/AppShell";
import { ClassicPage } from "./routes/Classic";
import { OverviewPage } from "./routes/Overview";
import { DEFAULT_DAYS, validRange, WINDOW_DAYS, type WindowDays } from "./lib/period";

/** Global view state lives in the URL, so every view is shareable and Back/Forward just work. */
export interface GlobalSearch {
  month?: string;
  scope?: string;
  days?: WindowDays;
  currency?: string;
  from?: string;
  to?: string;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const SCOPE = /^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$/;
const CURRENCY = /^[A-Za-z]{3}$/;

export function validateGlobalSearch(raw: Record<string, unknown>): GlobalSearch {
  const month = typeof raw.month === "string" && MONTH.test(raw.month) ? raw.month : undefined;
  const scope = typeof raw.scope === "string" && SCOPE.test(raw.scope) ? raw.scope : undefined;
  const parsed = Number(raw.days);
  const days = WINDOW_DAYS.find((d) => d === parsed && d !== DEFAULT_DAYS);
  const currency = typeof raw.currency === "string" && CURRENCY.test(raw.currency) ? raw.currency.toUpperCase() : undefined;
  // A month and a custom range are alternatives; the month wins if a hand-edited URL carries both.
  const from = typeof raw.from === "string" ? raw.from : undefined;
  const to = typeof raw.to === "string" ? raw.to : undefined;
  const range = !month && validRange(from, to) ? { from, to } : {};
  return { month, scope, days: range.from ? undefined : days, currency, ...range };
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
  validateSearch: validateGlobalSearch,
  notFoundComponent: () => (
    <div className="py-24 text-center">
      <p className="text-sm text-muted">There is nothing at this address.</p>
      <Link to="/" className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
        Back to Overview
      </Link>
    </div>
  ),
});

const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });
// Billing brings TanStack Table + Virtual; they load when the route is first hovered or opened.
const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/explore/billing",
  component: lazyRouteComponent(() => import("./routes/Billing"), "BillingPage"),
});
const classicRoute = createRoute({ getParentRoute: () => rootRoute, path: "/classic/$screen", component: ClassicPage });
const resourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/explore/resources",
  component: lazyRouteComponent(() => import("./routes/Resources"), "ResourcesPage"),
});
const anomaliesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/explore/anomalies",
  component: lazyRouteComponent(() => import("./routes/Anomalies"), "AnomaliesPage"),
});
const tagsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/explore/tags",
  component: lazyRouteComponent(() => import("./routes/Tags"), "TagsPage"),
});
const uptimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/explore/uptime",
  component: lazyRouteComponent(() => import("./routes/Uptime"), "UptimePage"),
});
const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/explore/history",
  component: lazyRouteComponent(() => import("./routes/History"), "HistoryPage"),
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/setup",
  component: lazyRouteComponent(() => import("./routes/Setup"), "SetupPage"),
});

const aiBillingRoute = createRoute({ getParentRoute: () => rootRoute, path: "/explore/ai-billing",
  component: lazyRouteComponent(() => import("./routes/AiBilling"), "AiBillingPage") });
const savingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/optimize/savings",
  component: lazyRouteComponent(() => import("./routes/Savings"), "SavingsPage") });
const commitmentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/optimize/commitments",
  component: lazyRouteComponent(() => import("./routes/Commitments"), "CommitmentsPage") });
const performanceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/optimize/performance",
  component: lazyRouteComponent(() => import("./routes/Performance"), "PerformancePage") });
const advisorScoreRoute = createRoute({ getParentRoute: () => rootRoute, path: "/optimize/advisor-score",
  component: lazyRouteComponent(() => import("./routes/AdvisorScore"), "AdvisorScorePage") });
const budgetsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/govern/budgets",
  component: lazyRouteComponent(() => import("./routes/Budgets"), "BudgetsPage") });
const governanceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/govern/governance",
  component: lazyRouteComponent(() => import("./routes/Governance"), "GovernancePage") });
const esuRoute = createRoute({ getParentRoute: () => rootRoute, path: "/govern/esu",
  component: lazyRouteComponent(() => import("./routes/Esu"), "EsuPage") });
const retirementsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/govern/retirements",
  component: lazyRouteComponent(() => import("./routes/Retirements"), "RetirementsPage") });
const changesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/govern/changes",
  component: lazyRouteComponent(() => import("./routes/Changes"), "ChangesPage") });
const updatesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/govern/azure-updates",
  component: lazyRouteComponent(() => import("./routes/AzureUpdates"), "AzureUpdatesPage") });
const reportsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reports/export",
  component: lazyRouteComponent(() => import("./routes/Reports"), "ReportsPage") });
const costDataRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin/cost-data",
  component: lazyRouteComponent(() => import("./routes/CostData"), "CostDataPage") });
const auditRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin/audit",
  component: lazyRouteComponent(() => import("./routes/Audit"), "AuditPage") });

const routeTree = rootRoute.addChildren([overviewRoute, billingRoute, resourcesRoute, anomaliesRoute,
  tagsRoute, uptimeRoute, historyRoute, setupRoute, aiBillingRoute, savingsRoute, commitmentsRoute,
  performanceRoute, advisorScoreRoute, budgetsRoute, governanceRoute, esuRoute, retirementsRoute, changesRoute,
  updatesRoute, reportsRoute, costDataRoute, auditRoute, classicRoute]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    basepath: "/v2",
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
