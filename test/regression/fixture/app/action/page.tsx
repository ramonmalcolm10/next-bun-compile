import { revalidateTag } from "next/cache";
import { redirect } from "next/navigation";

export default function ActionPage() {
  async function bump() {
    "use server";
    revalidateTag("demo", "max");
  }
  // A fetch action that redirects. Next answers these by fetching the target's
  // RSC payload from its OWN origin and streaming it back with the action
  // response, so the server has to know what its own origin is.
  async function go() {
    "use server";
    redirect("/");
  }
  return (
    <main>
      <h1>Action page</h1>
      <form action={bump}>
        <button type="submit">bump demo tag</button>
      </form>
      <form action={go}>
        <button type="submit">redirect home</button>
      </form>
    </main>
  );
}
