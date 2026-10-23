import { Suspense } from "react";

// A PPR page whose hole reads the query: the contract's resume must render
// with the visitor's search params, not the endpoint's own.
async function Query({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const sp = await searchParams;
  return <p>utm={sp.utm_source ?? "none"}</p>;
}

export default function SearchPage(props: {
  searchParams: Promise<Record<string, string>>;
}) {
  return (
    <main>
      <h1>Search shell</h1>
      <Suspense fallback={<p>loading query…</p>}>
        <Query searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}
