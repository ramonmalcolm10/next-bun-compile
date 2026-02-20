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

## Support

If this saved you time, consider supporting the project:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/ramonmalcolm)

## License

MIT
