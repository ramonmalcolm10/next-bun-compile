/**
 * Frozen whole, like `/`. The routing-rule build gives it a headers() rule
 * that sets only a header the edge contract allows, so it stays in the
 * marker's `static` list and its header travels with it as `headers`.
 */
export default function Framed() {
  return (
    <main>
      <h1>Framed</h1>
    </main>
  );
}
