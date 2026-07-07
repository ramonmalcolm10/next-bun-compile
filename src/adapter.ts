import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runBuild } from "./build.js";

/**
 * Next.js Build Adapter entry point (`adapterPath` in next.config, or the
 * `NEXT_ADAPTER_PATH` env var — no config change needed):
 *
 *   NEXT_ADAPTER_PATH=next-bun-compile next build
 *
 * `onBuildComplete` does everything in one `next build`:
 *  1. persists the typed build outputs Next hands us (prerender
 *     eligibility, middleware matchers, routing rules, cache handler
 *     config) to `.next/nbc-adapter-outputs.json` — the generator prefers
 *     this over parsing manifests;
 *  2. assembles a standalone-equivalent tree from the traced outputs —
 *     `output: "standalone"` is NOT used and not required;
 *  3. runs the full compile. NBC_TARGET=bun-linux-x64 cross-compiles.
 *
 * Shapes are structural-typed locally rather than imported from
 * next/dist/build/adapter so a rename there surfaces as a soft-degrade
 * (fields read as undefined → manifest fallback), not a crash.
 */

export const ADAPTER_OUTPUTS_FILE = "nbc-adapter-outputs.json";

type AdapterRoute = {
  source?: string;
  sourceRegex?: string;
  headers?: Record<string, string>;
  destination?: string;
  status?: number;
  priority?: boolean;
  has?: unknown[];
};

type AdapterStaticFile = {
  pathname?: string;
  filePath?: string;
};

type AdapterPrerender = {
  pathname?: string;
  parentOutputId?: string;
  fallback?: {
    filePath?: string;
    initialStatus?: number;
    initialHeaders?: Record<string, string | string[]>;
    initialRevalidate?: number | false;
    postponedState?: string;
  };
};

export type AdapterSnapshot = {
  version: 1;
  buildId: string;
  nextVersion: string;
  basePath: string;
  i18n: boolean;
  hasCustomCacheHandler: boolean;
  middlewareMatchers: string[];
  /** sourceRegex of every routing rule that can alter a response
   *  (redirect, rewrite, header injection) — paths they match must
   *  keep flowing through Next. */
  routingRules: string[];
  prerenders: Array<{
    pathname: string;
    /** file path relative to distDir */
    file: string | null;
    status: number;
    revalidate: number | false;
    postponed: boolean;
    headers: Record<string, string>;
  }>;
  /** Fully static route bodies Next reports as STATIC_FILE outputs rather
   *  than prerenders — app-router static metadata (favicon.ico, icon.svg,
   *  opengraph-image.png) and auto-static pages-router HTML. `/_next/static`
   *  entries are excluded (the generator embeds those from disk directly). */
  staticFiles: Array<{
    pathname: string;
    /** file path relative to distDir */
    file: string;
  }>;
};

