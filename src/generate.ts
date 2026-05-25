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
 * Recursively collect every file under standaloneDir/node_modules/.
 *
 * Files are placed at .next/node_modules/<rel> at runtime — that's where
 * Next.js's chunks (which live in .next/server/) walk up to find externals.
 *
 * Hoisted package managers (bun's .bun/, pnpm's .pnpm/) put real package
 * files at .bun/<pkg>@<ver>/node_modules/<pkg>/ and rely on top-level
 * symlinks. Standalone output doesn't preserve those symlinks, so we
 * synthesize aliases: each .bun/.pnpm-stored file gets a SECOND virtual
 * map entry at the flat top-level path. This lets our custom resolver's
 * standard node_modules walk find packages that only physically live in
 * the hoisted store.
 */
function collectNodeModulesFiles(
  standaloneDir: string
): Array<{ absolutePath: string; relativePath: string }> {
  const nmDir = join(standaloneDir, "node_modules");
  if (!existsSync(nmDir)) return [];
  const out: Array<{ absolutePath: string; relativePath: string }> = [];
  const seen = new Set<string>();

  function add(rel: string, abs: string) {
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push({ absolutePath: abs, relativePath: rel });
  }

  // Pattern: .bun/<pkg>@<ver>[+...]/node_modules/<actualPath>
  //          .pnpm/<pkg>@<ver>[+...]/node_modules/<actualPath>
  // The bare path inside is the "logical" package location.
  const hoistedRe = /^(?:\.bun|\.pnpm)\/[^/]+\/node_modules\/(.+)$/;

  for (const f of walkDir(nmDir)) {
    if (f.relativePath.startsWith("next-bun-compile/")) continue;
    const rel = f.relativePath.replace(/\\/g, "/");

    // Always add the literal store path (preserves any code that
    // require()s through the explicit .bun/.pnpm path)
    add(".next/node_modules/" + rel, f.absolutePath);

    // If this is a hoisted-store entry, also expose it at the flat path
    const m = rel.match(hoistedRe);
    if (m) add(".next/node_modules/" + m[1], f.absolutePath);
  }

  return out;
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
      if (!statSync(dir).isDirectory()) continue;
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

  // ─── Collect every file that needs to live in the binary ───────────────
  //
  // Each AssetEntry has a relativePath measured from baseDir at runtime —
  // i.e. the path the file would have if we extracted it. The virtual loader
  // serves modules from these paths without ever writing them to disk.
  type Asset = { absolutePath: string; relativePath: string };
  const assets: Asset[] = [];

  // 1. Standalone server tree (everything under serverDir except node_modules)
  for (const f of walkDir(serverDir)) {
    if (
      f.relativePath === "server.js" ||
      f.relativePath === "server-entry.js" ||
      f.relativePath === "assets.generated.js"
    )
      continue;
    if (
      f.relativePath === "node_modules" ||
      f.relativePath.startsWith("node_modules/") ||
      f.relativePath.startsWith("node_modules\\")
    )
      continue;
    assets.push({
      absolutePath: f.absolutePath,
      relativePath: f.relativePath.replace(/\\/g, "/"),
    });
  }

  // 2. node_modules → placed at .next/node_modules/ where Next.js's chunks
  //    (under .next/server/) walk up to find externals
  for (const f of collectNodeModulesFiles(standaloneDir)) {
    assets.push(f);
  }

  // 3. Static (.next/static/)
  for (const f of walkDir(join(distDir, "static"))) {
    assets.push({
      absolutePath: f.absolutePath,
      relativePath: ".next/static/" + f.relativePath.replace(/\\/g, "/"),
    });
  }

  // 4. Public files
  for (const f of walkDir(join(projectDir, "public"))) {
    assets.push({
      absolutePath: f.absolutePath,
      relativePath: "public/" + f.relativePath.replace(/\\/g, "/"),
    });
  }

  // assetPrefix → static files served from CDN; skip embedding them.
  // The adapter writes this context during build; missing it is fine —
  // we just default to no CDN.
  const ctxPath = join(distDir, "bun-compile-ctx.json");
  const assetPrefix: string = existsSync(ctxPath)
    ? JSON.parse(readFileSync(ctxPath, "utf-8")).assetPrefix || ""
    : "";

  // ─── Categorize each asset by access pattern ───────────────────────────
  // - virtual: loaded via require()/fs hooks against /$bunfs/, never touches disk
  // - eager: extracted before boot (.node native addons need real disk for dlopen)
  // - lazy: extracted after server starts (HTTP-served via Next.js's `send`
  //   module, which uses callback fs APIs that bun's compiled binary can't
  //   serve from /$bunfs/ reliably)
  // - skip: never needed at runtime
  type Category = "virtual" | "eager" | "lazy" | "skip";
  function categorize(rel: string): Category {
    if (rel.endsWith(".map")) return "skip";
    if (rel.endsWith(".d.ts")) return "skip";
    if (rel.endsWith(".node")) return "eager";
    if (rel.startsWith(".next/static/")) return "lazy";
    if (rel.startsWith("public/")) return "lazy";
    if (
      rel.endsWith(".html") ||
      rel.endsWith(".rsc") ||
      rel.endsWith(".meta") ||
      rel.endsWith(".body")
    )
      return "lazy";
    return "virtual";
  }

  const virtualAssets: Asset[] = [];
  const eagerAssets: Asset[] = [];
  const lazyAssets: Asset[] = [];

  for (const a of assets) {
    if (assetPrefix && a.relativePath.startsWith(".next/static/")) continue;
    const cat = categorize(a.relativePath);
    if (cat === "skip") continue;
    if (cat === "eager") eagerAssets.push(a);
    else if (cat === "lazy") lazyAssets.push(a);
    else virtualAssets.push(a);
  }

  console.log(
    `next-bun-compile: ${virtualAssets.length} virtual, ${eagerAssets.length} eager, ${lazyAssets.length} lazy`
  );

  // ─── Generate assets.generated.js ──────────────────────────────────────
  const imports: string[] = [];
  const virtualEntries: string[] = [];
  const eagerEntries: string[] = [];
  const lazyEntries: string[] = [];

  function emit(asset: Asset, target: string[]) {
    const varName = toVarName(asset.relativePath);
    const importPath = relative(serverDir, asset.absolutePath).replace(
      /\\/g,
      "/"
    );
    imports.push(
      `import ${varName} from "./${importPath}" with { type: "file" };`
    );
    target.push(`  ["${asset.relativePath}", ${varName}],`);
  }

  for (const a of virtualAssets) emit(a, virtualEntries);
  for (const a of eagerAssets) emit(a, eagerEntries);
  for (const a of lazyAssets) emit(a, lazyEntries);

  writeFileSync(
    join(serverDir, "assets.generated.js"),
    `${imports.join("\n")}
export const virtualMap = new Map([
${virtualEntries.join("\n")}
]);
export const eagerExtract = new Map([
${eagerEntries.join("\n")}
]);
export const lazyExtract = new Map([
${lazyEntries.join("\n")}
]);
`
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

  // ─── Generate server-entry.js (virtual loader) ─────────────────────────
  //
  // Architecture: we don't extract JS/JSON files. Instead we build a custom
  // Node-style resolver against an in-memory map of "logical disk path →
  // /$bunfs/ source" and load modules via Module._compile(readFileSync(vfs)).
  //
  // Why this works in bun's compiled binary:
  //   - Bun's *native* require() bypasses Node's Module API (so JS hooks
  //     don't intercept top-level require() calls)
  //   - But Module.createRequire(...) returns a Node-compat require that DOES
  //     go through Module._resolveFilename + Module._extensions hooks, AND
  //     propagates them to nested requires inside loaded modules.
  //   - fs.readFileSync works on /$bunfs/ paths, so we can stream module
  //     source straight from the binary.
  //
  // Only native addons (.node) get extracted — required by process.dlopen.
  // Everything else (JS, JSON, CSS, fonts, HTML, RSC, manifests, etc.)
  // streams from /$bunfs/ via fs hooks: readFileSync/promises.readFile for
  // module loading and manifests, createReadStream for HTTP-served assets,
  // readdirSync/promises.readdir so Next.js's static-folder enumeration sees
  // virtual files at startup.
  const serverEntry = `import { virtualMap, eagerExtract, lazyExtract } from "./assets.generated.js";
const Module = require("module");
const fs = require("fs");
const path = require("path");

const baseDir = path.dirname(process.execPath);
process.chdir(baseDir);
process.env.NODE_ENV = "production";

const nextConfig = ${configMatch[1]};
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOSTNAME || "0.0.0.0";
let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
if (Number.isNaN(keepAliveTimeout) || !Number.isFinite(keepAliveTimeout) || keepAliveTimeout < 0) {
  keepAliveTimeout = undefined;
}

// Resolve relative virtualMap keys to absolute logical paths (baseDir-rooted).
// Lazy-extracted files also go in moduleMap so fs hooks (createReadStream,
// stat, readdir) can serve them from /$bunfs/ before the on-disk copy lands —
// avoiding the race where the server is up but lazy extraction is still running.
const moduleMap = new Map();
for (const [rel, vfs] of virtualMap) moduleMap.set(path.join(baseDir, rel), vfs);
for (const [rel, vfs] of lazyExtract) moduleMap.set(path.join(baseDir, rel), vfs);

// Build a virtual directory tree from moduleMap keys so readdir hooks can
// answer "what's in this dir?". Each entry tracks whether it's a file or a
// subdirectory.
const virtualDirs = new Map(); // dirAbsPath -> Map<basename, "file" | "dir">
for (const filePath of moduleMap.keys()) {
  let p = filePath;
  while (true) {
    const parent = path.dirname(p);
    if (parent === p) break;
    let entries = virtualDirs.get(parent);
    if (!entries) { entries = new Map(); virtualDirs.set(parent, entries); }
    const name = path.basename(p);
    const type = p === filePath ? "file" : "dir";
    if (!entries.has(name) || (entries.get(name) === "file" && type === "dir")) {
      entries.set(name, type);
    }
    p = parent;
  }
}

// ─── Custom Node resolver against the virtual filesystem ────────────────
function tryFile(p) {
  if (moduleMap.has(p)) return p;
  for (const ext of [".js", ".cjs", ".mjs", ".json"]) {
    if (moduleMap.has(p + ext)) return p + ext;
  }
  return null;
}
function tryDir(p) {
  const pkgPath = path.join(p, "package.json");
  if (moduleMap.has(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(moduleMap.get(pkgPath), "utf8"));
      const main = pkg.main || pkg.module;
      if (main) {
        const mainAbs = path.join(p, main);
        const f = tryFile(mainAbs);
        if (f) return f;
        const d = tryDir(mainAbs);
        if (d) return d;
      }
    } catch {}
  }
  for (const ext of [".js", ".cjs", ".mjs", ".json"]) {
    const idx = path.join(p, "index" + ext);
    if (moduleMap.has(idx)) return idx;
  }
  return null;
}
function resolveAny(p) { return tryFile(p) || tryDir(p); }

// When parent.filename is missing (the very first call from createRequire,
// or any module loaded outside our chain), root the walk at <baseDir>/.next.
// Without this, the walker starts at <baseDir>, looks for <baseDir>/node_modules/<pkg>
// (not in our virtual map) and falls through to bun's fallback resolver — which on
// developer machines finds the host's REAL on-disk install at the project root,
// silently hijacking the entire require chain to non-virtual files.
const virtualRoot = path.join(baseDir, ".next");
const DEBUG = process.env.NEXT_BUN_DEBUG === "1";
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (typeof request !== "string" || request.startsWith("node:")) {
    return origResolve.call(this, request, parent, ...rest);
  }
  if (DEBUG) console.error("[resolve]", request, "from", parent && parent.filename);
  if (path.isAbsolute(request)) {
    const r = resolveAny(request);
    if (r) return r;
  } else if (request.startsWith("./") || request.startsWith("../")) {
    const fromDir = parent && parent.filename ? path.dirname(parent.filename) : virtualRoot;
    const r = resolveAny(path.resolve(fromDir, request));
    if (r) return r;
  } else {
    let dir = parent && parent.filename ? path.dirname(parent.filename) : virtualRoot;
    while (true) {
      const r = resolveAny(path.join(dir, "node_modules", request));
      if (r) return r;
      const next = path.dirname(dir);
      if (next === dir) break;
      dir = next;
    }
  }
  if (DEBUG) console.error("  -> FALLBACK", request);
  return origResolve.call(this, request, parent, ...rest);
};

// ─── Loaders ────────────────────────────────────────────────────────────
function loadVirtual(mod, filename) {
  const content = fs.readFileSync(moduleMap.get(filename), "utf8");
  if (filename.endsWith(".json") || filename.endsWith(".jsonc")) {
    mod.exports = JSON.parse(content);
  } else {
    mod._compile(content, filename);
  }
}
const origJs = Module._extensions[".js"];
Module._extensions[".js"] = function (mod, filename) {
  if (moduleMap.has(filename)) return loadVirtual(mod, filename);
  return origJs.call(this, mod, filename);
};
Module._extensions[".cjs"] = Module._extensions[".js"];
Module._extensions[".mjs"] = Module._extensions[".js"];
const origJson = Module._extensions[".json"];
Module._extensions[".json"] = function (mod, filename) {
  if (moduleMap.has(filename)) return loadVirtual(mod, filename);
  return origJson.call(this, mod, filename);
};

// ─── fs hooks ───────────────────────────────────────────────────────────
// Bun's compiled binary special-cases readFileSync/promises.readFile/statSync
// on /$bunfs/ paths but does NOT support openSync, open, or createReadStream
// — those fail with ENOENT. So we redirect read+stat APIs by substituting the
// VFS path, but for stream APIs we synthesize a Node Readable backed by
// Bun.file(vfs).stream() instead of round-tripping through fs.openSync.
function redirect(fn) {
  return function (p, ...rest) {
    if (typeof p === "string" && moduleMap.has(p)) return fn.call(fs, moduleMap.get(p), ...rest);
    return fn.call(fs, p, ...rest);
  };
}
const origReadSync = fs.readFileSync;
fs.readFileSync = redirect(origReadSync);
fs.readFile = redirect(fs.readFile);
fs.stat = redirect(fs.stat);
fs.lstat = redirect(fs.lstat);
fs.access = redirect(fs.access);
fs.statSync = redirect(fs.statSync);
fs.lstatSync = redirect(fs.lstatSync);
fs.accessSync = redirect(fs.accessSync);
fs.realpathSync = redirect(fs.realpathSync);
const origExistsSync = fs.existsSync;
fs.existsSync = function (p) {
  if (typeof p === "string" && moduleMap.has(p)) return true;
  return origExistsSync.call(fs, p);
};
if (fs.promises) {
  fs.promises.readFile = redirect(fs.promises.readFile);
  fs.promises.stat = redirect(fs.promises.stat);
  fs.promises.lstat = redirect(fs.promises.lstat);
  fs.promises.access = redirect(fs.promises.access);
}

// fs.createReadStream — used by Next.js's static handler to send /_next/static
// and public/ assets. Bun.file().stream() is the only way to read /$bunfs/
// streamingly; wrap it in a Node Readable. Also support {start,end} for HTTP
// Range requests.
const { Readable } = require("stream");
const origCreateReadStream = fs.createReadStream;
fs.createReadStream = function (p, opts) {
  if (typeof p === "string" && moduleMap.has(p)) {
    if (DEBUG) console.error("[stream]", p);
    try {
      const file = Bun.file(moduleMap.get(p));
      const start = opts && opts.start !== undefined ? opts.start : 0;
      const end = opts && opts.end !== undefined ? opts.end + 1 : file.size;
      const slice = start === 0 && end === file.size ? file : file.slice(start, end);
      return Readable.fromWeb(slice.stream());
    } catch (e) {
      if (DEBUG) console.error("[stream-error]", p, e);
      throw e;
    }
  }
  return origCreateReadStream.call(fs, p, opts);
};

// ─── readdir hooks ──────────────────────────────────────────────────────
// Next.js's recursiveReadDir uses fs.promises.readdir({withFileTypes:true})
// to enumerate static/, public/, and prerender folders at startup. Without
// these hooks, the static handler registers nothing and every /_next/static
// request 404s.
function makeDirent(name, type) {
  return {
    name,
    isFile: () => type === "file",
    isDirectory: () => type === "dir",
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}
function mergeDir(realResult, virtEntries, withFileTypes) {
  if (!virtEntries) return realResult;
  const real = Array.isArray(realResult) ? realResult : [];
  if (withFileTypes) {
    const realNames = new Set(real.map((d) => (typeof d === "string" ? d : d.name)));
    const out = [...real];
    for (const [name, type] of virtEntries) {
      if (!realNames.has(name)) out.push(makeDirent(name, type));
    }
    return out;
  } else {
    const set = new Set(real);
    for (const [name] of virtEntries) set.add(name);
    return [...set];
  }
}
const origReaddirSync = fs.readdirSync;
fs.readdirSync = function (p, opts) {
  const key = typeof p === "string" ? p : p.toString();
  const virt = virtualDirs.get(key);
  if (!virt) return origReaddirSync.call(fs, p, opts);
  let real = [];
  try { real = origReaddirSync.call(fs, p, opts); } catch {}
  const wft = !!(opts && (typeof opts === "object" ? opts.withFileTypes : false));
  return mergeDir(real, virt, wft);
};
const origReaddir = fs.readdir;
fs.readdir = function (p, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = undefined; }
  const key = typeof p === "string" ? p : p.toString();
  const virt = virtualDirs.get(key);
  if (!virt) return origReaddir.call(fs, p, opts, cb);
  origReaddir.call(fs, p, opts, (err, real) => {
    const wft = !!(opts && typeof opts === "object" && opts.withFileTypes);
    cb(null, mergeDir(err ? [] : real, virt, wft));
  });
};
if (fs.promises && fs.promises.readdir) {
  const origReaddirP = fs.promises.readdir;
  fs.promises.readdir = async function (p, opts) {
    const key = typeof p === "string" ? p : p.toString();
    const virt = virtualDirs.get(key);
    if (DEBUG) console.error("[readdir]", key, "virt?", !!virt, "n=", virt ? virt.size : 0);
    if (!virt) return origReaddirP.call(fs.promises, p, opts);
    let real = [];
    try { real = await origReaddirP.call(fs.promises, p, opts); } catch {}
    const wft = !!(opts && typeof opts === "object" && opts.withFileTypes);
    return mergeDir(real, virt, wft);
  };
}

// ─── Eager extraction (.node native modules — must be on disk for dlopen) ─
for (const [rel, vfs] of eagerExtract) {
  const dest = path.join(baseDir, rel);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(vfs));
  }
}

// Surface request-time errors that Next.js silently buries into 500s
if (process.env.NEXT_BUN_DEBUG === "1") {
  process.on("uncaughtException", (e) => console.error("[uncaught]", e && e.stack || e));
  process.on("unhandledRejection", (e) => console.error("[unhandled]", e && e.stack || e));
  // Patch console.error so even logs Next.js sends elsewhere surface
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (...a) { return origStderr(...a); };
}

// ─── Boot via Node-compat require chain ─────────────────────────────────
// boot.js lives at <baseDir>/.next/boot.js so the resolver's walk-up finds
// <baseDir>/.next/node_modules/* — which is where externals are virtualized
const customRequire = Module.createRequire(path.join(baseDir, ".next/boot.js"));

// Lazy extraction (HTTP-served files: static, public, html, rsc, meta, body).
// We kick it off in parallel with Next.js boot so the boot path isn't blocked
// on disk I/O. The marker file lets warm restarts skip extraction entirely.
function extractLazy() {
  if (lazyExtract.size === 0) return Promise.resolve();
  const markerPath = path.join(baseDir, ".next-bun-extracted");
  const binStat = fs.statSync(process.execPath);
  const marker = binStat.mtimeMs + "|" + binStat.size + "|" + lazyExtract.size;
  try { if (fs.readFileSync(markerPath, "utf8") === marker) return Promise.resolve(); } catch {}
  const dirs = new Set();
  for (const [rel] of lazyExtract) dirs.add(path.dirname(rel));
  for (const d of dirs) fs.mkdirSync(path.join(baseDir, d), { recursive: true });
  const tasks = [];
  for (const [rel, vfs] of lazyExtract) {
    tasks.push(Bun.write(path.join(baseDir, rel), Bun.file(vfs)));
  }
  return Promise.all(tasks).then(() => {
    try { fs.writeFileSync(markerPath, marker); } catch {}
  });
}

(async () => {
  // Kick off lazy extraction in parallel — Next.js's boot doesn't need these
  const lazyDone = extractLazy();
  const { startServer } = customRequire("next/dist/server/lib/start-server");
  await startServer({
    dir: baseDir,
    isDev: false,
    config: nextConfig,
    hostname: HOST,
    port: PORT,
    allowRetry: false,
    keepAliveTimeout,
  });
  // Don't await lazyDone — server is up; extraction continues in background
  lazyDone.catch((e) => console.error("[lazy-extract]", e));
})().catch((err) => { console.error(err); process.exit(1); });
`;

  writeFileSync(join(serverDir, "server-entry.js"), serverEntry);

  return serverDir;
}
