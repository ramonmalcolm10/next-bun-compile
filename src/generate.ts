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
 *
 * Walks the entire standalone tree to find every `node_modules/` directory,
 * then checks for direct + hoisted-store locations in each. Necessary for
 * monorepo-style standalone outputs where Next.js produces both a top-level
 * `standalone/node_modules/` AND nested copies like
 * `standalone/<app-path>/node_modules/` — the bundler resolves the nearest
 * one, so stubs/shims have to be placed in every location.
 */
function findPackageDirs(standaloneDir: string, pkg: string): string[] {
  const dirs: string[] = [];
  const prefix = pkg.startsWith("@")
    ? pkg.split("/")[0] + "+" + pkg.split("/")[1]
    : pkg;
  const seen = new Set<string>();

  const checkNodeModules = (nodeModulesDir: string) => {
    // Direct: node_modules/<pkg>/
    const direct = join(nodeModulesDir, pkg);
    if (existsSync(direct) && !seen.has(direct)) {
      seen.add(direct);
      dirs.push(direct);
    }
    // Hoisted stores: .bun/<pkg>@<ver>/node_modules/<pkg>/ etc.
    for (const store of [".bun", ".pnpm"]) {
      const storeDir = join(nodeModulesDir, store);
      if (!existsSync(storeDir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(storeDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith(prefix + "@")) continue;
        const hoisted = join(storeDir, entry, "node_modules", pkg);
        if (existsSync(hoisted) && !seen.has(hoisted)) {
          seen.add(hoisted);
          dirs.push(hoisted);
        }
      }
    }
  };

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === "node_modules") {
        checkNodeModules(full);
        continue; // don't descend into node_modules itself
      }
      const stat = tryStat(full);
      if (stat && stat.isDirectory()) walk(full);
    }
  };
  walk(standaloneDir);
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
    const pkgDirs = findPackageDirs(standaloneDir, stub.pkg);
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
 * the emitted chunks, and Next.js writes a `.next/node_modules/<mangled>`
 * symlink so `next start` resolves them. The compiled bun binary's
 * resolver, however, won't resolve those mangled names from any kind of
 * shim placed in `.next/node_modules/`: relative paths, absolute paths,
 * directory paths, and package-name lookups have all failed in different
 * ways in the compiled-binary code path.
 *
 * Solution: rewrite the chunks themselves before embedding. Every literal
 * occurrence of `"<mangled>"` and `"<mangled>/<sub>"` in the chunk text
 * is replaced with `"<canonical>"` / `"<canonical>/<sub>"`. The chunks
 * then call `require("sharp")` / `import("prettier/plugins/html")`
 * directly, which bun resolves through its normal node_modules walk from
 * the chunk's on-disk location — the same path that successfully found
 * the alias shim in earlier iterations.
 *
 * Discovery: scan chunks for `"<name>-<16 hex>[/<subpath>]"` string
 * literals. The 16-hex content hash is selective enough that false
 * positives in JS chunks are vanishingly unlikely. Build-time symlinks
 * in `.next/node_modules/` are consulted as a secondary source for
 * aliases that don't show up in any string literal.
 */
