import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { generateEntryPoint } from "./generate.js";
import { compile } from "./compile.js";

export interface RunBuildOptions {
  projectDir: string;
  /** The adapter-assembled standalone-layout input tree. */
  standaloneDir: string;
  /** App dir inside that tree (nested for monorepo layouts). */
  serverDir: string;
  /** Extra args appended to the `bun build` invocation. */
  extraArgs?: string[];
}

/**
 * The server orchestration graph the runtime boots (router-server →
 * next-server chain) is loaded at runtime from the extracted tree via
 * computed requires — the bundler never sees it, so no framework code is
 * compiled into the binary and nothing is carried twice. Neither Next's
 * standalone output nor the adapter's per-route traces include that graph,
 * so trace it here (with the same pruning `output: "standalone"` applies)
 * and copy it into the input tree before assets are embedded.
 */
async function ensureServerRuntime(
  projectDir: string,
  standaloneDir: string
): Promise<void> {
  const req = createRequire(join(projectDir, "package.json"));
  const { nodeFileTrace } = req("next/dist/compiled/@vercel/nft") as {
    nodeFileTrace: (
      entries: string[],
      opts: { base: string; ignore?: string[] }
    ) => Promise<{ fileList: Set<string> }>;
  };
  const entries = [
    req.resolve("next/dist/server/lib/router-server.js"),
    req.resolve(
      "next/dist/server/lib/incremental-cache/file-system-cache.js"
    ),
  ];
  const { fileList } = await nodeFileTrace(entries, {
    base: "/",
    ignore: [
      "**/*.d.ts",
      "**/*.map",
      "**/next/dist/compiled/next-server/**/*.dev.js",
      "**/next/dist/compiled/webpack/*",
      "**/node_modules/webpack5/**/*",
      "**/next/dist/server/lib/route-resolver*",
      "**/next/dist/compiled/semver/semver/**/*.js",
      "**/next/dist/compiled/jest-worker/**/*",
      "**/node_modules/react/**/*.development.js",
      "**/node_modules/react-dom/**/*.development.js",
    ],
  });

  let copied = 0;
  for (const f of fileList) {
    const src = "/" + f;
    // Re-anchor at the first node_modules segment so hoisted-store and
    // monorepo layouts all land under the tree's own node_modules root.
    const idx = src.indexOf("/node_modules/");
    if (idx === -1) continue;
    const dest = join(standaloneDir, src.slice(idx + 1));
    try {
      if (statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied++;
  }
  if (copied > 0) {
    console.log(
      `next-bun-compile: added ${copied} server-runtime files to the traced tree`
    );
  }
}

/**
 * The full compile pipeline: adapter-assembled input tree → embedded-asset
 * entrypoint → single-file executable at <projectDir>/server. Invoked by
 * the build adapter's onBuildComplete.
 */
export async function runBuild(options: RunBuildOptions): Promise<string> {
  const { projectDir, standaloneDir, serverDir, extraArgs = [] } = options;
  const distDir = join(projectDir, ".next");

  await ensureServerRuntime(projectDir, standaloneDir);

  generateEntryPoint({ standaloneDir, serverDir, distDir, projectDir });
  const outfile = join(projectDir, "server");
  compile({ serverDir, outfile, extraArgs });
  return outfile;
}
