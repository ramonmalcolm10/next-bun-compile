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
/**
 * Find all real locations of a package inside node_modules/, including
 * bun's hoisted `.bun/<pkg>@version/node_modules/<pkg>/` layout.
 */
function findPackageDirs(
  nodeModulesDir: string,
  pkg: string
): string[] {
  const dirs: string[] = [];

  // Direct path: node_modules/<pkg>/
  const direct = join(nodeModulesDir, pkg);
  if (existsSync(direct)) dirs.push(direct);

  // Bun hoisted layout: node_modules/.bun/<pkg>@*\/node_modules/<pkg>/
  const bunDir = join(nodeModulesDir, ".bun");
  if (existsSync(bunDir)) {
    const scope = pkg.startsWith("@") ? pkg.split("/")[0] + "+" + pkg.split("/")[1] : pkg;
    for (const entry of readdirSync(bunDir)) {
      if (!entry.startsWith(scope + "@")) continue;
      const hoisted = join(bunDir, entry, "node_modules", pkg);
      if (existsSync(hoisted)) dirs.push(hoisted);
    }
  }

  return dirs;
}

function generateStubs(standaloneDir: string): void {
  const stubs: Array<{ pkg: string; subpath: string; content: string }> = [
    // Dev-only — guarded by runtime `options.dev` / `opts.dev`, not env vars
    {
      pkg: "next",
      subpath: "dist/server/dev/next-dev-server.js",
      content: "module.exports = { default: null };",
    },
    {
      pkg: "next",
      subpath: "dist/server/lib/router-utils/setup-dev-bundler.js",
      content: "module.exports = {};",
    },
    // Optional deps — loaded in try/catch or conditional require at runtime
    {
      pkg: "@opentelemetry/api",
      subpath: "index.js",
      content: "throw new Error('not installed');",
    },
    {
      pkg: "critters",
      subpath: "index.js",
      content: "module.exports = {};",
    },
  ];

  const nodeModulesDir = join(standaloneDir, "node_modules");
  let count = 0;
  for (const stub of stubs) {
    const pkgDirs = findPackageDirs(nodeModulesDir, stub.pkg);
    // If the package isn't installed at all, create stub at the default location
    if (pkgDirs.length === 0) pkgDirs.push(join(nodeModulesDir, stub.pkg));

    for (const pkgDir of pkgDirs) {
      const fullPath = join(pkgDir, stub.subpath);
      if (!existsSync(fullPath)) {
        const dir = join(fullPath, "..");
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, stub.content);
        count++;
      }
    }
  }
  if (count > 0) {
    console.log(`next-bun-compile: Created ${count} module stubs`);
  }
}

/**
 * Locate the directory containing server.js inside the standalone output.
 * For regular projects this is standaloneDir itself. For Turborepo monorepos,
 * Next.js nests the app (e.g. standalone/apps/web/server.js).
 */
function findServerDir(standaloneDir: string): string {
  // Fast path: regular (non-monorepo) layout
  if (existsSync(join(standaloneDir, "server.js"))) {
    return standaloneDir;
  }

  // Monorepo layout: search subdirectories (skip node_modules)
  function search(dir: string): string | null {
    if (!existsSync(dir)) return null;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (existsSync(join(full, "server.js"))) return full;
      const found = search(full);
      if (found) return found;
    }
    return null;
  }

  const found = search(standaloneDir);
  if (!found) {
    throw new Error(
      "next-bun-compile: Could not find server.js in standalone output"
    );
  }

  const rel = relative(standaloneDir, found);
  console.log(
    `next-bun-compile: Monorepo layout detected — server.js found at ${rel}/`
  );
  return found;
}

/**
 * Patch require-hook.js so require.resolve calls don't crash in compiled binaries.
 * Next.js eagerly resolves packages like styled-jsx at startup, which fails when
 * there's no node_modules on disk (deployed compiled binary).
 */
function patchRequireHook(standaloneDir: string): void {
  const nodeModulesDir = join(standaloneDir, "node_modules");
  const nextDirs = findPackageDirs(nodeModulesDir, "next");

  const target =
    "let resolve = process.env.NEXT_MINIMAL ? __non_webpack_require__.resolve : require.resolve;";
  const replacement =
    "let _resolve = process.env.NEXT_MINIMAL ? __non_webpack_require__.resolve : require.resolve;\nlet resolve = (id) => { try { return _resolve(id); } catch { return ''; } };";

  let patched = 0;
  for (const nextDir of nextDirs) {
    const hookPath = join(nextDir, "dist/server/require-hook.js");
    if (!existsSync(hookPath)) continue;

    let content = readFileSync(hookPath, "utf-8");
    if (!content.includes(target)) continue;

    content = content.replace(target, replacement);
    writeFileSync(hookPath, content);
    patched++;
  }
  if (patched > 0) {
    console.log(
      "next-bun-compile: Patched require-hook.js for compiled binary compatibility"
    );
  }
}

