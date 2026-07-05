import { cacheTag, cacheLife } from "next/cache";

async function getStamp() {
  "use cache";
  cacheTag("demo");
  cacheLife("max");
  return Date.now();
}

export default async function CachedPage() {
  const stamp = await getStamp();
  return (
    <main>
      <h1>Cached page</h1>
      <p data-testid="stamp">cached stamp: {stamp}</p>
    </main>
  );
}
