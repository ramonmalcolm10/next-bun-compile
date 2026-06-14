# ============================================
# Recipe: distroless + sharp
# ============================================
# Compiles a Next.js app that uses sharp into a single `./server` binary
# and ships it on gcr.io/distroless/cc-debian12. Includes fontconfig +
# fonts copied from the builder so libvips text rendering (watermarks,
# captions) works.
#
# Final image: ~80MB. Binary handles sharp + native deps with the
# next-bun-compile resolver hook; runner provides the C runtime libs
# sharp's prebuilt .node binding dlopens.
# ============================================

# Stage 1: Build the binary
FROM oven/bun:1.3.14 AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --no-save

COPY . .

# Install fontconfig + fonts in the builder so we can copy the artifacts
# into the distroless runner. The build itself doesn't need them, but
# fc-cache populates /var/cache/fontconfig with a fresh font cache the
# runner can use directly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

RUN bun --bun run build

# ============================================
# Stage 2: Run the compiled binary
# ============================================
FROM gcr.io/distroless/cc-debian12:nonroot AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME="0.0.0.0"

# Self-contained binary
COPY --from=builder --chown=nonroot:nonroot /app/server ./

# Fontconfig + fonts + the C libs libvips dlopens for text rendering.
# cc-debian12 already has libstdc++ and libgcc; these complete the set.
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
