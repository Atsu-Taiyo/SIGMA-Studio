import path from "node:path";
import type { NextConfig } from "next";

const isDesktopBuild = process.env.NEXT_PUBLIC_TARGET === "desktop";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  output: process.env.SIGMA_STUDIO_DEV_SESSION ? undefined : "export",
  distDir: process.env.SIGMA_STUDIO_DEV_SESSION ? ".next-electron" : ".next",
  ...(process.env.SIGMA_STUDIO_DEV_SESSION ? {
    async headers() {
      return [{ source: "/:path*", headers: [{ key: "x-sigma-dev-session", value: process.env.SIGMA_STUDIO_DEV_SESSION! }] }];
    },
  } : {}),
  assetPrefix: isDesktopBuild ? "./" : undefined,
  images: {
    unoptimized: true,
  },
  // emf-converter reads these raster diagnostic offsets without a browser guard.
  env: { HDX: "0", HDY: "0" },
  turbopack: {
    // このアプリは `apps/desktop` にあるが、npm の lockfile はリポジトリ直下。
    root: path.join(__dirname, "../.."),
  },
};

export default nextConfig;
