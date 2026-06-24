import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

/**
 * Bun build plugin that returns synthetic empty modules for imports that
 * would otherwise fail to resolve — the build-time-only code paths that
 * Next.js ships in next/dist but never actually executes at runtime.
 *
 * Why this exists: our `trace.ts` includes more files than Next's standalone
 * trace does because @vercel/nft follows static `require()` calls without
 * webpack's bundle-reachability analysis. Some of those files reference
 * loaders (sass, postcss), webpack internals, or other build-only deps
 * that aren't installed in the user's project. At runtime those code paths
 * are unreachable (gated by `if (dev)`, `if (config.experimental.x)`, etc.),
 * but bun's bundler can't prove that — it errors on the unresolved import.
 *
 * The plugin works in two layers:
 *   1. Explicit package list — known build-only specifiers always get stubbed.
 *   2. Relative-path fallback — `require("../something")` whose target doesn't
 *      exist on disk gets stubbed. Catches our virtual-standalone exclusions
 *      (e.g. `require("../next")` from start-server.js where next.js was
 *      excluded as build-only).
 *
 * Each stub is `module.exports = {}` — a valid object that satisfies the
 * import shape but can't be invoked. If runtime code does try to call into
 * a stubbed module, it'll throw an "x is not a function"-style error. That's
 * acceptable because (a) it shouldn't reach that code anyway, and (b) the
 * error names the function, making it easy to debug.
 */

/**
 * Specifiers that aren't packages the user installed and that bun's bundler
 * therefore can't resolve. These refer to webpack/build-loader machinery
 * that real files in next/dist/build/ statically require but never invoke
 * at runtime. Stubbing them lets the bundle succeed; the runtime never
 * reaches into them so the stub never returns.
 *
 * Kept narrow on purpose. Adding deep `next/dist/...` patterns here would
 * shadow real runtime files (we hit this with `next/dist/build/output/log.js`
 * — stubbing the deep import broke Next's startup logger).
 */
const PACKAGE_STUB_PATTERNS: RegExp[] = [
	// Bundler internals never installed in app deps
	/^webpack(\/.*)?$/,
	/^webpack5(\/.*)?$/,
	/^sass$/,
	/^less$/,
	/^stylus$/,
	/^critters$/,
	/^babel-loader(\/.*)?$/,
	/^sass-loader(\/.*)?$/,
	/^postcss-loader(\/.*)?$/,
	/^css-loader(\/.*)?$/,
	/^style-loader(\/.*)?$/,
	/^mini-css-extract-plugin(\/.*)?$/,
	/^file-loader(\/.*)?$/,
	/^raw-loader(\/.*)?$/,
	/^html-loader(\/.*)?$/,
	/^@swc\/core(\/.*)?$/,
	/^jest-worker(\/.*)?$/,
	/^esbuild(\/.*)?$/,
	// Deep imports into next/dist/build/ that are PURE build pipeline —
	// distinct from runtime-needed files like next/dist/build/output/log.js
	// which we DO want to bundle. Subdir-level granularity is correct here.
	/^next\/dist\/build\/webpack(\/.*)?$/,
	/^next\/dist\/build\/babel(\/.*)?$/,
	/^next\/dist\/build\/analysis(\/.*)?$/,
	/^next\/dist\/build\/analyze(\/.*)?$/,
	/^next\/dist\/build\/collect-build-traces(\/.*)?$/,
	/^next\/dist\/build\/handle-externals(\/.*)?$/,
	/^next\/dist\/build\/turbopack-build(\/.*)?$/,
];

function isStubbablePackage(specifier: string): boolean {
	for (const pattern of PACKAGE_STUB_PATTERNS) {
		if (pattern.test(specifier)) return true;
	}
	return false;
}

/** Resolve a relative specifier against an importer and return the first
    candidate path that exists, or null if none do. */
function resolveRelativeIfExists(
	specifier: string,
	importer: string,
): string | null {
	const base = resolvePath(dirname(importer), specifier);
	const candidates = [
		base,
		`${base}.js`,
		`${base}.cjs`,
		`${base}.mjs`,
		`${base}/index.js`,
		`${base}/index.cjs`,
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

export const stubUnresolvablePlugin = {
	name: "next-bun-compile-stub-unresolvable",
	setup(build: {
		onResolve: (
			opts: { filter: RegExp; namespace?: string },
			cb: (args: { path: string; importer: string }) =>
				| { path: string; namespace?: string; external?: boolean }
				| null
				| undefined,
		) => void;
		onLoad: (
			opts: { filter: RegExp; namespace?: string },
			cb: () => { contents: string; loader: string },
		) => void;
	}) {
		// Stub known build-only packages
		build.onResolve({ filter: /.*/ }, (args) => {
			if (isStubbablePackage(args.path)) {
				return { path: args.path, namespace: "nbc-stub" };
			}
			// Relative requires whose target doesn't exist — stub them.
			// Our virtual standalone is curated; any relative require that misses
			// is pointing at a file we excluded as build-only.
			if (args.path.startsWith("./") || args.path.startsWith("../")) {
				if (!args.importer) return null;
				if (!resolveRelativeIfExists(args.path, args.importer)) {
					return { path: args.path, namespace: "nbc-stub" };
				}
			}
			return null; // defer to default resolver
		});

		build.onLoad({ filter: /.*/, namespace: "nbc-stub" }, () => ({
			contents: "module.exports = {};",
			loader: "js",
		}));
	},
};
