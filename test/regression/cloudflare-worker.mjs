// Runs examples/cloudflare-edge-worker/worker.js against a live binary,
// with caches.default and ctx.waitUntil stubbed in memory. The Worker's
// same-origin fetches land on the binary, as same-zone subrequests do.
//
//   bun cloudflare-worker.mjs <worker.js> <origin> <EDGE_TOKEN>
const [workerPath, origin, token] = process.argv.slice(2);
const store = new Map();
globalThis.caches = { default: {
  async match(k) { const e = store.get(k.url); return e && new Response(e.body, { status: e.status, headers: e.headers }); },
  async put(k, r) { store.set(k.url, { body: await r.arrayBuffer(), status: r.status, headers: [...r.headers] }); },
  async delete(k) { return store.delete(k.url); },
}};
const worker = (await import(workerPath)).default;
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(`  ${c ? "✓" : "✗"} ${d}`); c ? pass++ : fail++; };
const run = async (path, { headers = {}, env = {} } = {}) => {
  const pending = [];
  const res = await worker.fetch(
    new Request(origin + path, { headers: { accept: "text/html", ...headers } }),
    { EDGE_TOKEN: token, ...env },
    { waitUntil: (p) => pending.push(p) },
  );
  const body = await res.text();
  await Promise.all(pending);
  return { res, body };
};
const key = (p) => `${origin}/__edge-page${p}`;
const docs = (b) => (b.match(/<html[\s>]/gi) || []).length;

let r = await run("/search?utm_source=cold");
ok("cold: passes through (no edge build header)", !r.res.headers.get("x-edge-build") && r.body.includes("utm=<!-- -->cold"));
ok("cold: shell warmed into the cache", store.has(key("/search")));
r = await run("/search?utm_source=edge");
ok("warm: served from the edge", !!r.res.headers.get("x-edge-build"));
ok("warm: holes see the visitor's query", r.body.includes("utm=<!-- -->edge"));
ok("warm: exactly one document, closed", docs(r.body) === 1 && r.body.trimEnd().endsWith("</html>"));
ok("warm: private, no-store", r.res.headers.get("cache-control") === "private, no-store");

r = await run("/cached");
ok("non-shell page: tombstoned", JSON.parse(new TextDecoder().decode(store.get(key("/cached")).body)).noShell === true);
r = await run("/cached");
ok("non-shell page: passes through after", !r.res.headers.get("x-edge-build") && r.res.status === 200);

r = await run("/ppr", { headers: { rsc: "1" } });
ok("RSC request passes through", !r.res.headers.get("x-edge-build") && !store.has(key("/ppr")));
r = await run("/_edge/page?path=%2Fppr");
ok("visitor can't reach /_edge/", r.res.status === 404);

// A static page: served whole from the edge once warm, with the headers
// the origin listed, byte for byte the page the origin serves.
const direct = await (await fetch(origin + "/", { headers: { accept: "text/html" } })).text();
r = await run("/");
ok("static cold: passes through, page warmed", !r.res.headers.get("x-edge-build") && store.has(key("/")));
r = await run("/");
ok("static warm: whole page from the edge", !!r.res.headers.get("x-edge-build") && r.body === direct);

// Skew: a cached shell from another build is evicted, visitor keeps fallbacks.
const e = store.get(key("/search"));
const entry = JSON.parse(new TextDecoder().decode(e.body));
store.set(key("/search"), { ...e, body: new TextEncoder().encode(JSON.stringify({ ...entry, build: "old-build" })) });
r = await run("/search?utm_source=skew");
ok("skew: shell only, holes withheld", !r.body.includes("utm=<!-- -->skew") && docs(r.body) === 1);
ok("skew: shell evicted", !store.has(key("/search")));

// Revalidation: an old copy re-checks and gets a 304 restamp.
await run("/ppr"); // warm
const w = store.get(key("/ppr"));
const stale = w.headers.map(([k, v]) => [k, k === "x-edge-cached-at" ? "1" : v]);
store.set(key("/ppr"), { ...w, headers: stale });
r = await run("/ppr");
const at = Number(new Map(store.get(key("/ppr")).headers).get("x-edge-cached-at"));
ok("revalidate: served from edge and restamped via 304", !!r.res.headers.get("x-edge-build") && at > 1 && !!new Map(store.get(key("/ppr")).headers).get("etag"));

store.clear();
r = await run("/ppr", { env: { EDGE_TOKEN: "wrong" } });
ok("wrong token: origin 404s, page tombstoned", JSON.parse(new TextDecoder().decode(store.get(key("/ppr")).body)).noShell === true);
store.clear();
r = await run("/ppr", { env: { EDGE_TOKEN: "" } });
ok("no token: passes through, nothing cached", r.res.status === 200 && store.size === 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
