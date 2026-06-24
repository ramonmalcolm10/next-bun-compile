import { nodeFileTrace } from "@vercel/nft";
import { readFileSync, existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { createRequire } from "node:module";

export interface TraceOptions {
	/** Project root (where next.config lives). */
	projectDir: string;
	/** Build output directory, usually ".next" — may be absolute or relative to projectDir. */
	distDir: string;
	/**
	 * Tracing root — files outside this directory will be omitted from results.
	 * For monorepos, this should point at the workspace root so workspace-shared
	 * packages get included. Defaults to projectDir.
	 */
	outputFileTracingRoot?: string;
}

export interface TracedFile {
	absolutePath: string;
	/** Path relative to the tracing root — matches the layout standalone would have produced. */
	relativePath: string;
}

export interface TraceResult {
	files: TracedFile[];
	/** The tracing root used; equal to outputFileTracingRoot or projectDir. */
	root: string;
}

/**
 * statSync that swallows EPERM/EACCES/ENOENT. Bun's hoisted store uses symlinks
 * that occasionally can't be stat'd on Windows; treat those as "skip" rather
 * than crashing.
 */
function tryStat(p: string): Stats | null {
	try {
		return statSync(p);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "ENOENT") return null;
		throw err;
	}
}

function walkFiles(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = tryStat(full);
		if (!stat) continue;
		if (stat.isDirectory()) walkFiles(full, out);
		else out.push(full);
	}
	return out;
}

/**
 * Files we never want in the runtime bundle. Mirrors Next.js's own
 * `sharedIgnores` from `collect-build-traces.ts` plus a few additions for
 * obvious dev-only / build-time-only paths.
 *
 * Matched against forward-slash paths; suffix checks for hot patterns,
 * substring checks for path-anchored patterns. Kept as explicit predicates
 * rather than a glob library to avoid pulling in a dep.
 */
/**
 * Files to skip even if @vercel/nft picked them up. Each pattern was
 * validated by building+running the demo after adding it — anything that
 * broke a runtime call site (TypeError on a stubbed module) got removed.
 *
 * Categories that survived the validation pass:
 *
 *   - Never executed: type defs, source maps
 *   - React dev builds — Next never loads .development.js in production
 *   - ESM mirror — runtime uses CJS copies
 *   - Dev-mode runtime bundle variants — `.dev.js` next-server variants
 *   - Browser-environment shims — used by webpack's NodeStuffPlugin for
 *     client bundles only; never required by server-runtime code
 *   - Tooling data — caniuse-lite is browserslist's compat DB. The full
 *     ~50MB only ships because nft follows a static require, but Next's
 *     server runtime doesn't query it.
 *
 * What got REMOVED after breaking runtime:
 *   - next/dist/compiled/babel/* — `babel-runtime/helpers/interopRequireDefault`
 *     is reached at server startup (loader chunk callback)
 *   - next/dist/next-devtools/* — error-overlay code is loaded even in prod
 *   - next/dist/build/webpack/* — some plugin code is referenced via dynamic
 *     require chains we can't easily filter
 *
 * If you want to filter more, the right move is: build, run, find the
 * first stubbed-call TypeError, identify the missing module, and pull it
 * back into the trace. Repeat until stable.
 */
const IGNORE_PREDICATES: Array<(p: string) => boolean> = [
	// Never executed
	(p) => p.endsWith(".d.ts"),
	(p) => p.endsWith(".map"),

	// React dev builds
	(p) => /node_modules\/react(-dom|-dom-server-turbopack)?\/.*\.development\.js$/.test(p),

	// ESM mirror of next/dist/
	(p) => p.includes("/next/dist/esm/"),

	// Dev-mode runtime bundle variants
	(p) => /\/next\/dist\/compiled\/next-server\/.*\.dev\.js$/.test(p),

	// Browser-environment shims (client-bundle-only, never server-side)
	(p) => p.includes("/next/dist/compiled/timers-browserify/"),
	(p) => p.includes("/next/dist/compiled/os-browserify/"),
	(p) => p.includes("/next/dist/compiled/constants-browserify/"),
	(p) => p.includes("/next/dist/compiled/vm-browserify/"),

	// Tooling data — browserslist's compat DB, ~50MB
	(p) => p.includes("/node_modules/caniuse-lite/"),
	(p) => p.includes("/node_modules/baseline-browser-mapping/"),
];

