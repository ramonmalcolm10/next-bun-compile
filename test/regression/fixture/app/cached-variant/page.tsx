import { cacheTag, cacheLife } from "next/cache";

async function getStamp() {
  "use cache";
  cacheTag("variant");
  cacheLife("max");
  return Date.now();
}

/**
 * A second cacheable page, reserved for the variant-isolation checks.
 *
 * It exists because an L1 entry can be created but never replaced: a request
 * that hits an existing entry returns it rather than storing its own. So the
 * two directions of RSC/HTML confusion cannot both be tested on one route —
 * whichever variant lands first owns the entry, and the other assertion then
 * passes because nothing was ever stored to contradict it. This route is
 * touched only by the RSC-first check, so it starts cold there.
 */
export default async function CachedVariant() {
  const stamp = await getStamp();
  return (
    <main>
      <h1>Cached variant page</h1>
      <p data-testid="stamp">variant stamp: {stamp}</p>
    </main>
  );
}
