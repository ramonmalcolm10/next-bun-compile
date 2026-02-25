import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateEntryPoint } from "./generate.js";

const tmpBase = join(import.meta.dir, "..", ".test-fixtures");

/** Minimal server.js content that passes the nextConfig regex */
const MOCK_SERVER_JS = `const nextConfig = {"env":{}}\nprocess.exit(0);\n`;

/** Minimal bun-compile-ctx.json */
const MOCK_CTX = JSON.stringify({ distDir: "", projectDir: "", assetPrefix: "" });

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
      ".next/bun-compile-ctx.json": MOCK_CTX,
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
      ".next/bun-compile-ctx.json": MOCK_CTX,
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
      ".next/bun-compile-ctx.json": MOCK_CTX,
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
      ".next/bun-compile-ctx.json": MOCK_CTX,
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
      ".next/bun-compile-ctx.json": MOCK_CTX,
      // standalone dir exists but has no server.js
      ".next/standalone/.next/BUILD_ID": "no-server",
      ".next/standalone/node_modules/next/package.json": MOCK_NEXT_PKG,
    });

    expect(() =>
      generateEntryPoint({ standaloneDir, distDir, projectDir })
    ).toThrow("Could not find server.js");
  });

  test("deeply nested monorepo layout (packages/apps/web)", () => {
    const root = join(tmpBase, "deep-mono");
    const distDir = join(root, ".next");
    const standaloneDir = join(distDir, "standalone");
    const projectDir = root;

    scaffold(root, {
      ".next/bun-compile-ctx.json": MOCK_CTX,
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
