import { revalidatePath } from "next/cache";

export async function POST() {
  revalidatePath("/ppr");
  return Response.json({ revalidated: true });
}
