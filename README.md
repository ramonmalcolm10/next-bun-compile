# next-bun-compile

A Next.js Build Adapter that compiles your app into a single-file [Bun](https://bun.sh) executable.

One command. One binary. No runtime dependencies.

```bash
next build  # → ./server (single executable with embedded assets)
```

## Requirements

- [Bun](https://bun.sh) >= 1.3
- [Next.js](https://nextjs.org) >= 16.0.0

## Installation

```bash
bun add -D next-bun-compile
```

## Setup

Add the adapter to your `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    adapterPath: require.resolve("next-bun-compile"),
  },
};

export default nextConfig;
```

Update your build script in `package.json`:

```json
{
  "scripts": {
    "build": "next build && next-bun-compile"
  }
}
```

## Usage

```bash
bun run build    # Builds Next.js + compiles to ./server
./server         # Starts on port 3000
```

The binary is fully self-contained — static assets, public files, and the Next.js server are all embedded. Just copy it anywhere and run.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `HOSTNAME` | `0.0.0.0` | Server hostname |
| `KEEP_ALIVE_TIMEOUT` | — | HTTP keep-alive timeout (ms) |

### CDN / `assetPrefix`

If you configure `assetPrefix` in your `next.config.ts`, static assets (`/_next/static/`) are served from your CDN instead of the origin server. The adapter detects this automatically and skips embedding static assets in the binary — only public files are embedded. This results in a smaller binary.

```ts
const nextConfig: NextConfig = {
  assetPrefix: "https://cdn.example.com",
  experimental: {
    adapterPath: require.resolve("next-bun-compile"),
  },
};
```

You'll need to upload `.next/static/` to your CDN separately.

## Performance

The compiled binary uses Bun's `--bytecode` flag to pre-compile JavaScript to bytecode at build time, skipping the parsing step at startup. Code is also minified and dead code paths (dev-only modules, non-turbo runtimes) are eliminated via `--define` flags.

Benchmarks on a real Next.js app (both running on Bun's runtime):

| | Standalone | Compiled Binary |
|---|---|---|
| **Startup** | 84ms | **45ms (1.9x faster)** |
| **Memory (RSS)** | 60 MB | 72 MB |
| **Size** | 91 MB (directory) | 99 MB (single file) |

Startup improvements scale with codebase size — larger applications benefit more since there's more code to parse.

## How It Works

1. **Adapter hook** — `modifyConfig()` sets `output: "standalone"` automatically so you don't need to configure it
2. **Asset discovery** — Scans `.next/static/` and `public/` for all static files
3. **Code generation** — Creates a `server-entry.js` that:
   - Embeds all assets into the binary via Bun's `import ... with { type: "file" }`
   - Extracts them to disk on first run
   - Fixes `__dirname` for compiled binary context
   - Starts the Next.js server
4. **Compilation** — Runs `bun build --compile` with `--define` flags to eliminate dead code branches (dev-only modules, non-turbo runtimes)

### Module Stubs

Some modules can't be resolved at compile time but are never reached in production (dev servers, optional dependencies). The adapter creates no-op stubs for these **only if** the real module isn't installed. If you actually use `@opentelemetry/api` or `critters`, the real package gets bundled instead.

## Troubleshooting

### Packages with dynamic `require()` calls (e.g. pino)

Some packages like `pino` use dynamic `require()` calls internally (for worker threads, transports, etc.). Turbopack can't resolve these at build time, so they fail at runtime inside the compiled binary with errors like:

```
Failed to load external module pino-142500b1eb3f4baf: Cannot find package ...
```

**Fix:** Add the package to `transpilePackages` in your `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  transpilePackages: ["pino", "pino-pretty"],
  experimental: {
    adapterPath: require.resolve("next-bun-compile"),
  },
};
```

This forces Turbopack to fully compile the package source rather than deferring dynamic requires to runtime.

## Support

If this saved you time, consider supporting the project:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/ramonmalcolm)

## License

MIT
