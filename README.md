# next-bun-compile

Compile your Next.js app into a single-file [Bun](https://bun.sh) executable.

One command. One binary. No runtime dependencies.

```bash
next build  # → ./server (single executable with embedded assets)
```

**📖 Docs: [ramonmalcolm10.github.io/next-bun-compile](https://ramonmalcolm10.github.io/next-bun-compile/)**

## Requirements

- [Bun](https://bun.sh) >= 1.3
- [Next.js](https://nextjs.org) >= 16.0.0

## Installation

```bash
bun add -D next-bun-compile
```

## Setup

next-bun-compile is a [Next.js Build Adapter](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath). Point `adapterPath` at it in `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  adapterPath: "next-bun-compile",
};

export default nextConfig;
```

Or enable it without touching the config at all:

```bash
NEXT_ADAPTER_PATH=next-bun-compile next build
```

No `output: "standalone"` needed — the adapter assembles its own traced
output tree.

> **Monorepos:** Next resolves `adapterPath` from its own package location.
> If `next-bun-compile` is a nested workspace dependency, resolve it from
> the app dir instead:
>
> ```ts
> import { createRequire } from "node:module";
> const req = createRequire(process.cwd() + "/");
> const nextConfig: NextConfig = {
>   adapterPath: req.resolve("next-bun-compile"),
> };
> ```

## Usage

```bash
next build    # Builds Next.js + compiles to ./server, one command
./server      # Starts on port 3000
```

The binary is fully self-contained — static assets, public files, prerendered pages, and the Next.js server are all embedded. Just copy it anywhere and run. Static assets and fully-static prerendered pages are served straight from memory; ISR and cache-component responses get an in-memory cache that Next's own revalidation invalidates.

### Cross-Compilation

Set `NBC_TARGET` to cross-compile for a different platform:

```bash
NBC_TARGET=bun-linux-x64 next build
NBC_TARGET=bun-linux-arm64 next build
NBC_TARGET=bun-windows-x64 next build
```

See the [Bun cross-compilation docs](https://bun.sh/docs/bundler/executables#cross-compile) for all available targets.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `HOSTNAME` | `0.0.0.0` | Server hostname |
| `KEEP_ALIVE_TIMEOUT` | — | HTTP keep-alive timeout (ms) |
| `NBC_RUNTIME_DIR` | binary's directory | Where runtime files extract and `.next/cache` lives. Point at tmpfs (e.g. `/tmp/app`) for RAM-backed runtime files and read-only root filesystems |
| `NBC_TARGET` | host platform | Cross-compile target (build time) |

### CDN / `assetPrefix`

If you configure `assetPrefix` in your `next.config.ts`, static assets (`/_next/static/`) are served from your CDN instead of the origin server. `next-bun-compile` detects this from the build output and skips embedding static assets in the binary — only public files are embedded. This results in a smaller binary.

```ts
const nextConfig: NextConfig = {
  adapterPath: "next-bun-compile",
  assetPrefix: "https://cdn.example.com",
};
```

You'll need to upload `.next/static/` to your CDN separately.

## Performance

The compiled binary is minified, and dead code paths (dev-only modules, non-turbo runtimes) are eliminated via `--define` flags. Startup skips module resolution for the bundled server core entirely — the code is already in the binary.

Benchmarks on a real Next.js app (both running on Bun's runtime):

| | Standalone | Compiled Binary |
|---|---|---|
| **Startup** | 84ms | **45ms (1.9x faster)** |
| **Memory (RSS)** | 60 MB | 72 MB |
| **Size** | 91 MB (directory) | 99 MB (single file) |

Startup improvements scale with codebase size — larger applications benefit more since there's more code to parse.

## How It Works

1. **Asset discovery** — Scans `.next/static/` and `public/` for all static files
2. **Code generation** — Creates a `server-entry.js` that:
   - Embeds all assets into the binary via Bun's `import ... with { type: "file" }`
   - Extracts them to disk on first run
   - Fixes `__dirname` for compiled binary context
   - Starts the Next.js server
3. **Compilation** — Runs `bun build --compile` with `--define` flags to eliminate dead code branches (dev-only modules, non-turbo runtimes)

### Module Stubs

Some modules can't be resolved at compile time but are never reached in production (dev servers, optional dependencies). `next-bun-compile` creates no-op stubs for these **only if** the real module isn't installed. If you actually use `@opentelemetry/api` or `critters`, the real package gets bundled instead.

## Troubleshooting

### Packages with dynamic `require()` calls (e.g. pino)

Some packages like `pino` use dynamic `require()` calls internally (for worker threads, transports, etc.). Turbopack can't resolve these at build time, so they fail at runtime inside the compiled binary with errors like:

```
Failed to load external module pino-142500b1eb3f4baf: Cannot find package ...
```

**Fix:** Add the package to `transpilePackages` in your `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  adapterPath: "next-bun-compile",
  transpilePackages: ["pino", "pino-pretty"],
};
```

This forces Turbopack to fully compile the package source rather than deferring dynamic requires to runtime.

## Support

If this saved you time, consider supporting the project:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/ramonmalcolm)

## License

MIT
