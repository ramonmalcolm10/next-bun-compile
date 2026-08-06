import { revalidateTag } from "next/cache";

export async function POST() {
  revalidateTag("ppr-shell-demo", "max");
  return Response.json({ revalidated: true });
}
