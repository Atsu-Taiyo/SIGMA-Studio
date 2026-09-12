import path from "node:path";
import type { NextConfig } from "next";

const isDesktopBuild = process.env.NEXT_PUBLIC_TARGET === "desktop";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  output: "export",
  assetPrefix: isDesktopBuild ? "./" : undefined,
  images: {
    unoptimized: true,
  },
  turbopack: {
    // このアプリは `apps/desktop` にあるが、npm の lockfile はリポジトリ直下。
    root: path.join(__dirname, "../.."),
  },
};

export default nextConfig;
