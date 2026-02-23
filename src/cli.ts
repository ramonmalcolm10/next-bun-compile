#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateEntryPoint } from "./generate.js";
import { compile } from "./compile.js";

const extraArgs = process.argv.slice(2);

const projectDir = resolve(".");
const distDir = join(projectDir, ".next");
const standaloneDir = join(distDir, "standalone");

if (!existsSync(standaloneDir)) {
  console.error(
    'next-bun-compile: No standalone output found. Run "next build" first with output: "standalone" in next.config.ts.'
  );
  process.exit(1);
}

// Check for adapter context (optional — works without the adapter too)
const ctxPath = join(distDir, "bun-compile-ctx.json");
if (existsSync(ctxPath)) {
  console.log("next-bun-compile: Using build context from adapter");
}

generateEntryPoint({ standaloneDir, distDir, projectDir });
compile({ standaloneDir, outfile: join(projectDir, "server"), extraArgs });
