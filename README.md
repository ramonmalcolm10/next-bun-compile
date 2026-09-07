# next-bun-compile

Compile your Next.js app into a single-file [Bun](https://bun.sh) executable.

One command. One binary. No runtime dependencies.

```bash
next build  # → ./dist/app (single executable with embedded assets)
```

**📖 Docs: [ramonmalcolm10.github.io/next-bun-compile](https://ramonmalcolm10.github.io/next-bun-compile/)**

## Requirements

- [Bun](https://bun.sh) >= 1.3
- [Next.js](https://nextjs.org) >= 16.2.0

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

> **Monorepos:** Next resolves `adapterPath` from its own package location,
> so a nested workspace dependency needs resolving from the app dir instead.
> See the [monorepo guide](https://ramonmalcolm10.github.io/next-bun-compile/guides/monorepo/).

## Performance

The compiled binary is minified, and dead code paths (dev-only modules,
non-turbo runtimes) are eliminated via `--define` flags. Startup skips module
resolution for the bundled server core entirely — the code is already in the
binary, and `--extract` can pre-materialise the runtime tree at image build so
boot skips extraction too.

## Documentation

Everything else lives on the docs site, kept in sync with the code:

| | |
| --- | --- |
| [Getting started](https://ramonmalcolm10.github.io/next-bun-compile/getting-started/) | Install, configure, build, run. |
| [Configuration](https://ramonmalcolm10.github.io/next-bun-compile/configuration/) | Every environment variable and Next config option, including where the binary is written. |
| [How it works](https://ramonmalcolm10.github.io/next-bun-compile/how-it-works/) | Asset embedding, the extracted runtime tree, module stubs, the resolver hook. |
| [Troubleshooting](https://ramonmalcolm10.github.io/next-bun-compile/troubleshooting/) | Dynamic `require()` (pino and friends), resolution failures, debug mode. |
| [Guides](https://ramonmalcolm10.github.io/next-bun-compile/guides/docker/) | Docker, monorepos, cross-compilation, `transpilePackages`, edge PPR. |
| [Recipes](https://ramonmalcolm10.github.io/next-bun-compile/recipes/vps-deploy/) | VPS deploy, distroless + sharp, monorepo + sharp. |

## Support

If this saved you time, consider supporting the project:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/ramonmalcolm)

## License

MIT
