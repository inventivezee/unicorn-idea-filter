import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // playwright-core drives Browserbase over CDP from route handlers (the
  // discovery engine); its dynamic requires break under bundling, so load
  // it via native require at runtime instead.
  serverExternalPackages: ["playwright-core"],
};

export default nextConfig;
