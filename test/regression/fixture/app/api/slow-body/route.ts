/**
 * Consumes the request body slowly, so a client that disconnects mid-upload
 * aborts while the server is still reading. That is the request-side abort
 * path (Readable.fromWeb over the incoming web stream) — distinct from the
 * response-side abort a client triggers by closing the pipe early.
 */
export async function POST(req: Request) {
  let bytes = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return Response.json({ bytes });
}
