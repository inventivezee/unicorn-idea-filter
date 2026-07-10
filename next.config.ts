import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // playwright-core drives Browserbase over CDP from route handlers (the
  // discovery engine); its dynamic requires break under bundling, so load
  // it via native require at runtime instead.
  serverExternalPackages: ["playwright-core"],
  // Externalized packages must ALSO be present in the deployed function's
  // files — Vercel's tracer missed playwright-core (runtime error: "Failed
  // to load external module playwright-core: Cannot find module"), so
  // force-include it for every route that can drive a browser.
  outputFileTracingIncludes: {
    "/api/cron/advance-discovery": ["./node_modules/playwright-core/**/*"],
    "/api/discovery": ["./node_modules/playwright-core/**/*"],
    "/api/discovery/**": ["./node_modules/playwright-core/**/*"],
  },
};

export default nextConfig;
