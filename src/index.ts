import { join } from "node:path";
import type { NextAdapter } from "next/dist/build/adapter/build-complete";

// Packages that use dynamic require() calls which break in compiled binaries.
// Users can add more via transpilePackages in their next.config.
const knownTranspilePackages = ["pino", "pino-pretty"];

const adapter: NextAdapter = {
  name: "next-bun-compile",

  modifyConfig(config, ctx) {
    if (!ctx) {
      throw new Error(
        "next-bun-compile: Next.js 16+ is required. Please upgrade your Next.js version."
      );
    }

    if (ctx.phase !== "phase-production-build") return config;

    if (process.argv.includes("--webpack")) {
      throw new Error(
        "next-bun-compile: Webpack builds are not supported. Remove --webpack to use Turbopack (default)."
      );
    }

    if (config.output !== "standalone") {
      console.warn(
        'next-bun-compile: Setting output to "standalone" (required for compilation)'
      );
      config.output = "standalone";
    }

    const existing = config.transpilePackages ?? [];
    const toAdd = knownTranspilePackages.filter((p) => !existing.includes(p));
    if (toAdd.length > 0) {
      config.transpilePackages = [...existing, ...toAdd];
    }

    return config;
  },

  async onBuildComplete(ctx) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(ctx.distDir, "bun-compile-ctx.json"),
      JSON.stringify({
        distDir: ctx.distDir,
        projectDir: ctx.projectDir,
        assetPrefix: ctx.config.assetPrefix || "",
      })
    );
  },
};

export default adapter;
export { generateEntryPoint } from "./generate.js";
export { compile } from "./compile.js";
