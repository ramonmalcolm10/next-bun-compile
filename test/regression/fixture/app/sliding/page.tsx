import { cacheTag, cacheLife } from "next/cache";

async function getStamp() {
  "use cache";
  cacheTag("sliding");
  cacheLife("max");
  return Date.now();
}

/**
 * A cacheable page that the proxy attaches a per-caller Set-Cookie to.
 *
 * This is the shape that made a cross-user session leak possible: the page
 * body is shared and legitimately cacheable (`x-nextjs-cache: HIT`, a long
 * `s-maxage`, no `private`), but the response *head* is per-caller, because
 * an auth proxy upstream re-issues the caller's session cookie on the way
 * through. Nothing about the cache headers reveals that.
 */
export default async function SlidingPage() {
  const stamp = await getStamp();
  return (
    <main>
      <h1>Sliding session page</h1>
      <p data-testid="stamp">cached stamp: {stamp}</p>
    </main>
  );
}
