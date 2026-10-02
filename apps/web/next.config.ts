import type { NextConfig } from "next";

const config: NextConfig = {
  // The harness sits behind this app on the private network; its routes are
  // forwarded by src/app/api and src/app/auth, not by rewrites, so the target
  // is read at runtime rather than baked in at build time.
  poweredByHeader: false,
  // No Next.js badge in the corner during `next dev` (it shows up in screenshots and recordings).
  devIndicators: false,
  reactStrictMode: true,
};

export default config;
