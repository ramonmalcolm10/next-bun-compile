import {
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

interface GenerateOptions {
  standaloneDir: string;
  distDir: string;
  projectDir: string;
}

/** Recursively collect all files under a directory */
function walkDir(
  dir: string,
  base: string = dir
): Array<{ absolutePath: string; relativePath: string }> {
  const results: Array<{ absolutePath: string; relativePath: string }> = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkDir(full, base));
    } else {
      results.push({ absolutePath: full, relativePath: relative(base, full) });
    }
  }
  return results;
}

/** Generate a safe JS variable name from a file path */
function toVarName(filePath: string): string {
  const hash = createHash("md5").update(filePath).digest("hex").slice(0, 6);
  const safe = filePath.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
  return `asset_${safe}_${hash}`;
}

/**
 * Create stub files for modules that bun can't resolve but are never
 * actually reached in production. Stubs are only created if the real
 * module doesn't already exist — so if a user actually installs the
 * dependency (e.g. @opentelemetry/api), the real one gets bundled.
 */
function generateStubs(standaloneDir: string): void {
  const stubs: Array<{ path: string; content: string }> = [
    // Dev-only — guarded by runtime `options.dev` / `opts.dev`, not env vars
    {
      path: "node_modules/next/dist/server/dev/next-dev-server.js",
      content: "module.exports = { default: null };",
    },
    {
      path: "node_modules/next/dist/server/lib/router-utils/setup-dev-bundler.js",
      content: "module.exports = {};",
    },
    // Optional deps — loaded in try/catch or conditional require at runtime
    {
      path: "node_modules/@opentelemetry/api/index.js",
      content: "throw new Error('not installed');",
    },
    {
      path: "node_modules/critters/index.js",
      content: "module.exports = {};",
    },
  ];

  let count = 0;
  for (const stub of stubs) {
    const fullPath = join(standaloneDir, stub.path);
    if (!existsSync(fullPath)) {
      const dir = join(fullPath, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(fullPath, stub.content);
      count++;
    }
  }
  if (count > 0) {
    console.log(`next-bun-compile: Created ${count} module stubs`);
  }
}

/**
 * Patch require-hook.js so require.resolve calls don't crash in compiled binaries.
 * Next.js eagerly resolves packages like styled-jsx at startup, which fails when
 * there's no node_modules on disk (deployed compiled binary).
 */
function patchRequireHook(standaloneDir: string): void {
  const hookPath = join(
    standaloneDir,
    "node_modules/next/dist/server/require-hook.js"
  );
  if (!existsSync(hookPath)) return;

  let content = readFileSync(hookPath, "utf-8");

  const target =
    "let resolve = process.env.NEXT_MINIMAL ? __non_webpack_require__.resolve : require.resolve;";
  if (!content.includes(target)) return;

  content = content.replace(
    target,
    "let _resolve = process.env.NEXT_MINIMAL ? __non_webpack_require__.resolve : require.resolve;\nlet resolve = (id) => { try { return _resolve(id); } catch { return ''; } };"
  );

  writeFileSync(hookPath, content);
  console.log(
    "next-bun-compile: Patched require-hook.js for compiled binary compatibility"
  );
}

export function generateEntryPoint(options: GenerateOptions): void {
  const { standaloneDir, distDir, projectDir } = options;

  generateStubs(standaloneDir);
  patchRequireHook(standaloneDir);

  // Discover assets
  const staticDir = join(distDir, "static");
  const staticFiles = walkDir(staticDir).map((f) => ({
    ...f,
    urlPath: `/_next/static/${f.relativePath.replace(/\\/g, "/")}`,
  }));

  const publicDir = join(projectDir, "public");
  const publicFiles = walkDir(publicDir).map((f) => ({
    ...f,
    urlPath: `/${f.relativePath.replace(/\\/g, "/")}`,
  }));

  // Discover runtime files from standalone .next/ (BUILD_ID, manifests, server chunks)
  const standaloneNextDir = join(standaloneDir, ".next");
  const runtimeFiles = walkDir(standaloneNextDir).map((f) => ({
    ...f,
    urlPath: `__runtime/.next/${f.relativePath.replace(/\\/g, "/")}`,
  }));

  // Check build context for assetPrefix — if set, static assets are served
  // from a CDN and don't need to be embedded in the binary.
  const ctx = JSON.parse(
    readFileSync(join(distDir, "bun-compile-ctx.json"), "utf-8")
  );
  const { assetPrefix } = ctx;

  const assetsToEmbed = assetPrefix
    ? [...publicFiles, ...runtimeFiles]
    : [...staticFiles, ...publicFiles, ...runtimeFiles];

  if (assetPrefix) {
    console.log(
      `next-bun-compile: assetPrefix detected — skipping ${staticFiles.length} static assets (served from CDN)`
    );
  }

  console.log(
    `next-bun-compile: Embedding ${assetsToEmbed.length} assets (${staticFiles.length} static + ${publicFiles.length} public + ${runtimeFiles.length} runtime)`
  );

  // Generate assets.generated.js
  const imports: string[] = [];
  const mapEntries: string[] = [];

  for (const asset of assetsToEmbed) {
    const varName = toVarName(asset.urlPath);
    const importPath = relative(standaloneDir, asset.absolutePath).replace(
      /\\/g,
      "/"
    );
    imports.push(
      `import ${varName} from "./${importPath}" with { type: "file" };`
    );
    mapEntries.push(`  ["${asset.urlPath}", ${varName}],`);
  }

  writeFileSync(
    join(standaloneDir, "assets.generated.js"),
    `${imports.join("\n")}\nexport const assetMap = new Map([\n${mapEntries.join("\n")}\n]);\n`
  );

  // Extract nextConfig from standalone server.js
  const standaloneServerSrc = readFileSync(
    join(standaloneDir, "server.js"),
    "utf-8"
  );
  const configMatch = standaloneServerSrc.match(
    /const nextConfig = ({[\s\S]*?})\n/
  );
  if (!configMatch) {
    throw new Error(
      "next-bun-compile: Could not extract nextConfig from standalone server.js"
    );
  }

  // Build extraction map for embedded assets
  const assetExtractions = assetsToEmbed.map((a) => {
    let diskPath: string;
    if (a.urlPath.startsWith("__runtime/")) {
      diskPath = a.urlPath.slice("__runtime/".length);
    } else if (a.urlPath.startsWith("/_next/static/")) {
      diskPath = ".next/static/" + a.relativePath;
    } else {
      diskPath = "public/" + a.relativePath;
    }
    return [a.urlPath, diskPath];
  });

  // Generate server-entry.js
  const serverEntry = `import { assetMap } from "./assets.generated.js";
const path = require("path");
const fs = require("fs");

const baseDir = path.dirname(process.execPath);
process.chdir(baseDir);
process.env.NODE_ENV = "production";

const nextConfig = ${configMatch[1]};
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";
let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
if (Number.isNaN(keepAliveTimeout) || !Number.isFinite(keepAliveTimeout) || keepAliveTimeout < 0) {
  keepAliveTimeout = undefined;
}

const extractions = ${JSON.stringify(assetExtractions)};
async function extractAssets() {
  let n = 0;
  for (const [urlPath, diskPath] of extractions) {
    const fullPath = path.join(baseDir, diskPath);
    if (fs.existsSync(fullPath)) continue;
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const embedded = assetMap.get(urlPath);
    if (embedded) { await Bun.write(fullPath, Bun.file(embedded)); n++; }
  }
  if (n > 0) console.log(\`Extracted \${n} assets\`);
}

extractAssets().then(() => {
  require("next");
  const { startServer } = require("next/dist/server/lib/start-server");
  return startServer({
    dir: baseDir, isDev: false, config: nextConfig,
    hostname, port: currentPort, allowRetry: false, keepAliveTimeout,
  });
}).catch((err) => { console.error(err); process.exit(1); });
`;

  writeFileSync(join(standaloneDir, "server-entry.js"), serverEntry);
}
