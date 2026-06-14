/**
 * Tiny shared package the web app imports from. Verifies that workspace
 * deps survive the standalone trace + extraction round-trip.
 */
export function pickColor(seed: number): { r: number; g: number; b: number } {
  const r = (seed * 73) % 256;
  const g = (seed * 137) % 256;
  const b = (seed * 211) % 256;
  return { r, g, b };
}
