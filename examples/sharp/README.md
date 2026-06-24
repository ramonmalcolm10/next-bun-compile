# Example: distroless + sharp

A minimal Next.js 16 app that uses `sharp` (image processing, the dep
`next/image` server-side optimization pulls in), compiled to a single
binary and shipped on `gcr.io/distroless/cc-debian12`.

This is also the e2e test fixture — CI builds + boots it on every PR.

## What's here

```
sharp/
├── app/
│   ├── api/resize/route.ts   # generates a 32x32 PNG via sharp
│   ├── layout.tsx
│   └── page.tsx
├── next.config.ts            # output: "standalone"
├── package.json              # next, react, sharp, next-bun-compile
├── tsconfig.json
├── Dockerfile                # the recipe
└── README.md                 # this file
```

## Build + run locally

```bash
bun install
bun --bun run build           # produces ./server
PORT=3000 ./server &
curl http://localhost:3000/api/resize > out.png
file out.png                   # PNG image data, 32 x 32
```

## Build the Docker image

```bash
docker build -t next-bun-compile-sharp .
docker run --rm -p 3000:3000 next-bun-compile-sharp
```

Final image is ~80MB. Binary handles JS resolution for sharp + its
internal deps via the next-bun-compile resolver hook; the runner image
provides the C runtime libs sharp's prebuilt `.node` binding dlopens.

## Why each Dockerfile piece exists

| Lines | Why |
|---|---|
| `oven/bun:1.3.14` builder | Builds the binary; debian-based so `apt-get` works |
| `apt-get install fontconfig fonts-dejavu-core` | libvips needs fontconfig + a font face for text rendering (watermarks, captions). Skip if you only do non-text sharp ops (resize, format conversion). |
| `fc-cache -f` | Populates `/var/cache/fontconfig` so the runner doesn't have to rebuild the cache on first text-render |
| `bun --bun run build` | `next build` + `next-bun-compile` → `./server` |
| `gcr.io/distroless/cc-debian12:nonroot` | Has glibc + libstdc++ + libgcc (the "cc" variant). The plain `base` variant lacks libstdc++ and sharp won't load. |
| `COPY /etc/fonts /usr/share/fontconfig /usr/share/fonts /var/cache/fontconfig` | All the data fontconfig expects. Drop if you don't render text. |
| `COPY libfontconfig + libfreetype + libexpat + libpng16` | The actual runtime libs libvips dlopens. Same caveat as fonts. |

## If you don't need text rendering

If your sharp usage is resize / format conversion / composite only (no
text), you can drop the fontconfig + fonts + libfontconfig/libfreetype
copies. Shrinks the image by ~5MB.

## Variants

- **alpine + bun runtime instead** — if you want to skip compilation
  altogether: use `oven/bun:1.3.14-alpine`, `apk add fontconfig
  ttf-dejavu`, `COPY .next/standalone .`, `CMD ["bun",
  "apps/web/server.js"]`. Larger image (~150MB), no compile step,
  same resolution behavior because it's the standard bun runtime.

- **non-text sharp only** — drop the fontconfig blocks above. ~30MB
  smaller.

- **other architectures** — pass `--target=bun-linux-arm64` to
  `next-bun-compile` in the build script. See the bun docs.
