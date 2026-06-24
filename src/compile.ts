import { join } from "node:path";
import { stubUnresolvablePlugin } from "./stub-plugin.js";

interface CompileOptions {
	serverDir: string;
	outfile: string;
	/** Reserved for future passthrough use. Currently ignored — Bun.build is
	    programmatic, not CLI-driven, so flags need explicit mapping. */
	extraArgs?: string[];
}

export async function compile(options: CompileOptions): Promise<void> {
	const { serverDir, outfile } = options;
	const entryPoint = join(serverDir, "server-entry.js");

	console.log(`next-bun-compile: Compiling to ${outfile}...`);

	const result = await Bun.build({
		entrypoints: [entryPoint],
		compile: {
			outfile,
		},
		minify: true,
		sourcemap: "linked",
		bytecode: true,
		define: {
			"process.env.NODE_ENV": JSON.stringify("production"),
			"process.env.TURBOPACK": "1",
			"process.env.__NEXT_EXPERIMENTAL_REACT": JSON.stringify(""),
			"process.env.NEXT_RUNTIME": JSON.stringify("nodejs"),
		},
		plugins: [stubUnresolvablePlugin as Bun.BunPlugin],
	});

	if (!result.success) {
		for (const log of result.logs) {
			console.error(String(log));
		}
		throw new Error("next-bun-compile: bun build failed");
	}

	console.log(`next-bun-compile: Done → ${outfile}`);
}
