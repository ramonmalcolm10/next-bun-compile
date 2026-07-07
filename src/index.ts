export { generateEntryPoint } from "./generate.js";
export { compile } from "./compile.js";
export { runBuild } from "./build.js";
// Default export so `adapterPath: "next-bun-compile"` works — Next loads
// the module at adapterPath and silently skips the adapter when the
// default export has no onBuildComplete, so the obvious specifier must be
// valid. "next-bun-compile/adapter" remains as an alias.
export { default as adapter, default } from "./adapter.js";
