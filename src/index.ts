import { join } from "node:path";
import type { NextAdapter } from "next/dist/build/adapter/build-complete";

// Packages that use dynamic require() calls which break in compiled binaries.
// Users can add more via transpilePackages in their next.config.
const knownTranspilePackages = ["pino", "pino-pretty"];

const adapter: NextAdapter = {
  name: "next-bun-compile",

  modifyConfig(config, { phase }) {
    if (phase !== "phase-production-build") return config;

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

  // onBuildComplete runs BEFORE standalone output is written (Next.js alpha API).
  // We save the context so the CLI can use it, but the actual compilation
  // must happen after `next build` finishes via the `next-bun-compile` CLI.
  async onBuildComplete(ctx) {
    // Store build context for the CLI to pick up
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