function findTurbopackAliases(
  standaloneNextDir: string
): Array<{ alias: string; target: string; subpaths: string[] }> {
  const seen = new Map<
    string,
    { target: string; subpaths: Set<string> }
  >();
  const ensure = (alias: string) => {
    let e = seen.get(alias);
    if (!e) {
      e = { target: alias.replace(/-[0-9a-f]{16}$/, ""), subpaths: new Set() };
      seen.set(alias, e);
    }
    return e;
  };

  const serverDir = join(standaloneNextDir, "server");
  if (existsSync(serverDir)) {
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
 * For each alias spec (top-level or subpath), find the concrete file the
 * canonical package would resolve to — by reading `package.json` and
 * looking for the file with the right extension. Returns a map of
 *   "<alias>"          → ".next/node_modules/<target>/<resolvedMain>"
 *   "<alias>/<sub>"    → ".next/node_modules/<target>/<resolvedSub>"
 */
function buildCanonicalResolutions(
  externalRoot: string,
  aliases: Array<{ alias: string; target: string; subpaths: string[] }>
): Map<string, string> {
  const out = new Map<string, string>();
  const findFile = (dir: string, candidates: string[]): string | null => {
    for (const c of candidates) {
      if (!c) continue;
      const p = join(dir, c);
      if (existsSync(p) && statSync(p).isFile()) return c.replace(/\\/g, "/");
    }
    return null;
  };
  const resolveMain = (canonicalDir: string): string | null => {
    const pkgPath = join(canonicalDir, "package.json");
    let main = "index.js";
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (typeof pkg.main === "string") main = pkg.main;
      } catch {}
    }
    return findFile(canonicalDir, [
      main, main + ".js", main + ".cjs", main + ".mjs",
      join(main, "index.js"), join(main, "index.cjs"), join(main, "index.mjs"),
      "index.js", "index.cjs", "index.mjs",
    ]);
  };
  const resolveSub = (canonicalDir: string, sub: string): string | null => {
    const stripped = sub.replace(/\.(?:js|cjs|mjs|json)$/, "");
    // Try direct file forms first; for ESM contexts (.y/import calls) the
    // `.mjs` variant of subpath exports is what's actually on disk for many
    // packages (prettier/plugins/html.mjs vs html.js).
    return findFile(canonicalDir, [
      sub,
      stripped + ".mjs",
      stripped + ".js",
      stripped + ".cjs",
      stripped + ".json",
      join(stripped, "index.mjs"),
      join(stripped, "index.js"),
      join(stripped, "index.cjs"),
    ]);
  };
  for (const { alias, target, subpaths } of aliases) {
    const canonicalDir = join(externalRoot, target);
    if (!existsSync(canonicalDir)) continue;
    const main = resolveMain(canonicalDir);
    if (main) out.set(alias, `.next/node_modules/${target}/${main}`);
    for (const sub of subpaths) {
      const file = resolveSub(canonicalDir, sub);
      if (file) out.set(`${alias}/${sub}`, `.next/node_modules/${target}/${file}`);
    }
  }
  return out;
}

/**
 * Replace every literal `"<alias>"` or `"<alias>/<sub>"` in the server
 * chunks with the absolute file path of the canonical target, anchored on
 * a `__NBC_BASE__` placeholder that's substituted with the real baseDir
 * at runtime extraction time.
 *
 * Both CJS `require(...)` and ESM `await import(...)` go through this
 * rewrite. The Module._resolveFilename hook installed in server-entry
 * only catches CJS — ESM `import()` bypasses Module hooks entirely, and
 * bun's ESM resolver in the compiled binary has the same node_modules-
 * walk quirk as its CJS resolver in some Linux configurations. Embedding
 * a literal absolute file path skips resolution entirely; bun stats and
 * loads the file directly.
 */
