import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Link, lazyRouteComponent } from "@tanstack/react-router";
import { AppShell } from "./components/AppShell";
import { ClassicPage } from "./routes/Classic";
import { OverviewPage } from "./routes/Overview";

/** Global view state lives in the URL, so every view is shareable and Back/Forward just work. */
export interface GlobalSearch {
  month?: string;
  scope?: string;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const SCOPE = /^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$/;

export function validateGlobalSearch(raw: Record<string, unknown>): GlobalSearch {
  const month = typeof raw.month === "string" && MONTH.test(raw.month) ? raw.month : undefined;
  const scope = typeof raw.scope === "string" && SCOPE.test(raw.scope) ? raw.scope : undefined;
  return { month, scope };
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

const routeTree = rootRoute.addChildren([overviewRoute, billingRoute, resourcesRoute, classicRoute]);

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
