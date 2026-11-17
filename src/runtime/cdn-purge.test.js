const { test, expect, afterEach } = require("bun:test");
const { _internal } = require("./serve.js");
const { cdnTag, cdnCacheTag, cdnPurgeBodies, cdnPurger } = _internal;

test("revalidatePath tags become paths, in the form the app serves them", () => {
  expect(cdnPurgeBodies(["_N_T_/", "_N_T_/index"], false)).toEqual([{ paths: ["/"] }]);
  expect(cdnPurgeBodies(["_N_T_/blog/x"], true)).toEqual([{ paths: ["/blog/x/"] }]);
  expect(cdnPurgeBodies("posts", false)).toEqual([{ tags: ["posts"] }]);
});

test("layout and page tags stay tags; a page tag also names its path", () => {
  expect(cdnPurgeBodies(["_N_T_/blog/layout"], false)).toEqual([{ tags: ["_N_T_/blog/layout"] }]);
  expect(cdnPurgeBodies(["_N_T_/blog/page"], false)).toEqual([
    { tags: ["_N_T_/blog/page"], paths: ["/blog"] },
  ]);
  expect(cdnPurgeBodies(["_N_T_/blog/[slug]/page"], false)).toEqual([
    { tags: ["_N_T_/blog/[slug]/page"] },
  ]);
});

test("tags are visible ASCII, the same in the purge as in Cache-Tag", () => {
  expect(cdnTag("a,b c")).toBe("a%2Cb%20c");
  expect(cdnTag("x".repeat(1025))).toBeNull();
  expect(cdnCacheTag(["a,b", "c", "c"])).toBe("a%2Cb,c");
  expect(cdnCacheTag([])).toBeNull();
  const many = Array.from({ length: 200 }, (_, i) => `t${i}`);
  expect(cdnCacheTag(many).split(",").length).toBe(128);
  expect(cdnPurgeBodies(["a,b"], false)).toEqual([{ tags: ["a%2Cb"] }]);
});

test("more than 100 entries split across requests", () => {
  const tags = Array.from({ length: 150 }, (_, i) => `t${i}`).concat(["_N_T_/p"]);
  const bodies = cdnPurgeBodies(tags, false);
  expect(bodies.length).toBe(2);
  expect(bodies[0].tags.length).toBe(100);
  expect(bodies[1]).toEqual({ tags: tags.slice(100, 150), paths: ["/p"] });
});

let server;
afterEach(() => server?.stop(true));

function stub(answer) {
  const seen = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ method: req.method, type: req.headers.get("content-type"), body: await req.json() });
      return answer(seen.length);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/purge`, seen };
}
const until = async (f) => {
  for (let i = 0; i < 200 && !f(); i++) await Bun.sleep(10);
};

test("POSTs the tags and paths to CDN_PURGE_URL without waiting for it", async () => {
  const s = stub(() => new Response(null, { status: 202 }));
  const ret = cdnPurger(s.url, false)(["posts", "_N_T_/"]);
  expect(ret).toBeUndefined(); // nothing for the revalidation to await
  await until(() => s.seen.length === 1);
  expect(s.seen).toEqual([
    { method: "POST", type: "application/json", body: { tags: ["posts"], paths: ["/"] } },
  ]);
});

test("a 429 is retried once after Retry-After", async () => {
  const s = stub(() => new Response(null, { status: 429, headers: { "Retry-After": "0" } }));
  cdnPurger(s.url, false)(["posts"]);
  await until(() => s.seen.length === 2);
  await Bun.sleep(50);
  expect(s.seen.length).toBe(2);
});

test("an unreachable endpoint never throws", async () => {
  const purge = cdnPurger("http://127.0.0.1:1/purge", false);
  expect(() => purge(["posts"])).not.toThrow();
  await Bun.sleep(50);
});

test("without CDN_PURGE_URL nothing is sent", async () => {
  const s = stub(() => new Response(null, { status: 202 }));
  cdnPurger(undefined, false)(["posts"]);
  cdnPurger("", false)(["posts"]);
  await Bun.sleep(50);
  expect(s.seen.length).toBe(0);
});

test("a report-only policy may travel with an edge page", () => {
  const { edgeHeaderRuleOk } = require("./serve.js");
  expect(
    edgeHeaderRuleOk({ headers: { "Content-Security-Policy-Report-Only": "default-src 'self'" } })
  ).toBe(true);
});
