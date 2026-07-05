import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  adapterPath: "next-bun-compile/adapter",
};

export default nextConfig;
