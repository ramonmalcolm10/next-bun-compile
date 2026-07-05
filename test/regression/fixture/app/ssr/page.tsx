import { Suspense } from "react";
import { connection } from "next/server";

async function Now() {
  await connection();
  return <p data-testid="now">now: {Date.now()}</p>;
}

export default function SsrPage() {
  return (
    <main>
      <h1>SSR page</h1>
      <Suspense fallback={<p>loading…</p>}>
        <Now />
      </Suspense>
    </main>
  );
}
