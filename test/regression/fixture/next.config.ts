import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Bare specifier — the package's root default export must carry
  // onBuildComplete, or Next silently skips the adapter (no binary).
  // The "/adapter" subpath is an equivalent alias.
  adapterPath: "next-bun-compile",
};

export default nextConfig;
