export default function UploadPage() {
  // A server action whose argument carries binary. The body arrives as
  // multipart and Next parses it with busboy, piping the request stream
  // through `pipeline()` — the one path in the suite that reads a
  // request body of any size through the runtime's Node-stream bridge.
  async function upload(formData: FormData) {
    "use server";
    const f = formData.get("file") as File;
    const bytes = new Uint8Array(await f.arrayBuffer());
    // Sum the bytes: proves the body arrived intact, not merely that it
    // arrived. A truncated or re-chunked stream still has a plausible
    // length.
    let sum = 0;
    for (const b of bytes) sum = (sum + b) % 1_000_000_007;
    console.log(`UPLOAD_OK name=${f.name} bytes=${bytes.length} sum=${sum}`);
  }
  return (
    <main>
      <h1>Upload</h1>
      <form action={upload}>
        <input type="file" name="file" />
        <button type="submit">upload</button>
      </form>
    </main>
  );
}
