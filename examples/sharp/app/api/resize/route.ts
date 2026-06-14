import sharp from "sharp";

/**
 * Generates a tiny PNG via sharp so the compiled binary actually exercises
 * the externalized-package code paths: bun chunk → externalImport/
 * externalRequire → sharp main → sharp's internal `require('detect-libc')`
 * and dynamic `require('@img/sharp-${platform}/sharp.node')` chain.
 *
 * If any layer of resolution regresses, this request fails.
 */
export async function GET() {
  const buf = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
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
