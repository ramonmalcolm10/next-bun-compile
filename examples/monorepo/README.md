# Example: monorepo (bun workspaces) + sharp

A bun-workspaces monorepo with one Next.js app (`apps/web`) and one
shared package (`packages/shared`). The web app uses sharp + the
shared package and is compiled to a single binary on
`gcr.io/distroless/cc-debian12`.

Doubles as the e2e regression test for two things at once:

1. **Nested standalone layout** — Next.js produces
   `apps/web/.next/standalone/apps/web/server.js` (not
   `standalone/server.js`). next-bun-compile's `findServerDir` has to
   detect the nested location, and `findPackageDirs` /
   `collectExternalModules` have to walk nested `node_modules/`
   directories to find packages — not just the top-level one.

2. **Workspace package resolution** — `@example/shared` is a
   `workspace:*`-style dep. The standalone trace pulls it in; the
   runtime needs to resolve it from the binary's extracted
   `node_modules/`.

## What's here

```
monorepo/
├── package.json              # workspaces: ["apps/*", "packages/*"]
├── apps/
│   └── web/
│       ├── app/api/resize/route.ts  # uses sharp + @example/shared
│       ├── next.config.ts
│       └── package.json
├── packages/
│   └── shared/
│       ├── index.ts           # exports pickColor(seed)
│       └── package.json
├── Dockerfile
└── README.md
```

## Build + run locally

```bash
bun install                                  # at the monorepo root
cd apps/web && bun --bun run build           # → apps/web/server
PORT=3000 ./server &
curl http://localhost:3000/api/resize > out.png
file out.png                                 # PNG image data, 32 x 32
```

## Build the Docker image

```bash
docker build -t next-bun-compile-monorepo .
docker run --rm -p 3000:3000 next-bun-compile-monorepo
```

## Notes for adapting to your monorepo

- **Turborepo / Nx**: works the same way — next-bun-compile cares about
  the standalone layout, not the workspace tool. If you use
  `turbo prune --docker` in CI to slim the Docker context, the
  pruned tree still triggers the nested-layout codepath.
- **pnpm workspaces**: works. The `.pnpm/` hoisted store is handled
  by the same code as the `.bun/` store.
- **Many apps in one repo**: next-bun-compile scopes to whatever app's
  `next build` you run; it doesn't try to detect siblings.