function isIgnored(absPath: string): boolean {
	const p = absPath.replace(/\\/g, "/");
	for (const pred of IGNORE_PREDICATES) if (pred(p)) return true;
	return false;
}

/**
 * Reconstruct what `output: "standalone"` would have produced — without
 * requiring standalone mode at all. Merges three sources:
 *
 *   1. `.next/server/**` (Next's compiled routes + manifests) — wholesale.
 *   2. Per-route `.nft.json` files — these list each route's traced deps
 *      and exist under both Turbopack and webpack. They cover ~90% of
 *      `next/dist/*` and most React runtime files.
 *   3. `@vercel/nft` trace of the Next runtime entrypoints (next-server.js,
 *      start-server.js, require-hook.js) — fills in what's missing because
 *      Turbopack doesn't write `next-server.js.nft.json` (Next bug as of
 *      16.3-canary). Webpack does, but tracing again is harmless.
 *
 * Plus `required-server-files.json`'s "files" array for top-level configs.
 *
 * Result: a deduped list of absolute file paths, each mapped to its
 * layout-relative path (relative to outputFileTracingRoot). The relative
 * path is identical to where standalone would have placed the file under
 * `.next/standalone/`.
 */
export async function traceForCompilation(
	opts: TraceOptions,
): Promise<TraceResult> {
	const projectDir = resolve(opts.projectDir);
	const distDir = resolve(projectDir, opts.distDir);
	const root = resolve(opts.outputFileTracingRoot ?? projectDir);

	const collected = new Set<string>();

	// 1. Wholesale: every file under .next/server/ (compiled routes + manifests
	//    + the .nft.json files themselves — they're harmless extras).
	for (const f of walkFiles(join(distDir, "server"))) collected.add(f);

	// 2. required-server-files.json — top-level configs Next needs at runtime.
	const rsfPath = join(distDir, "required-server-files.json");
	if (existsSync(rsfPath)) {
		try {
			const rsf = JSON.parse(readFileSync(rsfPath, "utf-8")) as {
				files?: string[];
			};
			for (const rel of rsf.files ?? []) {
				collected.add(resolve(projectDir, rel));
			}
		} catch {
			// Malformed JSON — skip and rely on the other sources.
		}
	}

	// 3. Per-route .nft.json files. Paths inside are relative to the .nft.json's
	//    own directory (consistent with Vercel's nft format).
	for (const nftPath of walkFiles(join(distDir, "server"))) {
		if (!nftPath.endsWith(".nft.json")) continue;
		let nft: { files?: string[] };
		try {
			nft = JSON.parse(readFileSync(nftPath, "utf-8"));
		} catch {
			continue;
		}
		const nftDir = dirname(nftPath);
		for (const rel of nft.files ?? []) {
			collected.add(resolve(nftDir, rel));
		}
	}

	// 4. Trace the Next runtime entrypoints ourselves. Under Turbopack this is
	//    the *only* source for next-server.js + its closure (no .nft.json gets
	//    written for it). Under webpack it's redundant but harmless.
	const projectRequire = createRequire(join(projectDir, "_"));
	const runtimeEntries: string[] = [];
	for (const id of [
		"next/dist/server/next-server",
		"next/dist/server/lib/start-server",
		"next/dist/server/require-hook",
	]) {
		try {
			runtimeEntries.push(projectRequire.resolve(id));
		} catch {
			// Module not present in this Next version — skip.
		}
	}

	if (runtimeEntries.length > 0) {
		const result = await nodeFileTrace(runtimeEntries, {
			base: root,
			processCwd: projectDir,
		});
		for (const f of result.fileList) {
			collected.add(resolve(root, f));
		}
		// nodeFileTrace's fileList excludes the entry files themselves — add them.
		for (const e of runtimeEntries) collected.add(e);
	}

	// 5. Materialize. Drop anything that doesn't exist as a regular file
	//    (broken symlinks, directories that crept in, files trimmed by some
	//    other build step) — silent skip matches standalone's behavior.
	//    Also drop entries in the ignore list (build-time loaders, dev files,
	//    source maps, type defs) — these reach our trace via @vercel/nft
	//    following conditional/dev-only requires that Next's own trace skips.
	const files: TracedFile[] = [];
	for (const abs of collected) {
		if (isIgnored(abs)) continue;
		const stat = tryStat(abs);
		if (!stat || !stat.isFile()) continue;
		files.push({
			absolutePath: abs,
			relativePath: relative(root, abs),
		});
	}
	return { files, root };
}
