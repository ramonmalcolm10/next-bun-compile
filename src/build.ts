import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { generateEntryPoint } from "./generate.js";
import { compile } from "./compile.js";

export interface RunBuildOptions {
  projectDir: string;
  /** The adapter-assembled standalone-layout input tree. */
  standaloneDir: string;
  /** App dir inside that tree (nested for monorepo layouts). */
  serverDir: string;
  /**
   * Extra args appended to the `bun build` invocation, after the defaults.
   * Also settable via NBC_BUILD_ARGS — see resolveExtraArgs.
   */
  extraArgs?: string[];
  /**
   * Output directory for the binary, relative to projectDir (or absolute).
   * Default: the project root. A future major moves this to "dist".
   */
  out?: string;
  /** Binary filename. Default: "server". */
  binaryName?: string;
}

/**
 * Where the compiled binary is written. Overridable so callers can place it
 * off-root — e.g. dist/app to match homeport's other framework adapters, which
 * also avoids ever naming a file `server` (Nitro treats server/ as a
 * convention dir). Precedence: explicit option → env (NBC_OUT / NBC_BINARY,
 * for the adapter and CLI flows that have no argv) → the historical default
 * <projectDir>/server. The default is preserved for backward compatibility;
 * a future major moves it to dist/app.
 */
function resolveOutfile(projectDir: string, options: RunBuildOptions): string {
  const outDir = options.out ?? process.env.NBC_OUT ?? projectDir;
  const binaryName = options.binaryName ?? process.env.NBC_BINARY ?? "server";
  const base = isAbsolute(outDir) ? outDir : join(projectDir, outDir);
  return join(base, binaryName);
}

/**
 * Extra `bun build` flags, from the option or from NBC_BUILD_ARGS. The build
 * adapter runs inside `next build` with no argv of its own, so env is the only
 * channel an adapter-driven build has — the same contract NBC_TARGET, NBC_OUT
 * and NBC_BINARY already use. Env args come last so they can override an
 * explicit option (bun build takes the last occurrence of a flag).
 *
 * Whitespace-separated, no quoting: these are flags, not arguments with
 * spaces. The flag most likely to appear here is --bytecode — see the
 * measurements in compile.ts for when that is worth its cost.
 */
export function resolveExtraArgs(
  options: Pick<RunBuildOptions, "extraArgs">
): string[] {
  const fromEnv = process.env.NBC_BUILD_ARGS?.trim();
  return [
    ...(options.extraArgs ?? []),
    ...(fromEnv ? fromEnv.split(/\s+/) : []),
  ];
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
  const { projectDir, standaloneDir, serverDir } = options;
  const distDir = join(projectDir, ".next");

  await ensureServerRuntime(projectDir, standaloneDir);

  generateEntryPoint({ standaloneDir, serverDir, distDir, projectDir });
  const outfile = resolveOutfile(projectDir, options);
  mkdirSync(dirname(outfile), { recursive: true });
  compile({ serverDir, outfile, extraArgs: resolveExtraArgs(options) });
  return outfile;
}
