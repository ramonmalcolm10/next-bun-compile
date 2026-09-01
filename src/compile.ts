import { execFileSync } from "node:child_process";
import { join } from "node:path";

interface CompileOptions {
  serverDir: string;
  outfile: string;
  extraArgs?: string[];
}

export function compile(options: CompileOptions): void {
  const { serverDir, outfile, extraArgs = [] } = options;
  const entryPoint = join(serverDir, "server-entry.js");

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
  const args = [
    "build",
    entryPoint,
    "--production",
    "--compile",
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
