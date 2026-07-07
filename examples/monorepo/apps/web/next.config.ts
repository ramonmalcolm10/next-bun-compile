import { createRequire } from "node:module";
import type { NextConfig } from "next";

// In a monorepo, Next resolves adapterPath from its own package location —
// resolve from the app dir instead so nested devDependencies are found.
const req = createRequire(process.cwd() + "/");

const nextConfig: NextConfig = {
  adapterPath: req.resolve("next-bun-compile"),
};

export default nextConfig;
