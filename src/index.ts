export { generateEntryPoint } from "./generate.js";
export { compile } from "./compile.js";
export { runBuild } from "./build.js";
// Default export so `adapterPath: "next-bun-compile"` works — Next loads
// the module at adapterPath and silently skips the adapter when the
// default export has no onBuildComplete, so the bare specifier must be
// valid.
export { default as adapter, default } from "./adapter.js";
