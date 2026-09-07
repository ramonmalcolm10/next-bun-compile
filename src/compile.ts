import { execFileSync } from "node:child_process";
import { join } from "node:path";

interface CompileOptions {
  serverDir: string;
  outfile: string;
  extraArgs?: string[];
}

/**
 * The argv handed to `bun build`. Split out from compile() so the flag
 * contract is testable without spawning a compiler.
 */
export function buildCompileArgs(
  entryPoint: string,
  outfile: string,
  extraArgs: string[] = []
): string[] {

  // No --bytecode by default: it only covers the statically bundled entry
  // graph, while nearly all request-path code (Next itself, SSR chunks,
  // pages, externalized packages) is extracted raw JS that computed requires
  // pull in at runtime, where the bundler never saw it.
  //
  // Measured on examples/vps-deploy, bun 1.4.0 / macOS arm64, n=25
  // interleaved, warm boots, median: time-to-listening 34.8ms -> 28.9ms
  // (-17%), but time-to-first-dynamic-response 177.3ms -> 175.7ms (-0.9%).
  // The ~6ms bytecode saves on the entry graph is swamped by the ~145ms of
  // requiring Next off the extracted tree, which bytecode cannot touch.
  // Binary size +1.5MB (+2.0%).
  //
  // Worth enabling only for an app served entirely from tier-1/tier-2
  // routes, which never initialises Next and so only pays the first number:
  // NBC_BUILD_ARGS="--bytecode" next build. (An earlier revision of this
  // comment claimed +30% size; that predated gzip-embedding, which grew the
  // denominator to ~77MB.)
  const autoloadOptOut = extraArgs.includes(
    "--no-compile-autoload-package-json"
  );
  return [
    "build",
    entryPoint,
    "--production",
    "--compile",
    // Since bun 1.3.4 a compiled executable ignores node_modules on disk
    // unless asked (oven-sh/bun#27058). The extracted tree is a real
    // node_modules layout that externalized packages resolve their own
    // dependencies through, ESM imports included, which no runtime hook
    // can intercept.
    //
    // Skipped when the caller opted out through NBC_BUILD_ARGS: bun rejects
    // the pair outright ("Cannot use both --compile-autoload-package-json
    // and --no-..."), so appending ours anyway would turn an opt-out into a
    // failed build rather than an override.
    ...(autoloadOptOut ? [] : ["--compile-autoload-package-json"]),
    "--minify",
    "--sourcemap",
    // Dev-only lazy requires inside Next's graph (webpack machinery is
    // never loaded with output builds in production). Externalizing keeps
    // the bundler from failing on modules that never execute.
    "--external",
    "webpack",
    "--external",
    "webpack/*",
    "--external",
    "next/dist/build/webpack/*",
    "--external",
    "sass",
    "--external",
    "critters",
    "--define",
    "process.env.TURBOPACK=1",
    "--define",
    "process.env.__NEXT_EXPERIMENTAL_REACT=",
    "--define",
    'process.env.NEXT_RUNTIME="nodejs"',
    "--outfile",
    outfile,
    // Cross-compile target for flows with no CLI to pass --target
    // (the build adapter): NBC_TARGET=bun-linux-x64 next build
    ...(process.env.NBC_TARGET ? [`--target=${process.env.NBC_TARGET}`] : []),
    ...extraArgs,
  ];
}

export function compile(options: CompileOptions): void {
  const { serverDir, outfile, extraArgs = [] } = options;
  const entryPoint = join(serverDir, "server-entry.js");
  const args = buildCompileArgs(entryPoint, outfile, extraArgs);

  console.log(`next-bun-compile: Compiling to ${outfile}...`);
  try {
    execFileSync("bun", args, { stdio: "inherit" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "next-bun-compile: `bun` was not found on PATH. Install it from https://bun.sh and re-run."
      );
      process.exit(1);
    }
    throw err;
  }
  console.log(`next-bun-compile: Done → ${outfile}`);
}
