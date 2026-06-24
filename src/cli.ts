#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateEntryPoint } from "./generate.js";
import { compile } from "./compile.js";

const extraArgs = process.argv.slice(2);

const projectDir = resolve(".");
const distDir = join(projectDir, ".next");
const standaloneDir = join(distDir, "standalone");

if (!existsSync(standaloneDir)) {
  console.error(
    'next-bun-compile: No standalone output found. Add `output: "standalone"` to next.config.ts and re-run `next build`.'
  );
  process.exit(1);
}

const serverDir = generateEntryPoint({ standaloneDir, distDir, projectDir });
compile({ serverDir, outfile: join(projectDir, "server"), extraArgs });
