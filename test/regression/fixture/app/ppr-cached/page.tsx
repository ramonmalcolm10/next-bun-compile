import { Suspense } from "react";
import { connection } from "next/server";
import { cacheTag, cacheLife } from "next/cache";

// Cached data read in the SHELL (outside Suspense): revalidating its tag
// regenerates the prerender, so the shell endpoint must serve the new
// value rather than the build-time one.
async function getShellStamp() {
  "use cache";
  cacheTag("ppr-shell-demo");
  cacheLife("max");
  return Date.now();
}

async function DynamicHole() {
  await connection();
  return <p data-testid="hole">hole rendered at {Date.now()}</p>;
}

export default async function PprCachedPage() {
  const stamp = await getShellStamp();
  return (
    <main>
      <h1>PPR page with cached shell data</h1>
      <p data-testid="shell-stamp">shell stamp: {stamp}</p>
      <Suspense fallback={<p data-testid="fallback">streaming…</p>}>
        <DynamicHole />
      </Suspense>
    </main>
  );
}