/**
 * Scan server chunks for externalRequire() calls to next/dist/* modules,
 * then recursively trace their require() dependencies. Returns the full
 * set of files that must exist on disk for SSR and route handlers to work.
 */
function collectExternalModules(
  standaloneDir: string,
  serverDir: string
): string[] {
  const chunksDir = join(serverDir, ".next/server/chunks");
  if (!existsSync(chunksDir)) return [];

  // Scan all server chunks (SSR + route handlers) for require("next/...") references
  const seeds = new Set<string>();
  for (const { absolutePath } of walkDir(chunksDir)) {
    if (!absolutePath.endsWith(".js")) continue;
    const content = readFileSync(absolutePath, "utf-8");
    for (const match of content.matchAll(/require\("(next\/dist\/[^"]+)"\)/g)) {
      seeds.add(match[1]);
    }
  }

  // Recursively trace require() deps within node_modules/
  const deps = new Set<string>();
  function trace(file: string): void {
    if (deps.has(file)) return;
    let fullPath = join(standaloneDir, "node_modules", file);
    // Resolve directories to their index file and package.json
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      const pkgJson = join(fullPath, "package.json");
      if (existsSync(pkgJson)) {
        deps.add(file + "/package.json");
      }
      file = file + "/index.js";
      fullPath = join(standaloneDir, "node_modules", file);
    }
    if (!existsSync(fullPath)) return;
    deps.add(file);
    const content = readFileSync(fullPath, "utf-8");
    for (const match of content.matchAll(/require\("([^"]+)"\)/g)) {
      const req = match[1];
      let resolved: string | undefined;
      if (req.startsWith(".")) {
        resolved = join(file, "..", req).replace(/\\/g, "/");
        if (!resolved.endsWith(".js")) resolved += ".js";
      } else if (req.startsWith("next/")) {
        resolved = req;
        if (!resolved.endsWith(".js")) resolved += ".js";
      }
      if (resolved) trace(resolved);
    }
  }
  for (const seed of seeds) trace(seed);
  return [...deps];
}

export function generateEntryPoint(options: GenerateOptions): string {
  const { standaloneDir, distDir, projectDir } = options;
  const serverDir = findServerDir(standaloneDir);

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
  const standaloneNextDir = join(serverDir, ".next");
  const runtimeFiles = walkDir(standaloneNextDir).map((f) => ({
    ...f,
    urlPath: `__runtime/.next/${f.relativePath.replace(/\\/g, "/")}`,
  }));

  // Copy external modules into .next/__external/ so they get embedded as
  // regular file assets (JS files in node_modules/ conflict with bun's bundler).
  // At runtime these are extracted to .next/node_modules/ for SSR chunk resolution.
  const externalModules = collectExternalModules(standaloneDir, serverDir);
  const externalPaths = ["next/package.json", ...externalModules];
  const externalDir = join(serverDir, ".next/__external");
  for (const mod of externalPaths) {
    const src = join(standaloneDir, "node_modules", mod);
    if (!existsSync(src)) continue;
    const dest = join(externalDir, mod);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, readFileSync(src));
    runtimeFiles.push({
      absolutePath: dest,
      relativePath: `__external/${mod}`,
      urlPath: `__runtime/.next/node_modules/${mod.replace(/\\/g, "/")}`,
    });
  }
  if (externalModules.length > 0) {
    console.log(
      `next-bun-compile: Embedding ${externalModules.length} external modules for SSR`
    );
  }

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
    const importPath = relative(serverDir, asset.absolutePath).replace(
      /\\/g,
      "/"
    );
    imports.push(
      `import ${varName} from "./${importPath}" with { type: "file" };`
    );
    mapEntries.push(`  ["${asset.urlPath}", ${varName}],`);
  }

  writeFileSync(
    join(serverDir, "assets.generated.js"),
    `${imports.join("\n")}\nexport const assetMap = new Map([\n${mapEntries.join("\n")}\n]);\n`
  );

  // Extract nextConfig from standalone server.js
  const standaloneServerSrc = readFileSync(
    join(serverDir, "server.js"),
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

  writeFileSync(join(serverDir, "server-entry.js"), serverEntry);

  return serverDir;
}
