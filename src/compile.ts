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

  const args = [
    "build",
    entryPoint,
    "--production",
    "--compile",
    "--minify",
    "--bytecode",
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
  execFileSync("bun", args, { stdio: "inherit" });
  console.log(`next-bun-compile: Done → ${outfile}`);
}
