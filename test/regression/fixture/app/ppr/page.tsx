import { Suspense } from "react";
import { connection } from "next/server";

async function DynamicHole() {
  await connection();
  return <p data-testid="hole">hole rendered at {Date.now()}</p>;
}

export default function PprPage() {
  return (
    <main>
      <h1>PPR page — this heading is the static shell</h1>
      <p>Static content around a dynamic hole.</p>
      <Suspense fallback={<p data-testid="fallback">streaming…</p>}>
        <DynamicHole />
      </Suspense>
    </main>
  );
}