function flattenHeaders(
  headers: Record<string, string | string[]> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

type TracedOutput = {
  filePath?: string;
  assets?: Record<string, string>;
};

/**
 * Assemble a standalone-equivalent tree at .next/nbc-standalone from the
 * adapter's traced outputs — the adapter contract replaces `output:
 * "standalone"` (they're on the way to being mutually exclusive), so the
 * compile pipeline gets its input without Next ever writing standalone:
 *
 *   1. every route's traced assets (repo-root-relative keys)
 *   2. the server runtime's own NFT trace (.next/next-server.js.nft.json —
 *      the same source `output: "standalone"` copies node_modules from)
 *   3. prerender seed files (html/rsc/meta) — cache seeds, not traced deps
 */
async function assembleStandalone(ctx: {
  repoRoot: string;
  projectDir: string;
  distDir: string;
  outputs?: Record<string, unknown>;
}): Promise<{ standaloneDir: string; serverDir: string }> {
  const staging = join(ctx.distDir, "nbc-standalone");
  rmSync(staging, { recursive: true, force: true });
  const copied = new Set<string>();
  let escaped = 0;
  const copyTo = (destRel: string, src: string) => {
    if (destRel.startsWith("..")) {
      escaped++;
      return;
    }
    if (copied.has(destRel)) return;
    // Traced maps can contain directory symlinks (hoisted-store links) —
    // only real files are copied; store contents are traced individually.
    try {
      if (!statSync(src).isFile()) return;
    } catch {
      return;
    }
    copied.add(destRel);
    const dest = join(staging, destRel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  };

  const outputs = (ctx.outputs ?? {}) as {
    pages?: TracedOutput[];
    pagesApi?: TracedOutput[];
    appPages?: TracedOutput[];
    appRoutes?: TracedOutput[];
    middleware?: TracedOutput;
    prerenders?: Array<{ fallback?: { filePath?: string } }>;
    staticFiles?: AdapterStaticFile[];
  };
  const routeOutputs: TracedOutput[] = [
    ...(outputs.pages ?? []),
    ...(outputs.pagesApi ?? []),
    ...(outputs.appPages ?? []),
    ...(outputs.appRoutes ?? []),
    ...(outputs.middleware ? [outputs.middleware] : []),
  ];
  for (const o of routeOutputs) {
    if (o.filePath) copyTo(relative(ctx.repoRoot, o.filePath), o.filePath);
    for (const [key, src] of Object.entries(o.assets ?? {})) copyTo(key, src);
  }

  for (const nft of ["next-server.js.nft.json", "next-minimal-server.js.nft.json"]) {
    const nftPath = join(ctx.distDir, nft);
    if (!existsSync(nftPath)) continue;
    try {
      const { files } = JSON.parse(readFileSync(nftPath, "utf-8")) as {
        files: string[];
      };
      for (const f of files) {
        const src = resolve(ctx.distDir, f);
        copyTo(relative(ctx.repoRoot, src), src);
      }
    } catch {
      // fall through — missing runtime files surface at compile time
    }
  }

  // Deliberately NOT copied: the server orchestration graph the runtime
  // boots (router-server → next-server chain). Those modules are statically
  // bundled into the binary at compile time, resolved from the project's
  // real node_modules — guaranteed present because the adapter runs inside
  // `next build`. Runtime computed-requires never touch them, and copying
  // them as well roughly doubled both extraction size and runtime memory
  // (every orchestration module loaded twice).

  const copySeed = (file: string) => {
    copyTo(relative(ctx.repoRoot, file), file);
    // Seed bodies carry response metadata (status/headers/cache tags) in a
    // sibling .meta — Next's FS cache needs both to serve without a render.
    const suffix = [".html", ".body"].find((s) => file.endsWith(s));
    if (suffix) {
      const meta = file.slice(0, -suffix.length) + ".meta";
      copyTo(relative(ctx.repoRoot, meta), meta);
    }
  };

  for (const p of outputs.prerenders ?? []) {
    if (p.fallback?.filePath) copySeed(p.fallback.filePath);
  }

  // Static-file outputs (app-router static metadata like favicon.ico /
  // icon.svg, auto-static pages HTML) are neither prerenders nor traced
  // route outputs — without their seeds AND route modules the fallback
  // render throws MODULE_NOT_FOUND. `/_next/static` entries are skipped:
  // the generator embeds those from distDir directly.
  for (const f of outputs.staticFiles ?? []) {
    if (!f.filePath || f.pathname?.startsWith("/_next/")) continue;
    copySeed(f.filePath);
    if (f.filePath.endsWith(".body")) {
      const routeJs = join(f.filePath.slice(0, -".body".length), "route.js");
      if (existsSync(routeJs)) {
        copyTo(relative(ctx.repoRoot, routeJs), routeJs);
        try {
          const { files } = JSON.parse(
            readFileSync(routeJs + ".nft.json", "utf-8")
          ) as { files: string[] };
          for (const dep of files) {
            const src = resolve(dirname(routeJs), dep);
            copyTo(relative(ctx.repoRoot, src), src);
          }
        } catch {
          // no trace — the module's deps are covered by the server trace
        }
      }
    }
  }

  // Manifests the runtime reads that aren't per-route traced assets.
  for (const extra of ["BUILD_ID", "required-server-files.json"]) {
    const src = join(ctx.distDir, extra);
    copyTo(relative(ctx.repoRoot, src), src);
  }

  const appStaging = join(staging, relative(ctx.repoRoot, ctx.projectDir));
  mkdirSync(appStaging, { recursive: true });

  if (escaped > 0) {
    console.warn(
      `next-bun-compile: ${escaped} traced file(s) outside the repo root were skipped`
    );
  }
  console.log(
    `next-bun-compile: assembled ${copied.size} traced files (no standalone output needed)`
  );
  return { standaloneDir: staging, serverDir: appStaging };
}

const adapter = {
  name: "next-bun-compile",

  async onBuildComplete(ctx: {
    projectDir: string;
    repoRoot: string;
    distDir: string;
    buildId: string;
    nextVersion: string;
    config: { cacheHandler?: string; basePath?: string; i18n?: unknown };
    routing?: Record<string, unknown>;
    outputs?: {
      middleware?: {
        config?: { matchers?: Array<{ sourceRegex?: string }> };
      };
      prerenders?: AdapterPrerender[];
      staticFiles?: AdapterStaticFile[];
    };
  }) {
    const routingRules: string[] = [];
    for (const key of [
      "beforeMiddleware",
      "beforeFiles",
      "afterFiles",
      "onMatch",
      "fallback",
    ]) {
      const list = ctx.routing?.[key];
      if (!Array.isArray(list)) continue;
      for (const route of list as AdapterRoute[]) {
        // Only user-authored rules that change responses force a path back
        // to Next. Internal built-ins are either flagged `priority` (the
        // trailing-slash redirect), synthesized without a `source` (the
        // /_next/static cache-control rule), or the deploymentId skew
        // headers (a catch-all `/:path*` that would otherwise disable the
        // tiers entirely) — behaviors the memory tiers already replicate.
        const headerKeys = Object.keys(route.headers ?? {});
        const isDeploymentIdRule =
          headerKeys.length === 1 &&
          headerKeys[0] === "x-nextjs-deployment-id";
        if (
          route.sourceRegex &&
          typeof route.source === "string" &&
          !route.priority &&
          !isDeploymentIdRule &&
          (headerKeys.length > 0 || route.destination || route.status)
        ) {
          routingRules.push(route.sourceRegex);
        }
      }
    }

    const prerenders = (ctx.outputs?.prerenders ?? []).flatMap((p) => {
      if (!p.pathname) return [];
      return [
        {
          pathname: p.pathname,
          file: p.fallback?.filePath
            ? relative(ctx.distDir, p.fallback.filePath)
            : null,
          status: p.fallback?.initialStatus ?? 200,
          revalidate: p.fallback?.initialRevalidate ?? false,
          postponed: !!p.fallback?.postponedState,
          headers: flattenHeaders(p.fallback?.initialHeaders),
        },
      ];
    });

    const staticFiles = (ctx.outputs?.staticFiles ?? []).flatMap((f) => {
      if (!f.pathname || !f.filePath) return [];
      if (f.pathname.startsWith("/_next/")) return [];
      return [
        {
          pathname: f.pathname,
          file: relative(ctx.distDir, f.filePath),
        },
      ];
    });

    const snapshot: AdapterSnapshot = {
      version: 1,
      buildId: ctx.buildId,
      nextVersion: ctx.nextVersion,
      basePath: ctx.config.basePath ?? "",
      i18n: !!ctx.config.i18n,
      hasCustomCacheHandler: !!ctx.config.cacheHandler,
      middlewareMatchers: (ctx.outputs?.middleware?.config?.matchers ?? [])
        .map((m) => m.sourceRegex)
        .filter((r): r is string => !!r),
      routingRules,
      prerenders,
      staticFiles,
    };

    writeFileSync(
      join(ctx.distDir, ADAPTER_OUTPUTS_FILE),
      JSON.stringify(snapshot, null, 2)
    );
    console.log(
      `next-bun-compile: adapter outputs written (${prerenders.length} prerender entries)`
    );

    const { standaloneDir, serverDir } = await assembleStandalone(ctx);
    await runBuild({ projectDir: ctx.projectDir, standaloneDir, serverDir });
  },
};

export default adapter;
