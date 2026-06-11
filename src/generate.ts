import {
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  type Stats,
} from "node:fs";
import { join, relative, basename } from "node:path";
import { createHash } from "node:crypto";

interface GenerateOptions {
  standaloneDir: string;
  distDir: string;
  projectDir: string;
}

/**
 * statSync that returns null instead of throwing on EPERM/EACCES/ENOENT.
 * Bun's hoisted store (node_modules/.bun/<pkg>@<ver>/node_modules/<dep>) uses
 * symlinks pointing to other entries in the same store. On Windows those
 * targets can be locked and statSync throws EPERM (bun#4533) — leaving the
 * symlink unwalkable. The real package files always exist at their canonical
 * .bun/<dep>@<ver>/node_modules/<dep>/ path, so skipping the unstattable
 * entry doesn't lose data.
 */
function tryStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOENT") return null;
    throw err;
  }
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
    const stat = tryStat(full);
    if (!stat) continue;
    if (stat.isDirectory()) {
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
 * hoisted layouts used by bun (.bun/) and pnpm (.pnpm/).
 * Both use: node_modules/.<manager>/<pkg>@version/node_modules/<pkg>/
 */
function findPackageDirs(
  nodeModulesDir: string,
  pkg: string
): string[] {
  const dirs: string[] = [];

  // Direct path: node_modules/<pkg>/
  const direct = join(nodeModulesDir, pkg);
  if (existsSync(direct)) dirs.push(direct);

  // Hoisted layouts (.bun/ and .pnpm/)
  const prefix = pkg.startsWith("@")
    ? pkg.split("/")[0] + "+" + pkg.split("/")[1]
    : pkg;
  for (const store of [".bun", ".pnpm"]) {
    const storeDir = join(nodeModulesDir, store);
    if (!existsSync(storeDir)) continue;
    for (const entry of readdirSync(storeDir)) {
      if (!entry.startsWith(prefix + "@")) continue;
      const hoisted = join(storeDir, entry, "node_modules", pkg);
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
 * Next.js with turbopack rewrites externalized requires to mangled names,
 * e.g. `require("sharp")` becomes `require("sharp-457ea9eae1af1a9c")` in
 * the emitted chunks. During `next start` Next.js relies on a symlink at
 * `.next/node_modules/<mangled> -> ../../node_modules/<real>` for those
 * requires to resolve. The compiled binary has no node_modules tree
 * pre-baked on disk, so the aliases need to be materialized after asset
 * extraction.
 *
 * Discovery: grep server chunks for `require("<name>-<16hex>")` literals.
 * Works regardless of whether Next.js created the `.next/node_modules/<mangled>`
 * symlink during build — it does on macOS but not on some Linux/Docker
 * configurations. The canonical name is the mangled name with the trailing
 * `-<16 hex>` content hash stripped. The build-time symlink is consulted
 * as a fallback for aliases referenced outside literal `require()` calls.
 */
function findTurbopackAliases(
  standaloneNextDir: string
): Array<{ alias: string; target: string; subpaths: string[] }> {
  const seen = new Map<
    string,
    { target: string; subpaths: Set<string> }
  >();

  const ensure = (alias: string) => {
    let entry = seen.get(alias);
    if (!entry) {
      entry = {
        target: alias.replace(/-[0-9a-f]{16}$/, ""),
        subpaths: new Set(),
      };
      seen.set(alias, entry);
    }
    return entry;
  };

  const serverDir = join(standaloneNextDir, "server");
  if (existsSync(serverDir)) {
    // Match any string literal of the shape `"<name>-<16 hex>[/<subpath>]"`.
    // Turbopack passes mangled ids to its runtime helpers as bare strings
    // (e.g. `a.y("prettier-.../plugins/html")`), so a regex anchored to
    // `require(...)`/`import(...)` misses the externalImport call sites.
    // The 16-hex suffix is selective enough that false positives in JS
    // chunks are vanishingly unlikely.
    const re = /["']([^"'\s/]+-[0-9a-f]{16})(?:\/([^"'\s]+))?["']/g;
    for (const f of walkDir(serverDir)) {
      if (!f.absolutePath.endsWith(".js")) continue;
      let content: string;
      try {
        content = readFileSync(f.absolutePath, "utf-8");
      } catch {
        continue;
      }
      let m;
      while ((m = re.exec(content))) {
        const entry = ensure(m[1]);
        if (m[2]) entry.subpaths.add(m[2]);
      }
    }
  }

  const nodeModulesDir = join(standaloneNextDir, "node_modules");
  if (existsSync(nodeModulesDir)) {
    for (const name of readdirSync(nodeModulesDir)) {
      if (!/-[0-9a-f]{16}$/.test(name)) continue;
      if (seen.has(name)) continue;
      const aliasPath = join(nodeModulesDir, name);
      try {
        if (!lstatSync(aliasPath).isSymbolicLink()) continue;
        seen.set(name, {
          target: basename(realpathSync(aliasPath)),
          subpaths: new Set(),
        });
      } catch {
        continue;
      }
    }
  }

  return Array.from(seen, ([alias, { target, subpaths }]) => ({
    alias,
    target,
    subpaths: Array.from(subpaths),
  }));
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
      const stat = tryStat(full);
      if (!stat || !stat.isDirectory()) continue;
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
 * Collect all files under node_modules/ in the standalone output.
 * Next.js standalone already tree-shakes to only what's needed at runtime.
 * Skips .bun/.pnpm store dirs and next-bun-compile itself.
 */
/**
 * Returns array of {mod, src} where mod is the canonical module path
 * (e.g. "next/dist/server/next.js") and src is the absolute path on disk.
 */
function collectExternalModules(
  standaloneDir: string
): Array<{ mod: string; src: string }> {
  const nodeModulesDir = join(standaloneDir, "node_modules");
  if (!existsSync(nodeModulesDir)) return [];

  // Collect all package directories, including those in .bun/.pnpm stores
  const pkgRoots = new Map<string, string>(); // pkg name -> absolute path

  function addPkg(name: string, path: string) {
    if (!pkgRoots.has(name)) pkgRoots.set(name, path);
  }

  function scanDir(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || entry === "next-bun-compile") continue;
      const entryPath = join(dir, entry);
      const stat = tryStat(entryPath);
      if (!stat || !stat.isDirectory()) continue;
      if (entry.startsWith("@")) {
        for (const sub of readdirSync(entryPath)) {
          const subPath = join(entryPath, sub);
          const subStat = tryStat(subPath);
          if (subStat && subStat.isDirectory()) addPkg(`${entry}/${sub}`, subPath);
        }
      } else {
        addPkg(entry, entryPath);
      }
    }
  }

  scanDir(nodeModulesDir);

  for (const store of [".bun", ".pnpm"]) {
    const storeDir = join(nodeModulesDir, store);
    if (!existsSync(storeDir)) continue;
    for (const storeEntry of readdirSync(storeDir)) {
      const nested = join(storeDir, storeEntry, "node_modules");
      if (existsSync(nested)) scanDir(nested);
    }
  }

  const results: Array<{ mod: string; src: string }> = [];
  for (const [name, pkgPath] of pkgRoots) {
    for (const f of walkDir(pkgPath)) {
      results.push({
        mod: `${name}/${f.relativePath.replace(/\\/g, "/")}`,
        src: f.absolutePath,
      });
    }
  }
  return results;
}

/**
 * Fix module resolution issues in standalone node_modules for bun's compiled
 * binary, which doesn't support package.json "main" for directory requires
 * or "exports" maps.
 */
function fixModuleResolution(standaloneDir: string): void {
  const nodeModulesDir = join(standaloneDir, "node_modules");

  // 1. Create index.js shims for next/dist/compiled/* packages whose
  //    package.json "main" isn't index.js (e.g. source-map -> source-map.js)
  for (const pkgDir of findPackageDirs(nodeModulesDir, "next")) {
    const compiledDir = join(pkgDir, "dist/compiled");
    if (!existsSync(compiledDir)) continue;
    for (const entry of readdirSync(compiledDir)) {
      const dir = join(compiledDir, entry);
      const stat = tryStat(dir);
      if (!stat || !stat.isDirectory()) continue;
      const pkgJsonPath = join(dir, "package.json");
      const indexPath = join(dir, "index.js");
      if (!existsSync(pkgJsonPath) || existsSync(indexPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (pkg.main && pkg.main !== "index.js") {
        writeFileSync(indexPath, `module.exports = require("./${pkg.main}");`);
      }
    }
  }

  // 2. Create filesystem shims for packages using "exports" maps that bun's
  //    compiled binary can't resolve (e.g. @swc/helpers/_/X -> cjs/X.cjs)
  for (const helpersDir of findPackageDirs(nodeModulesDir, "@swc/helpers")) {
    const cjsDir = join(helpersDir, "cjs");
    if (!existsSync(cjsDir)) continue;
    for (const file of readdirSync(cjsDir)) {
      if (!file.endsWith(".cjs")) continue;
      const name = file.slice(0, -4);
      const shimDir = join(helpersDir, "_", name);
      const shimFile = join(shimDir, "index.js");
      if (existsSync(shimFile)) continue;
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(shimFile, `module.exports = require("../../cjs/${file}");`);
    }
  }
}

export function generateEntryPoint(options: GenerateOptions): string {
  const { standaloneDir, distDir, projectDir } = options;
  const serverDir = findServerDir(standaloneDir);

  generateStubs(standaloneDir);
  patchRequireHook(standaloneDir);
  fixModuleResolution(standaloneDir);

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

  // Discover runtime files from standalone .next/ (BUILD_ID, manifests, server chunks).
  // Skip files reached through turbopack's mangled-alias symlinks — we recreate
  // those as runtime symlinks/shims instead of embedding duplicate copies.
  const standaloneNextDir = join(serverDir, ".next");
  const turbopackAliases = findTurbopackAliases(standaloneNextDir);
  const aliasNames = new Set(turbopackAliases.map((a) => a.alias));
  const runtimeFiles = walkDir(standaloneNextDir)
    .filter((f) => {
      const m = f.relativePath.replace(/\\/g, "/").match(/^node_modules\/([^/]+)/);
      return !(m && aliasNames.has(m[1]));
    })
    .map((f) => ({
      ...f,
      urlPath: `__runtime/.next/${f.relativePath.replace(/\\/g, "/")}`,
    }));

  // Copy external modules into .next/__external/ so they get embedded as
  // regular file assets (JS files in node_modules/ conflict with bun's bundler).
  // At runtime these are extracted to .next/node_modules/ for SSR chunk resolution.
  const externalModules = collectExternalModules(standaloneDir);
  const externalDir = join(serverDir, ".next/__external");
  for (const { mod, src } of externalModules) {
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
const turbopackAliases = ${JSON.stringify(turbopackAliases.map((a) => [a.alias, a.target, a.subpaths]))};
async function extractAssets() {
  let n = 0;
  for (const [urlPath, diskPath] of extractions) {
    const fullPath = path.join(baseDir, diskPath);
    if (fs.existsSync(fullPath)) continue;
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const embedded = assetMap.get(urlPath);
    if (embedded) { await Bun.write(fullPath, Bun.file(embedded)); n++; }
  }
  for (const [alias, target, subpaths] of turbopackAliases) {
    const aliasPath = path.join(baseDir, ".next/node_modules", alias);
    if (!fs.existsSync(aliasPath)) {
      fs.mkdirSync(aliasPath, { recursive: true });
      fs.writeFileSync(
        path.join(aliasPath, "package.json"),
        JSON.stringify({ name: alias, main: "index.js" })
      );
      // Relative path bypasses bun's package-name resolver, which doesn't
      // walk up to the parent node_modules from inside an alias directory.
      fs.writeFileSync(
        path.join(aliasPath, "index.js"),
        "module.exports = require(" + JSON.stringify("../" + target) + ");"
      );
    }
    for (const sub of subpaths) {
      const subKey = sub.replace(/\\.js$/, "");
      const shimFile = path.join(aliasPath, subKey + ".js");
      if (fs.existsSync(shimFile)) continue;
      fs.mkdirSync(path.dirname(shimFile), { recursive: true });
      const canonicalFile = path.join(baseDir, ".next/node_modules", target, subKey);
      const rel = path.relative(path.dirname(shimFile), canonicalFile);
      const spec = rel.startsWith(".") ? rel : "./" + rel;
      fs.writeFileSync(
        shimFile,
        "module.exports = require(" + JSON.stringify(spec) + ");"
      );
    }
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
