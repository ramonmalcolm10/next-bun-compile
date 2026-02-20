import { join } from "node:path";
import type { NextAdapter } from "next/dist/build/adapter/build-complete";

const adapter: NextAdapter = {
  name: "next-bun-compile",

  modifyConfig(config) {
    if (config.output !== "standalone") {
      console.warn(
        'next-bun-compile: Setting output to "standalone" (required for compilation)'
      );
      config.output = "standalone";
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
      })
    );
  },
};

export default adapter;
export { generateEntryPoint } from "./generate.js";
export { compile } from "./compile.js";
