import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { generateEntryPoint } from "./generate.js";

const tmpBase = join(import.meta.dir, "..", ".test-fixtures");

/** Minimal server.js content that passes the nextConfig regex */
const MOCK_SERVER_JS = `const nextConfig = {"env":{}}\nprocess.exit(0);\n`;

/** Minimal required-server-files.json — generate.ts reads `config.assetPrefix` */
const MOCK_RSF = JSON.stringify({ config: { assetPrefix: "" } });

/** Minimal require-hook.js (won't be patched — target string absent) */
const MOCK_REQUIRE_HOOK = `module.exports = {};`;

/** Minimal next/package.json */
const MOCK_NEXT_PKG = JSON.stringify({ name: "next", version: "16.0.0" });

function scaffold(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

function cleanup() {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterEach(cleanup);

describe("generateEntryPoint", () => {
  test("standard (non-monorepo) layout: returns standaloneDir", () => {
    const root = join(tmpBase, "standard");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      // distDir files
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/test.js": "// static",
      // standalone files (server.js at root)
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "test-build-id",
      ".next/standalone/.next/server/chunks/ssr.js": `// no externals`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      // public
      "public/favicon.ico": "icon",
    });

    const serverDir = generateEntryPoint({ standaloneDir, distDir, projectDir });

    // For standard layout, serverDir should equal standaloneDir
    expect(serverDir).toBe(standaloneDir);

    // Generated files should be in standaloneDir
    expect(existsSync(join(standaloneDir, "server-entry.js"))).toBe(true);
    expect(existsSync(join(standaloneDir, "assets.generated.js"))).toBe(true);

    // server-entry.js should contain valid content
    const entry = readFileSync(join(standaloneDir, "server-entry.js"), "utf-8");
    expect(entry).toContain("assetMap");
    expect(entry).toContain('const nextConfig = {"env":{}}');
  });

  test("monorepo layout: returns nested serverDir", () => {
    const root = join(tmpBase, "monorepo");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      // distDir files
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/test.js": "// static",
      // standalone files — server.js nested under apps/web/
      ".next/standalone/apps/web/server.js": MOCK_SERVER_JS,
      ".next/standalone/apps/web/.next/BUILD_ID": "test-build-id",
      ".next/standalone/apps/web/.next/server/chunks/ssr.js": `// no externals`,
      // node_modules at standalone root (monorepo layout)
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      // public
      "public/favicon.ico": "icon",
    });

    const serverDir = generateEntryPoint({ standaloneDir, distDir, projectDir });

    // For monorepo, serverDir should be the nested directory
    const expectedServerDir = join(standaloneDir, "apps/web");
    expect(serverDir).toBe(expectedServerDir);

    // Generated files should be in the nested serverDir, not standaloneDir root
    expect(existsSync(join(expectedServerDir, "server-entry.js"))).toBe(true);
    expect(existsSync(join(expectedServerDir, "assets.generated.js"))).toBe(true);
    expect(existsSync(join(standaloneDir, "server-entry.js"))).toBe(false);

    // server-entry.js should still have valid content
    const entry = readFileSync(join(expectedServerDir, "server-entry.js"), "utf-8");
    expect(entry).toContain("assetMap");
    expect(entry).toContain('const nextConfig = {"env":{}}');
  });

  test("monorepo layout: runtime files come from nested .next/", () => {
    const root = join(tmpBase, "monorepo-runtime");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// app static",
      ".next/standalone/apps/web/server.js": MOCK_SERVER_JS,
      ".next/standalone/apps/web/.next/BUILD_ID": "mono-build-id",
      ".next/standalone/apps/web/.next/server/chunks/ssr.js": `// chunk`,
      ".next/standalone/apps/web/.next/server/pages/index.js": `// page`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      "public/robots.txt": "User-agent: *",
    });

    const serverDir = generateEntryPoint({ standaloneDir, distDir, projectDir });
    expect(serverDir).toBe(join(standaloneDir, "apps/web"));

    // assets.generated.js should reference files relative to serverDir
    const assets = readFileSync(join(serverDir, "assets.generated.js"), "utf-8");
    // Runtime files should use .next/ paths (relative to serverDir)
    expect(assets).toContain(".next/BUILD_ID");
    // Should NOT contain the monorepo nesting path in imports
    expect(assets).not.toContain("apps/web/.next/BUILD_ID");
  });

  test("monorepo layout: external modules read from standalone root node_modules", () => {
    const root = join(tmpBase, "monorepo-externals");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      // Nested server with a chunk that requires an external module
      ".next/standalone/apps/web/server.js": MOCK_SERVER_JS,
      ".next/standalone/apps/web/.next/BUILD_ID": "ext-build",
      ".next/standalone/apps/web/.next/server/chunks/ssr.js":
        `require("next/dist/compiled/react/index.js");`,
      // External module in root node_modules (monorepo layout)
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      ".next/standalone/node_modules/next/dist/compiled/react/index.js":
        `module.exports = {};`,
      "public/favicon.ico": "icon",
    });

    const serverDir = generateEntryPoint({ standaloneDir, distDir, projectDir });
    expect(serverDir).toBe(join(standaloneDir, "apps/web"));

    // External modules should be copied into serverDir/.next/__external/
    expect(
      existsSync(join(serverDir, ".next/__external/next/dist/compiled/react/index.js"))
    ).toBe(true);

    // NOT into standaloneDir/.next/__external/
    expect(
      existsSync(join(standaloneDir, ".next/__external"))
    ).toBe(false);
  });

  test("throws when server.js not found anywhere", () => {
    const root = join(tmpBase, "missing");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      // standalone dir exists but has no server.js
      ".next/standalone/.next/BUILD_ID": "no-server",
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
    });

    expect(() =>
      generateEntryPoint({ standaloneDir, distDir, projectDir })
    ).toThrow("Could not find server.js");
  });

  test("pnpm monorepo layout: stubs placed in .pnpm/ store", () => {
    const root = join(tmpBase, "pnpm-mono");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    const pnpmNextDir =
      "node_modules/.pnpm/next@16.1.6_react@19.2.3/node_modules/next";

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/apps/admin/server.js": MOCK_SERVER_JS,
      ".next/standalone/apps/admin/.next/BUILD_ID": "pnpm-build",
      ".next/standalone/apps/admin/.next/server/chunks/ssr.js": `// chunk`,
      // pnpm hoisted layout — next lives under .pnpm/
      [`.next/standalone/${pnpmNextDir}/package.json`]: MOCK_NEXT_PKG,
      [`.next/standalone/${pnpmNextDir}/dist/server/require-hook.js`]: MOCK_REQUIRE_HOOK,
      [`.next/standalone/${pnpmNextDir}/dist/server/next.js`]:
        `require('./dev/next-dev-server');`,
      "public/favicon.ico": "icon",
    });

    const serverDir = generateEntryPoint({ standaloneDir, distDir, projectDir });
    expect(serverDir).toBe(join(standaloneDir, "apps/admin"));

    // Stubs should be created in the .pnpm/ hoisted path
    expect(
      existsSync(
        join(standaloneDir, pnpmNextDir, "dist/server/dev/next-dev-server.js")
      )
    ).toBe(true);
    expect(
      existsSync(
        join(
          standaloneDir,
          pnpmNextDir,
          "dist/server/lib/router-utils/setup-dev-bundler.js"
        )
      )
    ).toBe(true);
  });

  test("tolerates unstattable symlinks in node_modules (Windows EPERM, bun#4533)", () => {
    const root = join(tmpBase, "broken-symlink");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "sym-build",
      ".next/standalone/.next/server/chunks/ssr.js": `// chunk`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      // The .bun hoisted store: next@<ver>/node_modules/<dep> entries are
      // symlinks to other store entries. Simulate one whose target is missing
      // (this throws ENOENT on stat — equivalent to Windows' EPERM on locked
      // symlinks). The real `react` package is reachable via its canonical
      // .bun/react@<ver>/node_modules/react/ path below.
      ".next/standalone/node_modules/.bun/next@16.2.0/node_modules/next/package.json":
        MOCK_NEXT_PKG,
      ".next/standalone/node_modules/.bun/react@19.0.0/node_modules/react/package.json":
        JSON.stringify({ name: "react", version: "19.0.0" }),
      ".next/standalone/node_modules/.bun/react@19.0.0/node_modules/react/index.js":
        `module.exports = {};`,
      "public/favicon.ico": "icon",
    });

    // Dangling symlink — points to a path that never exists
    const reactLink = join(
      standaloneDir,
      "node_modules/.bun/next@16.2.0/node_modules/react"
    );
    symlinkSync(
      join(standaloneDir, "node_modules/.bun/__missing__/node_modules/react"),
      reactLink
    );

    expect(() =>
      generateEntryPoint({ standaloneDir, distDir, projectDir })
    ).not.toThrow();

    // The real react (reachable via its canonical .bun path) still embeds
    expect(
      existsSync(join(standaloneDir, ".next/__external/react/index.js"))
    ).toBe(true);
  });

  test("injects turbopack alias→canonical map into runtime hook", () => {
    // The runtime Module._resolveFilename hook redirects mangled aliases
    // (`sharp-457...` → `sharp`) before resolution, so chunks calling
    // `require("sharp-457...")` end up loading the canonical package.
    // The build embeds the alias map for the hook to consult; chunk
    // contents are left untouched.
    const root = join(tmpBase, "turbopack-alias-map");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    const chunkPath =
      ".next/standalone/.next/server/chunks/ssr/[root-of-the-server].js";
    const chunkSource =
      `b.exports=a.x("sharp-457ea9eae1af1a9c",()=>require("sharp-457ea9eae1af1a9c"));\n` +
      `let p=await a.y("prettier-285d8f1d6bb5f650/plugins/html");`;
    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "alias-map-build",
      [chunkPath]: chunkSource,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      ".next/standalone/node_modules/.bun/sharp@0.34.5/node_modules/sharp/package.json":
        JSON.stringify({ name: "sharp", main: "index.js" }),
      ".next/standalone/node_modules/.bun/sharp@0.34.5/node_modules/sharp/index.js":
        "module.exports = {};",
      ".next/standalone/node_modules/.bun/prettier@3.8.4/node_modules/prettier/package.json":
        JSON.stringify({ name: "prettier" }),
      ".next/standalone/node_modules/.bun/prettier@3.8.4/node_modules/prettier/plugins/html.js":
        "module.exports = {};",
      "public/favicon.ico": "icon",
    });

    generateEntryPoint({ standaloneDir, distDir, projectDir });

    // Chunks rewritten to absolute file paths with __NBC_BASE__ placeholder
    // for both CJS require and ESM import — bun's compiled-binary resolver
    // (both CJS and ESM) doesn't reliably walk node_modules from chunk
    // locations on Linux, so absolute file paths skip resolution entirely.
    const chunk = readFileSync(join(root, chunkPath), "utf-8");
    expect(chunk).not.toContain("sharp-457ea9eae1af1a9c");
    expect(chunk).not.toContain("prettier-285d8f1d6bb5f650");
    expect(chunk).toContain('"__NBC_BASE__/.next/node_modules/sharp/index.js"');
    expect(chunk).toContain('"__NBC_BASE__/.next/node_modules/prettier/plugins/html.js"');

    // Canonical packages embedded
    const assets = readFileSync(join(standaloneDir, "assets.generated.js"), "utf-8");
    expect(assets).toContain("sharp/index.js");
    expect(assets).toContain("prettier/plugins/html.js");

    // Server entry retains the alias map + resolver hook for internal
    // package requires that fire from inside extracted packages.
    const entry = readFileSync(join(standaloneDir, "server-entry.js"), "utf-8");
    expect(entry).toContain("__nbcAliases");
    expect(entry).toContain('"sharp-457ea9eae1af1a9c":"sharp"');
    expect(entry).toContain('"prettier-285d8f1d6bb5f650":"prettier"');
    expect(entry).toContain("Module._resolveFilename");
    // Runtime placeholder substitution must be in extractAssets
    expect(entry).toContain("__NBC_BASE__");
    // Rewritten chunks are listed so extraction only text-substitutes those
    expect(entry).toContain(
      '".next/server/chunks/ssr/[root-of-the-server].js"'
    );
  });

  test("discovers aliases from chunk literals even without build-time symlinks", () => {
    // On some Linux/Docker builds, Next.js doesn't create the
    // .next/node_modules/<mangled> symlinks. Discovery must fall back to
    // scanning the chunks themselves.
    const root = join(tmpBase, "turbopack-alias-no-symlink");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    const chunkPath = ".next/standalone/.next/server/chunks/ssr/page.js";
    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "no-symlink-build",
      [chunkPath]:
        `b.exports=a.x("sharp-457ea9eae1af1a9c",()=>require("sharp-457ea9eae1af1a9c"))`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      ".next/standalone/node_modules/.bun/sharp@0.34.5/node_modules/sharp/package.json":
        JSON.stringify({ name: "sharp", main: "index.js" }),
      ".next/standalone/node_modules/.bun/sharp@0.34.5/node_modules/sharp/index.js":
        "module.exports = {};",
      "public/favicon.ico": "icon",
    });

    // No `.next/node_modules/sharp-457...` symlink — discovery must come
    // from the chunk literal scan alone.

    generateEntryPoint({ standaloneDir, distDir, projectDir });

    const entry = readFileSync(join(standaloneDir, "server-entry.js"), "utf-8");
    expect(entry).toContain('"sharp-457ea9eae1af1a9c":"sharp"');
  });

  test("validator warns when an alias references a missing canonical package", () => {
    // Chunk references `missing-pkg-deadbeefdeadbeef` but no `missing-pkg`
    // is installed anywhere in the standalone. The build still has to run
    // to completion (we don't fail the build — runtime might handle it
    // via try/catch in an optional code path) but it must emit a warning
    // so the user sees the issue at build time, not deploy time.
    const root = join(tmpBase, "alias-unresolved-warn");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "warn-build",
      ".next/standalone/.next/server/chunks/ssr/page.js":
        `require("missing-pkg-deadbeefdeadbeef")`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      // no missing-pkg anywhere
      "public/favicon.ico": "icon",
    });

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    try {
      generateEntryPoint({ standaloneDir, distDir, projectDir });
    } finally {
      console.warn = origWarn;
    }

    const joined = warns.join("\n");
    expect(joined).toContain("missing-pkg-deadbeefdeadbeef");
    expect(joined).toContain("missing-pkg");
    expect(joined).toContain("won't resolve at runtime");
  });

  test("server-entry embeds the debug-mode resolver hook logging", () => {
    // Debug mode is gated by NEXT_BUN_COMPILE_DEBUG at runtime — the
    // emitted entry just needs to contain the conditional + log calls
    // so users can flip the env var without rebuilding.
    const root = join(tmpBase, "debug-mode-emitted");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "debug-build",
      ".next/standalone/.next/server/chunks/ssr/page.js": `// chunk`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      "public/favicon.ico": "icon",
    });

    generateEntryPoint({ standaloneDir, distDir, projectDir });
    const entry = readFileSync(join(standaloneDir, "server-entry.js"), "utf-8");

    expect(entry).toContain("NEXT_BUN_COMPILE_DEBUG");
    expect(entry).toContain("__nbcDebug");
    expect(entry).toContain("redirected");
    expect(entry).toContain("fallback resolved");
    expect(entry).toContain("fallback FAILED");
  });

  test("validator stays quiet when every alias resolves", () => {
    const root = join(tmpBase, "alias-all-resolved");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "ok-build",
      ".next/standalone/.next/server/chunks/ssr/page.js":
        `require("sharp-457ea9eae1af1a9c")`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      ".next/standalone/node_modules/.bun/sharp@0.34.5/node_modules/sharp/package.json":
        JSON.stringify({ name: "sharp", main: "index.js" }),
      ".next/standalone/node_modules/.bun/sharp@0.34.5/node_modules/sharp/index.js":
        "module.exports = {};",
      "public/favicon.ico": "icon",
    });

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    try {
      generateEntryPoint({ standaloneDir, distDir, projectDir });
    } finally {
      console.warn = origWarn;
    }

    expect(warns.join("\n")).not.toContain("won't resolve");
  });

  test("server-entry embeds the extraction manifest fast-path", () => {
    const root = join(tmpBase, "manifest-fast-path");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "manifest-build",
      ".next/standalone/.next/server/chunks/ssr.js": `// chunk`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      "public/favicon.ico": "icon",
    });

    generateEntryPoint({ standaloneDir, distDir, projectDir });
    const entry = readFileSync(join(standaloneDir, "server-entry.js"), "utf-8");

    // Manifest skip: matching stamp on disk means extraction is bypassed
    expect(entry).toContain(".nbc-extracted");
    expect(entry).toContain("buildStamp");
    // Stamp is a 64-hex sha256 over the embedded assets, tied to baseDir
    expect(entry).toMatch(/const buildStamp = "[0-9a-f]{64}" \+ "\\n" \+ baseDir;/);
  });

  test("build stamp changes when embedded asset content changes", () => {
    const files = {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static v1",
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "stamp-build",
      ".next/standalone/.next/server/chunks/ssr.js": `// chunk`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      "public/favicon.ico": "icon",
    };
    const stampOf = (root: string, overrides: Record<string, string>) => {
      const distDir = join(root, ".next");
      const standaloneDir = join(distDir, "standalone");
      scaffold(root, { ...files, ...overrides });
      generateEntryPoint({ standaloneDir, distDir, projectDir: root });
      const entry = readFileSync(join(standaloneDir, "server-entry.js"), "utf-8");
      return entry.match(/const buildStamp = "([0-9a-f]{64})"/)?.[1];
    };

    const a = stampOf(join(tmpBase, "stamp-a"), {});
    const b = stampOf(join(tmpBase, "stamp-b"), {});
    const c = stampOf(join(tmpBase, "stamp-c"), {
      ".next/static/app.js": "// static v2",
    });

    expect(a).toBeDefined();
    expect(a).toBe(b!); // identical inputs → identical stamp
    expect(a).not.toBe(c!); // changed asset content → different stamp
  });

  test("asset var names never collide, even with identical sanitized prefixes", () => {
    // toVarName truncates the sanitized path to 40 chars; deep node_modules
    // trees (e.g. puppeteer) produce thousands of assets sharing that
    // prefix. A truncated hash suffix collided in the wild — names must be
    // unique by construction.
    const root = join(tmpBase, "varname-collision");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    const files: Record<string, string> = {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/standalone/server.js": MOCK_SERVER_JS,
      ".next/standalone/.next/BUILD_ID": "collision-build",
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
    };
    // 200 files whose urlPaths all sanitize to the same 40-char prefix
    for (let i = 0; i < 200; i++) {
      files[
        `.next/standalone/node_modules/puppeteer-core/lib/cjs/deep/nested/path/file-${i}.js`
      ] = `// file ${i}`;
    }
    scaffold(root, files);

    generateEntryPoint({ standaloneDir, distDir, projectDir });

    const assets = readFileSync(join(standaloneDir, "assets.generated.js"), "utf-8");
    const names = [...assets.matchAll(/^import (asset_\S+) from /gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(200);
    expect(new Set(names).size).toBe(names.length);
  });

  test("deeply nested monorepo layout (packages/apps/web)", () => {
    const root = join(tmpBase, "deep-mono");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/required-server-files.json": MOCK_RSF,
      ".next/static/app.js": "// static",
      ".next/standalone/packages/apps/web/server.js": MOCK_SERVER_JS,
      ".next/standalone/packages/apps/web/.next/BUILD_ID": "deep-build",
      ".next/standalone/packages/apps/web/.next/server/chunks/ssr.js": `// chunk`,
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
      ".next/standalone/node_modules/next/dist/server/require-hook.js": MOCK_REQUIRE_HOOK,
      "public/favicon.ico": "icon",
    });

    const serverDir = generateEntryPoint({ standaloneDir, distDir, projectDir });
    expect(serverDir).toBe(join(standaloneDir, "packages/apps/web"));
    expect(existsSync(join(serverDir, "server-entry.js"))).toBe(true);
  });
});
