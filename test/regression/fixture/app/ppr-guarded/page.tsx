import { Suspense } from "react";
import { connection } from "next/server";

async function DynamicHole() {
  await connection();
  return <p data-testid="hole">hole rendered at {Date.now()}</p>;
}

// A PPR route that a proxy matcher covers. The shell/postponed pair on
// disk is perfectly valid — the point is that handing it to a CDN moves
// the response head to the edge, where the proxy's redirect and cookie
// can no longer reach it. So this route must have no shell to hand out.
export default function PprGuardedPage() {
  return (
    <main>
      <h1>PPR page behind a proxy matcher</h1>
      <Suspense fallback={<p data-testid="fallback">streaming…</p>}>
        <DynamicHole />
      </Suspense>
    </main>
  );
}
