#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateEntryPoint } from "./generate.js";
import { compile } from "./compile.js";
import { traceForCompilation } from "./trace.js";
import { buildVirtualLayout } from "./layout.js";
import { materializeVirtualStandalone } from "./materialize.js";

const extraArgs = process.argv.slice(2);

const projectDir = resolve(".");
const distDir = join(projectDir, ".next");

if (!existsSync(join(distDir, "required-server-files.json"))) {
	console.error(
		'next-bun-compile: No Next.js build found. Run "next build" first.',
	);
	process.exit(1);
}

const ctxPath = join(distDir, "bun-compile-ctx.json");
if (existsSync(ctxPath)) {
	console.log("next-bun-compile: Using build context from adapter");
}

// Trace runtime deps ourselves — bypasses Next's `output: "standalone"` step,
// which is broken under Turbopack in 16.3-canary and not strictly needed.
console.log("next-bun-compile: Tracing runtime dependencies...");
const trace = await traceForCompilation({ projectDir, distDir });
const layout = buildVirtualLayout(trace);
console.log(`next-bun-compile: Traced ${layout.entries.length} files`);

const virtualStandalone = join(distDir, "__nbc-virtual-standalone");
materializeVirtualStandalone({
	layout,
	outDir: virtualStandalone,
	projectDir,
	distDir: ".next",
});

const serverDir = generateEntryPoint({
	standaloneDir: virtualStandalone,
	distDir,
	projectDir,
});
await compile({ serverDir, outfile: join(projectDir, "server"), extraArgs });
