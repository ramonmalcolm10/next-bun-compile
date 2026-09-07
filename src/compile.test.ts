import { describe, test, expect } from "bun:test";
import { buildCompileArgs } from "./compile.js";

const ENTRY = "/app/.next/standalone/server-entry.js";
const OUT = "/app/server";

describe("buildCompileArgs", () => {
  test("passes --compile-autoload-package-json by default", () => {
    // Not a tuning knob. next-bun-compile embeds Next, the SSR chunks and
    // every externalized package as bytes and extracts them to a real
    // node_modules tree at boot, so the binary must resolve from disk.
    // Without this flag bun ignores that tree for ESM imports, and an
    // ESM-only external fails on its first bare import at runtime:
    //   Cannot find package 'linebreak' imported from
    //   .next/node_modules/satori/dist/index.js
    // The CJS Module._resolveFilename hook cannot cover it — it never sees
    // ESM. Reproduced against satori 0.33.4 on bun 1.4.2.
    expect(buildCompileArgs(ENTRY, OUT)).toContain(
      "--compile-autoload-package-json"
    );
  });

  test("omits it when the caller opts out, instead of handing bun both", () => {
    // bun errors on the pair: "Cannot use both
    // --compile-autoload-package-json and --no-compile-autoload-package-json".
    // Appending ours unconditionally would turn NBC_BUILD_ARGS="--no-..."
    // into a failed build rather than an override, leaving no way off.
    const args = buildCompileArgs(ENTRY, OUT, [
      "--no-compile-autoload-package-json",
    ]);
    expect(args).not.toContain("--compile-autoload-package-json");
    expect(args).toContain("--no-compile-autoload-package-json");
  });

  test("extra args come last so they can override earlier flags", () => {
    const args = buildCompileArgs(ENTRY, OUT, ["--bytecode"]);
    expect(args[args.length - 1]).toBe("--bytecode");
  });

  test("outfile and entry point are wired through", () => {
    const args = buildCompileArgs(ENTRY, OUT);
    expect(args[0]).toBe("build");
    expect(args).toContain(ENTRY);
    expect(args[args.indexOf("--outfile") + 1]).toBe(OUT);
  });
});
