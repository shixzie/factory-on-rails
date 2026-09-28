import type { NextConfig } from "next";

const config: NextConfig = {
  // The harness sits behind this app on the private network; its routes are
  // forwarded by src/app/api and src/app/auth, not by rewrites, so the target
  // is read at runtime rather than baked in at build time.
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
