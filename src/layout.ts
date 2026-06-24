import type { TraceResult } from "./trace.js";

export interface LayoutEntry {
	/** Where the file currently lives on disk. */
	absolutePath: string;
	/**
	 * Where the file would have lived under `.next/standalone/` — same
	 * relative path. Used by generate.ts when constructing the runtime
	 * extraction map.
	 */
	relativePath: string;
	/**
	 * The asset URL used for embedding (`with { type: "file" }`) and the
	 * runtime extraction map. Stable, slash-delimited, prefixed.
	 */
	urlPath: string;
}

export interface VirtualLayout {
	entries: LayoutEntry[];
	/**
	 * Equivalent of `.next/standalone/` — the directory that all relativePaths
	 * are anchored to. Kept around for code paths that need to reconstruct
	 * "standalone-style" paths (e.g. monorepo nested layouts).
	 */
	rootHint: string;
}

/**
 * Convert trace results into the shape `generate.ts` consumes. The mapping
 * is structural — one trace file = one layout entry — with the urlPath
 * derived from the relativePath via the `__runtime/` prefix that the rest
 * of the codebase already uses for embedded runtime assets.
 */
export function buildVirtualLayout(trace: TraceResult): VirtualLayout {
	const entries: LayoutEntry[] = trace.files.map((f) => ({
		absolutePath: f.absolutePath,
		relativePath: f.relativePath,
		urlPath: `__runtime/${f.relativePath.replace(/\\/g, "/")}`,
	}));
	return { entries, rootHint: trace.root };
}
