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

  // No --bytecode: it only covers the statically bundled entry graph, while
  // nearly all request-path code (SSR chunks, pages, externalized packages)
  // is extracted raw JS loaded at runtime. Measured on a demo app it added
  // +30% binary size for zero warm-boot gain. Users can re-add it via CLI
  // extra args, which append after these defaults.
  const args = [
    "build",
    entryPoint,
    "--production",
    "--compile",
    "--minify",
    "--sourcemap",
    "--define",
    "process.env.TURBOPACK=1",
    "--define",
    "process.env.__NEXT_EXPERIMENTAL_REACT=",
    "--define",
    'process.env.NEXT_RUNTIME="nodejs"',
    "--outfile",
    outfile,
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
