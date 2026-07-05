import { revalidateTag } from "next/cache";

export async function POST() {
  revalidateTag("demo", "max");
  return Response.json({ revalidated: true });
}
