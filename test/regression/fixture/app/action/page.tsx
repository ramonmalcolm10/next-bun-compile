import { revalidateTag } from "next/cache";

export default function ActionPage() {
  async function bump() {
    "use server";
    revalidateTag("demo", "max");
  }
  return (
    <main>
      <h1>Action page</h1>
      <form action={bump}>
        <button type="submit">bump demo tag</button>
      </form>
    </main>
  );
}
