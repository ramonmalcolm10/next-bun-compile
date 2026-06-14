# Examples

Working, end-to-end recipes for shipping `next-bun-compile` binaries in
real environments. Each example is also an e2e regression test —
**CI builds + boots every example on every PR**.

| Example | What it shows |
|---|---|
| [`sharp/`](./sharp) | distroless + `sharp` on a single Next.js app. The most common starting point for an app with native image processing. Includes fontconfig setup for libvips text rendering. |
| [`monorepo/`](./monorepo) | bun workspaces monorepo (one app, one shared package) with `sharp`. Demonstrates the nested-standalone layout (`standalone/apps/web/server.js`) and workspace dep resolution from the binary. |
| [`vps-deploy/`](./vps-deploy) | Deploy to a VPS via GitHub Actions + SSH + systemd. The VPS needs nothing installed but ssh, systemd, and glibc — no node, no bun, no Docker. Includes the deploy workflow, the systemd unit, and full one-time-setup README. |

## How to use a recipe

Each recipe is a complete, runnable project. Copy the directory into
your own repo or use the patterns as reference.

```bash
# Run an example locally
cd examples/sharp
bun install
bun --bun run build
./server

# Build it as a container
docker build -t my-app .
docker run --rm -p 3000:3000 my-app
```

## What gets tested in CI

The `e2e-sharp` and `e2e-monorepo` jobs in `.github/workflows/ci.yml`
build each example's binary, boot it, and curl an endpoint that
exercises the externalized-package resolution chain end-to-end. If a
release regresses the resolver hook, alias rewrite, or external module
extraction — the example fails CI before merge.

## Want a recipe for X?

Open an issue describing your stack. If it surfaces a pattern that's
likely to bite other users (a popular native dep, a specific deploy
target, etc.), it's worth a recipe. The more these examples reflect
real-world combos, the better the smoke test coverage gets.
