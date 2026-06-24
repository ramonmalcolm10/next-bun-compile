import {
	mkdirSync,
	linkSync,
	copyFileSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { VirtualLayout } from "./layout.js";

export interface MaterializeOptions {
	layout: VirtualLayout;
	/** Where to create the virtual standalone dir. Cleaned and recreated. */
	outDir: string;
	/** Project root, used to read required-server-files.json for nextConfig. */
	projectDir: string;
	/** distDir, e.g. ".next" — relative to projectDir or absolute. */
	distDir: string;
}

/**
 * Build a `standalone`-shaped directory using hard links to the real files.
 * Equivalent to what Next would produce under `output: "standalone"`, but:
 *
 *   - Files are hard-linked, not copied — same inode, zero disk overhead,
 *     and (unlike symlinks) bun's bundler doesn't follow them back to the
 *     original location. Cross-device falls back to copy.
 *   - server.js is synthesized from `required-server-files.json` (the only
 *     thing generate.ts reads from server.js is the `nextConfig` literal).
 *   - package.json is a stub — the bundler doesn't read it but some Next
 *     internals probe for one at the root.
 *
 * Why hard links instead of symlinks: bun resolves symlinks before module
 * resolution, so a symlink farm doesn't isolate the bundle from the real
 * node_modules. Hard links present as ordinary files at the curated path,
 * giving us the isolation our trace was supposed to provide.
 *
 * The point is to give the existing generate.ts code the same layout it's
 * always seen, so we don't have to rewrite its standalone-walking logic.
 * Returns the absolute path of the virtual standalone root.
 */
export function materializeVirtualStandalone(opts: MaterializeOptions): string {
	const outDir = resolve(opts.outDir);
	const projectDir = resolve(opts.projectDir);
	const distDir = resolve(projectDir, opts.distDir);

	// Clean rebuild — stale entries shouldn't carry across builds.
	if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });

	for (const entry of opts.layout.entries) {
		const target = join(outDir, entry.relativePath);
		mkdirSync(dirname(target), { recursive: true });
		try {
			linkSync(entry.absolutePath, target);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") continue; // dedup paranoia
			if (code === "EXDEV" || code === "EPERM") {
				// Cross-device (rare) or restricted (e.g. global node_modules) —
				// fall back to copy. Slower but correct.
				copyFileSync(entry.absolutePath, target);
				continue;
			}
			throw err;
		}
	}

	// Synthesize server.js. generate.ts uses a regex to extract `nextConfig`
	// from this file — keep the format compatible (literal on one line).
	const rsfPath = join(distDir, "required-server-files.json");
	if (!existsSync(rsfPath)) {
		throw new Error(
			`next-bun-compile: ${rsfPath} not found — was 'next build' run successfully?`,
		);
	}
	const rsf = JSON.parse(readFileSync(rsfPath, "utf-8")) as {
		config: unknown;
	};
	const nextConfigStr = JSON.stringify(rsf.config);
	const serverJs = `// next-bun-compile virtual standalone — not executed at runtime.
// generate.ts parses the nextConfig literal below; everything else is for shape parity with Next's real server.js.
const path = require('path');
const dir = path.join(__dirname);
process.env.NODE_ENV = 'production';
const nextConfig = ${nextConfigStr}
`;
	writeFileSync(join(outDir, "server.js"), serverJs);

	// Stub package.json — keeps anything that probes the root happy.
	writeFileSync(
		join(outDir, "package.json"),
		JSON.stringify(
			{
				name: "next-bun-compile-virtual-standalone",
				type: "commonjs",
				private: true,
			},
			null,
			2,
		),
	);

	return outDir;
}
