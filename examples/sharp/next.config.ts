import { createRequire } from "node:module";
import type { NextConfig } from "next";

// Resolve from the app dir — needed for linked/workspace installs; a
// normally-installed package can use the bare string instead:
//   adapterPath: "next-bun-compile/adapter"
const req = createRequire(process.cwd() + "/");

const nextConfig: NextConfig = {
  adapterPath: req.resolve("next-bun-compile/adapter"),
};

export default nextConfig;
