# ============================================
# Recipe: distroless + sharp inside a bun workspaces monorepo
# ============================================
# Demonstrates the standalone trace's nested layout
# (`standalone/apps/web/server.js`, not `standalone/server.js`) and a
# workspace dep (`@example/shared`) being reachable from the binary.
# next-bun-compile handles both — the resolver hook walks nested
# `node_modules/` directories and embeds workspace packages from
# wherever the standalone trace placed them.
# ============================================

FROM oven/bun:1.3.14 AS builder

WORKDIR /app

# Workspace setup: root package.json + all workspace package.jsons
# need to be present before `bun install` so the workspace graph
# resolves. Copy them all first, then install once.
COPY package.json bun.lock* ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --no-save

# Now copy the source code
COPY . .

# Fontconfig + fonts so the runner can do libvips text rendering. Skip
# if your sharp usage is resize/format-only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# Build the web app — produces apps/web/server (single binary)
RUN cd apps/web && bun --bun run build

# ============================================
# Runner: distroless with libstdc++ + fontconfig
# ============================================
FROM gcr.io/distroless/cc-debian12:nonroot AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME="0.0.0.0"

COPY --from=builder --chown=nonroot:nonroot /app/apps/web/server ./

COPY --from=builder /etc/fonts /etc/fonts
COPY --from=builder /usr/share/fontconfig /usr/share/fontconfig
COPY --from=builder /usr/share/fonts /usr/share/fonts
COPY --from=builder /var/cache/fontconfig /var/cache/fontconfig
COPY --from=builder /usr/lib/x86_64-linux-gnu/libfontconfig.so* /usr/lib/x86_64-linux-gnu/
COPY --from=builder /usr/lib/x86_64-linux-gnu/libfreetype.so* /usr/lib/x86_64-linux-gnu/
COPY --from=builder /usr/lib/x86_64-linux-gnu/libexpat.so* /usr/lib/x86_64-linux-gnu/
COPY --from=builder /usr/lib/x86_64-linux-gnu/libpng16.so* /usr/lib/x86_64-linux-gnu/

EXPOSE 3000
CMD ["./server"]
