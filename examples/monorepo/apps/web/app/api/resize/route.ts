import sharp from "sharp";
import { pickColor } from "@example/shared";

/**
 * Verifies two things at once:
 * 1. sharp loads end-to-end from a chunk inside a monorepo standalone
 *    layout (standalone/apps/web/server.js, not standalone/server.js)
 * 2. A workspace package (`@example/shared`) survives the standalone
 *    trace and is reachable at runtime from the binary
 */
export async function GET() {
  const { r, g, b } = pickColor(7);

  const buf = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r, g, b, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store",
    },
  });
}
