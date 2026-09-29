import "@fontsource-variable/inter/wght.css";
import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, MotionConfig } from "motion/react";
import { ApiError } from "./lib/api";
import { makeRouter } from "./router";

const motionFeatures = () => import("./lib/motion-features").then((mod) => mod.default);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cost data changes at most a few times a day (R8): keep it fresh for five minutes and
      // in memory for thirty, so moving between screens and back is instant.
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

const router = makeRouter(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <LazyMotion features={motionFeatures} strict>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </LazyMotion>
    </MotionConfig>
  </StrictMode>,
);
