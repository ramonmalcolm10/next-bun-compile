import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  adapterPath: import.meta.resolve("next-bun-compile"),
};

export default nextConfig;