function rewriteTurbopackAliases(
  standaloneNextDir: string,
  aliases: Array<{ alias: string }>,
  resolutions: Map<string, string>
): void {
  if (aliases.length === 0 || resolutions.size === 0) return;
  const serverDir = join(standaloneNextDir, "server");
  if (!existsSync(serverDir)) return;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Capture the whole quoted spec — alias or alias/sub/path — so we can
  // look it up in the resolutions map and swap the literal in one shot.
  const pattern = new RegExp(
    "([\"'])((?:" +
      aliases.map((a) => escape(a.alias)).join("|") +
      ")(?:/[^\"']+)?)\\1",
    "g"
  );
  let rewritten = 0;
  for (const f of walkDir(serverDir)) {
    if (!f.absolutePath.endsWith(".js")) continue;
    let content: string;
    try {
      content = readFileSync(f.absolutePath, "utf-8");
    } catch {
      continue;
    }
    const next = content.replace(pattern, (match, quote, spec) => {
      const rel = resolutions.get(spec);
      if (!rel) return match;
      return `${quote}__NBC_BASE__/${rel}${quote}`;
    });
    if (next !== content) {
      writeFileSync(f.absolutePath, next);
      rewritten++;
    }
  }
  if (rewritten > 0) {
    console.log(
      `next-bun-compile: Rewrote turbopack-mangled aliases in ${rewritten} server chunks`
    );
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
  const nextDirs = findPackageDirs(standaloneDir, "next");

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
  // Collect all package directories, including those in .bun/.pnpm stores
  // and nested node_modules anywhere in the standalone tree (monorepo
  // layouts produce both `standalone/node_modules/` and
  // `standalone/<app>/node_modules/`; only collecting the top-level one
  // misses packages that are nested-only, like next.js's own runtime files
  // when `file:` deps push the dep tree into a nested copy).
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

  // Walk the entire standalone tree and process every `node_modules/` we
  // find (top-level, nested app dirs, etc.). Doesn't recurse into
  // node_modules itself — the .bun/.pnpm hoisted stores are handled
  // explicitly per node_modules.
  function walkForNodeModules(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === "node_modules") {
        scanDir(full);
        for (const store of [".bun", ".pnpm"]) {
          const storeDir = join(full, store);
          if (!existsSync(storeDir)) continue;
          for (const storeEntry of readdirSync(storeDir)) {
            const nested = join(storeDir, storeEntry, "node_modules");
            if (existsSync(nested)) scanDir(nested);
          }
        }
        continue;
      }
      const stat = tryStat(full);
      if (stat && stat.isDirectory()) walkForNodeModules(full);
    }
  }
  walkForNodeModules(standaloneDir);
  if (pkgRoots.size === 0) return [];

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
  // 1. Create index.js shims for next/dist/compiled/* packages whose
  //    package.json "main" isn't index.js (e.g. source-map -> source-map.js)
  for (const pkgDir of findPackageDirs(standaloneDir, "next")) {
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
  for (const helpersDir of findPackageDirs(standaloneDir, "@swc/helpers")) {
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

  // Discover turbopack mangled aliases (e.g. `sharp-457ea9eae1af1a9c`). The
  // actual rewrite happens further down, after collectExternalModules has
  // populated the __external/ tree — we need to read each canonical's
  // package.json + file layout to find the exact main/subpath file to
  // point at.
  const standaloneNextDir = join(serverDir, ".next");
  const turbopackAliases = findTurbopackAliases(standaloneNextDir);
  const aliasNames = new Set(turbopackAliases.map((a) => a.alias));
  const runtimeFiles = walkDir(standaloneNextDir)
    .filter((f) => {
      // Skip files reached through alias symlinks — the canonical files
      // are extracted by collectExternalModules and the hook redirects
      // alias-name requires at runtime, so the alias directory is dead
      // weight if we let it get walked.
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

  // Resolve each alias spec to its actual canonical file path (main from
  // package.json for top-level, the right extension for each subpath),
  // then rewrite chunk references to absolute file paths via the
  // __NBC_BASE__ placeholder. Substituted with baseDir at extract time.
  const canonicalResolutions = buildCanonicalResolutions(
    externalDir,
    turbopackAliases
  );
  rewriteTurbopackAliases(standaloneNextDir, turbopackAliases, canonicalResolutions);

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
const Module = require("module");

const baseDir = path.dirname(process.execPath);
process.chdir(baseDir);
process.env.NODE_ENV = "production";

// Install a fallback Module._resolveFilename hook. bun's compiled-binary
// resolver doesn't walk node_modules from inside a node_modules entry, so
// once execution enters an extracted package (sharp/lib/index.js → require
// of detect-libc, @img/sharp-linux-x64/sharp.node, etc.) bun gives up. The
// hook also redirects turbopack-mangled aliases ("sharp-457ea9eae1af1a9c"
// → "sharp") so the chunks' externalized require/import calls land on the
// canonical packages that collectExternalModules extracted.
//
// Runs ONLY when bun's resolver throws and reimplements Node-compatible
// resolution from scratch — walk node_modules, read package.json main,
// honor exports maps. Generic: every externalized package's internal deps
// get resolved without per-package patching.
const __nbcAliases = ${JSON.stringify(
    Object.fromEntries(turbopackAliases.map((a) => [a.alias, a.target]))
  )};
const __nbcOrigResolveFilename = Module._resolveFilename;
function __nbcStatFile(p) {
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}
function __nbcResolveMain(pkgDir, pkgJson) {
  const main = pkgJson && typeof pkgJson.main === "string" ? pkgJson.main : "index.js";
  return __nbcStatFile(path.join(pkgDir, main))
    || __nbcStatFile(path.join(pkgDir, main + ".js"))
    || __nbcStatFile(path.join(pkgDir, main + ".cjs"))
    || __nbcStatFile(path.join(pkgDir, main + ".mjs"))
    || __nbcStatFile(path.join(pkgDir, main, "index.js"))
    || __nbcStatFile(path.join(pkgDir, "index.js"))
    || __nbcStatFile(path.join(pkgDir, "index.cjs"));
}
function __nbcResolveSubpath(pkgDir, pkgJson, sub) {
  // Honor exports map (CJS-relevant conditions only)
  if (pkgJson && pkgJson.exports && typeof pkgJson.exports === "object") {
    const key = "./" + sub;
    const entry = pkgJson.exports[key];
    if (entry) {
      let target = typeof entry === "string"
        ? entry
        : entry.require || entry.node || entry.default;
      if (typeof target === "string" && target.startsWith("./")) {
        const f = __nbcStatFile(path.join(pkgDir, target.slice(2)));
        if (f) return f;
      }
    }
  }
  // Direct file forms
  const direct = __nbcStatFile(path.join(pkgDir, sub))
    || __nbcStatFile(path.join(pkgDir, sub + ".js"))
    || __nbcStatFile(path.join(pkgDir, sub + ".cjs"))
    || __nbcStatFile(path.join(pkgDir, sub + ".mjs"))
    || __nbcStatFile(path.join(pkgDir, sub + ".json"));
  if (direct) return direct;
  // Subpath is a directory: read its own package.json + main (e.g.
  // next/dist/compiled/source-map has main: "source-map.js"). Falls
  // back to index.js / index.cjs lookup if no package.json.
  const subDir = path.join(pkgDir, sub);
  try {
    if (fs.statSync(subDir).isDirectory()) {
      const subPkgPath = path.join(subDir, "package.json");
      if (fs.existsSync(subPkgPath)) {
        try {
          const subPkg = JSON.parse(fs.readFileSync(subPkgPath, "utf-8"));
          const main = typeof subPkg.main === "string" ? subPkg.main : null;
          if (main) {
            const f = __nbcStatFile(path.join(subDir, main))
              || __nbcStatFile(path.join(subDir, main + ".js"));
            if (f) return f;
          }
        } catch {}
      }
    }
  } catch {}
  return __nbcStatFile(path.join(pkgDir, sub, "index.js"))
    || __nbcStatFile(path.join(pkgDir, sub, "index.cjs"));
}
function __nbcResolvePackage(request, fromDir) {
  let pkgName, sub = "";
  if (request[0] === "@") {
    const m = request.match(/^(@[^/]+\\/[^/]+)(?:\\/(.+))?$/);
    if (!m) return null;
    pkgName = m[1]; sub = m[2] || "";
  } else {
    const idx = request.indexOf("/");
    if (idx === -1) { pkgName = request; }
    else { pkgName = request.slice(0, idx); sub = request.slice(idx + 1); }
  }
  let dir = fromDir;
  while (dir.length > 1) {
    const pkgDir = path.join(dir, "node_modules", pkgName);
    if (fs.existsSync(pkgDir)) {
      let pkgJson = null;
      const pkgJsonPath = path.join(pkgDir, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        try { pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")); } catch {}
      }
      const resolved = sub
        ? __nbcResolveSubpath(pkgDir, pkgJson, sub)
        : __nbcResolveMain(pkgDir, pkgJson);
      if (resolved) return resolved;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function __nbcRedirectAlias(request) {
  if (typeof request !== "string" || request.length === 0) return request;
  // Direct alias match
  if (Object.prototype.hasOwnProperty.call(__nbcAliases, request)) {
    return __nbcAliases[request];
  }
  // Alias-with-subpath match
  const slash = request.indexOf("/", request[0] === "@" ? request.indexOf("/") + 1 : 0);
  if (slash === -1) return request;
  const head = request.slice(0, slash);
  if (Object.prototype.hasOwnProperty.call(__nbcAliases, head)) {
    return __nbcAliases[head] + request.slice(slash);
  }
  return request;
}
Module._resolveFilename = function(request, parent, isMain, options) {
  const redirected = __nbcRedirectAlias(request);
  try {
    return __nbcOrigResolveFilename.call(this, redirected, parent, isMain, options);
  } catch (err) {
    // Only attempt fallback for bare package specifiers
    if (typeof redirected !== "string" || redirected[0] === "." || redirected[0] === "/" || /^[a-z]+:/.test(redirected)) {
      throw err;
    }
    const fromDir = parent && parent.filename ? path.dirname(parent.filename) : process.cwd();
    const resolved = __nbcResolvePackage(redirected, fromDir);
    if (resolved) return resolved;
    throw err;
  }
};

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
    if (!embedded) continue;
    // Server chunks may contain __NBC_BASE__ placeholders injected at
    // build time by rewriteTurbopackAliases. Substitute the real baseDir
    // before writing so bun resolves the absolute paths at chunk load
    // (works for both CJS require and ESM import).
    if (diskPath.startsWith(".next/server/")) {
      const text = await Bun.file(embedded).text();
      if (text.indexOf("__NBC_BASE__") !== -1) {
        await Bun.write(fullPath, text.split("__NBC_BASE__").join(baseDir));
        n++;
        continue;
      }
    }
    await Bun.write(fullPath, Bun.file(embedded));
    n++;
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
