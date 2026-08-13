/**
 * Single-server Bun.serve runtime for compiled Next.js binaries.
 *
 * Request flow, fastest tier first:
 *   Tier 1 — immutable /_next/static/* and public/* files, served as
 *            in-memory Responses via Bun's static route dispatch.
 *   Tier 2 — fully-static prerendered pages (revalidate: false, no PPR
 *            postponed state, not covered by middleware), served from
 *            embedded bytes with RSC content negotiation and ETag/304.
 *            Invalidation-aware: a cache-handler hook drops a page from
 *            the route table (via server.reload) the moment Next
 *            revalidates it, so on-demand revalidation keeps working.
 *   Tier 3 — everything else (PPR resume, ISR, API routes, server
 *            actions, dynamic rendering) goes to Next's own request
 *            handler in-process through a fetch→node bridge. One
 *            process, one listener — Next never opens a socket.
 */
const path = require("path");
const fs = require("fs");
const { Readable, Writable } = require("stream");

/* ---------------------------------------------------------------- *
 * fetch → node bridge
 *
 * Next's request handler wants Node (req, res). We synthesize both
 * from a fetch Request and collect the response into a fetch Response
 * whose body streams as Next writes — the Response resolves on first
 * flush, not at end, so streamed SSR / PPR resume behave identically.
 * ---------------------------------------------------------------- */

function makeSocket(remoteAddr) {
  return {
    remoteAddress: remoteAddr,
    remotePort: 0,
    localAddress: "127.0.0.1",
    localPort: 0,
    encrypted: false,
    destroyed: false,
    readable: true,
    writable: true,
    setNoDelay() {},
    setKeepAlive() {},
    setTimeout() {},
    ref() { return this; },
    unref() { return this; },
    destroy() { this.destroyed = true; },
    on() { return this; },
    once() { return this; },
    off() { return this; },
    removeListener() { return this; },
    addListener() { return this; },
    end() {},
    write() { return true; },
  };
}

function makeNodeRequest(request, remoteAddr) {
  const url = new URL(request.url);
  const req = request.body
    ? Readable.fromWeb(request.body)
    : Readable.from([]);
  req.httpVersion = "1.1";
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.originalUrl = req.url;
  const headers = {};
  const rawHeaders = [];
  for (const [k, v] of request.headers) {
    headers[k] = v;
    rawHeaders.push(k, v);
  }
  req.headers = headers;
  req.rawHeaders = rawHeaders;
  req.socket = makeSocket(remoteAddr);
  req.connection = req.socket;
  req.aborted = false;
  req.complete = true;
  return req;
}

class NodeResponseShim extends Writable {
  constructor(req, onHead) {
    super();
    this.req = req;
    this.statusCode = 200;
    this.statusMessage = "";
    this.headersSent = false;
    this.finished = false;
    this._headers = new Map(); // lower-case name → [origName, value]
    this._onHead = onHead;
    this._controller = null;
    this._body = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
      cancel: () => {
        this.destroy();
      },
    });
  }
  _flushHead() {
    if (this.headersSent) return;
    this.headersSent = true;
    const headers = new Headers();
    for (const [, [name, value]] of this._headers) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(name, String(v));
      } else {
        headers.set(name, String(value));
      }
    }
    // fetch owns message framing; hop-by-hop headers must not survive
    headers.delete("transfer-encoding");
    headers.delete("connection");
    headers.delete("keep-alive");
    this._onHead(this.statusCode, headers, this._body);
  }
  // ---- header API (what Next + its compression middleware use) ----
  setHeader(name, value) {
    this._headers.set(String(name).toLowerCase(), [String(name), value]);
    return this;
  }
  getHeader(name) {
    const e = this._headers.get(String(name).toLowerCase());
    return e ? e[1] : undefined;
  }
  getHeaders() {
    const out = {};
    for (const [lc, [, value]] of this._headers) out[lc] = value;
    return out;
  }
  getHeaderNames() {
    return Array.from(this._headers.keys());
  }
  hasHeader(name) {
    return this._headers.has(String(name).toLowerCase());
  }
  removeHeader(name) {
    this._headers.delete(String(name).toLowerCase());
  }
  appendHeader(name, value) {
    const lc = String(name).toLowerCase();
    const e = this._headers.get(lc);
    if (!e) return this.setHeader(name, value);
    const prev = Array.isArray(e[1]) ? e[1] : [e[1]];
    this._headers.set(lc, [e[0], prev.concat(value)]);
    return this;
  }
  writeHead(status, reasonOrHeaders, maybeHeaders) {
    this.statusCode = status;
    let headers = maybeHeaders;
    if (typeof reasonOrHeaders === "string") this.statusMessage = reasonOrHeaders;
    else headers = reasonOrHeaders;
    if (headers) {
      if (Array.isArray(headers)) {
        for (let i = 0; i + 1 < headers.length; i += 2) {
          this.setHeader(headers[i], headers[i + 1]);
        }
      } else {
        for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
      }
    }
    this._flushHead();
    return this;
  }
  flushHeaders() {
    this._implicitHeader();
  }
  // Header flushing must go through writeHead so middleware that patches
  // it (compression via on-headers, most notably) observes the flush.
  _implicitHeader() {
    if (!this.headersSent) this.writeHead(this.statusCode);
  }
  flush() {}
  // ---- body ----
  _write(chunk, encoding, callback) {
    // Writes racing a client disconnect go nowhere on a real socket too —
    // drop them quietly instead of erroring Next's render pipeline.
    if (this.destroyed || this.req.aborted) return callback();
    this._implicitHeader();
    try {
      this._controller.enqueue(
        typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk
      );
      callback();
    } catch (err) {
      callback(err);
    }
  }
  _final(callback) {
    this._implicitHeader();
    this.finished = true;
    try {
      this._controller.close();
    } catch {}
    callback();
  }
  _destroy(err, callback) {
    if (!this.finished) {
      this.finished = true;
      try {
        // A real error must propagate to the client's stream; but a plain
        // teardown (client disconnect, bodyless cancel) closes it cleanly.
        // error()-ing on abort surfaced every routine disconnect as an
        // "unhandledRejection: Error: aborted" in Bun's response pump.
        if (err) this._controller.error(err);
        else this._controller.close();
      } catch {}
    }
    callback(err);
  }
}

function createBridge(getHandler) {
  return async function bridge(request, server) {
    const remoteAddr =
      (server && server.requestIP(request)?.address) || "127.0.0.1";
    const req = makeNodeRequest(request, remoteAddr);
    let settled = false;
    return await new Promise((resolve, reject) => {
      const res = new NodeResponseShim(req, (status, headers, body) => {
        settled = true;
        // 204/304 and HEAD must not carry a body
        const bodyless =
          status === 204 || status === 304 || request.method === "HEAD";
        if (bodyless) body.cancel().catch(() => {});
        resolve(
          new Response(bodyless ? null : body, {
            status,
            statusText: res.statusMessage || undefined,
            headers,
          })
        );
      });
      res.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      request.signal.addEventListener("abort", () => {
        req.aborted = true;
        req.destroy();
        res.destroy();
      });
      Promise.resolve(getHandler()(req, res)).catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  };
}

/* ---------------------------------------------------------------- *
 * Tier construction
 * ---------------------------------------------------------------- */

const IMMUTABLE = "public, max-age=31536000, immutable";
const PAGE_VARY =
  "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding";

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;
const GZIP_MIN_BYTES = 1024; // match compression middleware's threshold

function acceptsGzip(req) {
  const ae = req.headers.get("accept-encoding");
  return !!ae && ae.includes("gzip");
}

// __runtime/ assets may be stored gzipped in the binary (they're
// extraction-bound; only Tier-2 page seeds are ever read back here).
// start() fills this with the build's gzip-embedded urlPaths.
let gzippedAssetSet = new Set();

async function loadBytes(assetMap, key) {
  const ref = assetMap.get(key);
  if (ref == null) return null;
  const bytes = await Bun.file(ref).bytes();
  return gzippedAssetSet.has(key) ? Bun.gunzipSync(bytes) : bytes;
}

function contentTypeFor(assetMap, key, fallback) {
  const ref = assetMap.get(key);
  const t = ref != null ? Bun.file(ref).type : "";
  return t || fallback || "application/octet-stream";
}

/** Tier 1: exact-path static Responses. */
async function buildTier1Routes(tier1, assetMap, bridge) {
  const routes = {};
  await Promise.all(
    tier1.map(async ({ urlPath, key, kind }) => {
      const bytes = await loadBytes(assetMap, key);
      if (bytes == null) return;
      const contentType = contentTypeFor(assetMap, key);
      const headers = {
        "Content-Type": contentType,
        "Cache-Control": kind === "static" ? IMMUTABLE : "public, max-age=0",
      };
      // Text assets gzip like baseline (Next runs compression middleware
      // over everything it serves). Precompressed once at boot.
      if (
        COMPRESSIBLE.test(contentType) &&
        bytes.byteLength >= GZIP_MIN_BYTES
      ) {
        const gz = Bun.gzipSync(bytes);
        const etag = `"${Bun.hash(bytes).toString(36)}"`;
        const base = {
          ...headers,
          Vary: "Accept-Encoding",
          ETag: etag,
        };
        routes[urlPath] = (req, server) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return bridge(req, server);
          }
          if (kind === "public" && req.headers.has("range")) {
            return bridge(req, server);
          }
          if (req.headers.get("if-none-match") === etag) {
            return new Response(null, { status: 304, headers: base });
          }
          const gzip = acceptsGzip(req);
          const body = gzip ? gz : bytes;
          const h = {
            ...base,
            ...(gzip && { "Content-Encoding": "gzip" }),
            "Content-Length": String(body.byteLength),
          };
          return new Response(req.method === "HEAD" ? null : body, {
            headers: h,
          });
        };
        return;
      }
      if (kind === "public") {
        // Next serves public files with range support; embedded static
        // Responses can't. Serve from memory unless a Range arrives, and
        // let non-GET/HEAD methods reach Next so its semantics (405s)
        // stay intact.
        const etag = `"${Bun.hash(bytes).toString(36)}"`;
        const withMeta = {
          ...headers,
          ETag: etag,
          "Accept-Ranges": "bytes",
          "Content-Length": String(bytes.byteLength),
        };
        routes[urlPath] = (req, server) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return bridge(req, server);
          }
          if (req.headers.has("range")) return bridge(req, server);
          if (req.headers.get("if-none-match") === etag) {
            return new Response(null, { status: 304, headers: withMeta });
          }
          return new Response(req.method === "HEAD" ? null : bytes, {
            headers: withMeta,
          });
        };
      } else {
        routes[urlPath] = new Response(bytes, { headers });
      }
    })
  );
  return routes;
}

/** Tier 2: prerendered page with RSC negotiation + ETag/304. */
function makePageHandler(page, bridge) {
  const { html, rsc, headers: metaHeaders, status, contentType, deploymentId } =
    page;
  const htmlEtag = `"${Bun.hash(html).toString(36)}"`;
  const rscEtag = rsc ? `"${Bun.hash(rsc).toString(36)}"` : null;
  const htmlGz = html.byteLength >= GZIP_MIN_BYTES ? Bun.gzipSync(html) : null;
  const rscGz =
    rsc && rsc.byteLength >= GZIP_MIN_BYTES ? Bun.gzipSync(rsc) : null;

  const base = {};
  let hasCacheControl = false;
  for (const [k, v] of Object.entries(metaHeaders || {})) {
    base[k] = v;
    if (k.toLowerCase() === "cache-control") hasCacheControl = true;
  }
  base["Vary"] = PAGE_VARY;
  // Seeds that recorded an explicit cache-control (static metadata routes:
  // public, max-age=0, must-revalidate) keep it — pages get the frozen-
  // prerender policy.
  if (!hasCacheControl) base["Cache-Control"] = "s-maxage=31536000";
  base["x-nextjs-cache"] = "HIT";

  return (req, server) => {
    // Draft/preview mode and segment prefetches have per-request
    // semantics only Next understands.
    const cookie = req.headers.get("cookie");
    if (cookie && cookie.includes("__prerender_bypass")) {
      return bridge(req, server);
    }
    const url = new URL(req.url);
    const wantsRsc =
      req.headers.has("rsc") || url.searchParams.has("_rsc");
    if (wantsRsc && req.headers.has("next-router-segment-prefetch")) {
      return bridge(req, server);
    }
    const body = wantsRsc ? rsc : html;
    if (body == null) return bridge(req, server);
    const etag = wantsRsc ? rscEtag : htmlEtag;
    const gz = wantsRsc ? rscGz : htmlGz;
    const useGzip = gz && acceptsGzip(req);
    const payload = useGzip ? gz : body;
    const headers = {
      ...base,
      "Content-Type": wantsRsc
        ? "text/x-component"
        : contentType || "text/html; charset=utf-8",
      ...(useGzip && { "Content-Encoding": "gzip" }),
      "Content-Length": String(payload.byteLength),
      ETag: etag,
      // Baseline sends X-Powered-By on documents but not RSC payloads.
      ...(!wantsRsc && { "X-Powered-By": "Next.js" }),
      // With a deploymentId configured, Next stamps RSC responses so the
      // client router can detect deployment skew — replicate it.
      ...(wantsRsc &&
        deploymentId && { "x-nextjs-deployment-id": deploymentId }),
    };
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(req.method === "HEAD" ? null : payload, {
      status,
      headers,
    });
  };
}

async function buildTier2Routes(staticPages, assetMap, bridge, deploymentId) {
  const routes = {};
  await Promise.all(
    staticPages.map(async (spec) => {
      const html = await loadBytes(assetMap, spec.htmlKey);
      if (html == null) return;
      const rsc = spec.rscKey ? await loadBytes(assetMap, spec.rscKey) : null;
      const handler = makePageHandler(
        {
          html,
          rsc,
          headers: spec.headers,
          status: spec.status,
          contentType: spec.contentType,
          deploymentId,
        },
        bridge
      );
      // Plain function route: GET/HEAD from memory, everything else
      // (server-action POSTs above all) must reach Next.
      routes[spec.path] = (req, server) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return bridge(req, server);
        }
        return handler(req, server);
      };
    })
  );
  return routes;
}

/* ---------------------------------------------------------------- *
 * Edge-shell endpoint (opt-in via NBC_PPR_SHELL)
 *
 * Serves each PPR route's build-frozen artifacts — shell HTML,
 * postponedState, BUILD_ID — so an edge worker can cache the shell
 * and drive the resume protocol with no build-time push pipeline.
 * All three artifacts are computed at `next build` time, before any
 * request exists: they cannot contain per-user data by construction.
 *
 * Like the tiers, everything is precomputed at boot from the
 * extracted tree and served from memory as exact routes — request
 * data never touches the filesystem, and unknown paths fall through
 * to the normal 404 flow.
 *
 * NBC_PPR_SHELL="1"/"true" → open; any other value is a shared token
 * that must arrive in the x-nbc-shell-token header (keeps auth-gated
 * routes' skeletons from being publicly enumerable).
 * ---------------------------------------------------------------- */
const SHELL_PREFIX = "/_nbc/ppr-shell/";

// Captured from the patched IncrementalCache prototype. A regenerated
// pair lands wherever the configured handler puts it: on disk for the
// default one, in a shared store for a custom one — where a regeneration
// on any pod never touches this pod's disk, and a pod that only reads
// never sees a set() either. Reading through the cache is the one source
// that is correct for both, so the endpoint asks it first and falls back
// to the prerender on disk.
let incrementalCache = null;

// Only PPR pairs qualify; fully static/dynamic routes have none.
function readShellPair(metaPath, htmlPath) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
  const postponed = meta && meta.postponed;
  if (!postponed || typeof postponed !== "string") return null;
  let shell;
  try {
    shell = fs.readFileSync(htmlPath, "utf-8");
  } catch {
    return null;
  }
  // Next's own tag set for the route — both revalidateTag and
  // revalidatePath land here (the latter as `_N_T_/<path>`). Passed
  // through so a tag-aware CDN can index the shell and purge it by tag
  // instead of waiting out its TTL.
  const raw = (meta.headers && meta.headers["x-next-cache-tags"]) || "";
  const tags = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return { shell, postponed, tags };
}

function pairStamp(metaPath, htmlPath) {
  try {
    return `${fs.statSync(metaPath).mtimeMs}:${fs.statSync(htmlPath).mtimeMs}`;
  } catch {
    return "";
  }
}

// A route's endpoint entry. The pair is held in memory and re-read only
// when the prerender is rewritten on disk — an ISR expiry, or a `use
// cache` region inside the shell whose tag was revalidated — so the edge
// serves the same shell the origin would. A shell that never regenerates
// (a static frame around dynamic holes) keeps its build-frozen pair for
// the life of the process: the postponed state is code-shaped, and only a
// new build changes it, which is a new process that re-reads at boot.
// Nothing but a per-PoP cache miss reaches this handler, so the stat is
// never on a hot path, and an unreadable pair keeps the last good copy
// rather than darkening a working shell.
// The route's current pair as the cache handler holds it. Returns null
// when Next hasn't booted, the handler has no entry yet (it fills on
// demand, so the build output is still the truth), or the read fails.
async function shellPairFromCache(route, fallbackTags) {
  const cache = incrementalCache;
  if (!cache) return null;
  try {
    const res = await cache.get(route, {
      kind: "APP_PAGE",
      isRoutePPREnabled: true,
    });
    const value = res && res.value;
    if (!value || value.kind !== "APP_PAGE") return null;
    const postponed = value.postponed;
    if (typeof postponed !== "string" || !postponed) return null;
    const shell =
      typeof value.html === "string"
        ? value.html
        : value.html && typeof value.html.toString === "function"
          ? value.html.toString("utf-8")
          : null;
    if (typeof shell !== "string" || !shell) return null;
    const raw =
      (value.headers && value.headers["x-next-cache-tags"]) || "";
    const tags = raw
      ? raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : fallbackTags;
    return { shell, postponed, tags };
  } catch {
    return null;
  }
}

function shellRoute(metaPath, htmlPath, route, buildId, token, pair) {
  let stamp = pairStamp(metaPath, htmlPath);
  let payload = "";
  let etag = "";
  let headers = null;
  // Bun's automatic ETag covers static `Response` routes only; this one
  // must be a handler (token check, and the pair can change under it), so
  // the tag is computed the same way tiers 1 and 2 do it.
  const adopt = (p) => {
    payload = JSON.stringify({ ...p, buildId });
    etag = `"${Bun.hash(payload).toString(36)}"`;
    headers = {
      "Content-Type": "application/json",
      // Open mode: prerendered content, shared caches may hold it (a zone
      // purge on deploy or this max-age refreshes it). Token mode: must
      // be unstorable by shared caches — a zone-wide CDN cache rule would
      // otherwise cache the tokened 200 and serve it to anyone, defeating
      // the token. The edge worker re-wraps the response for its own
      // private cache.
      "Cache-Control": token ? "private, no-store" : "public, max-age=3600",
      // A CDN's copy outlives the regeneration that replaced it, so it
      // needs to ask "is mine still current?" for the price of a 304
      // rather than a full body on every check.
      ETag: etag,
      // Next's tag set for the route, so a tag-aware CDN (Fastly
      // surrogate keys, Cloudflare Enterprise cache tags) can purge this
      // shell on revalidation instead of waiting out its TTL.
      ...(p.tags.length && { "Cache-Tag": p.tags.join(",") }),
    };
  };
  adopt(pair);
  const current = async () => {
    const viaCache = await shellPairFromCache(route, pair.tags);
    if (viaCache) {
      // Adopt only on a real change: the payload is what the ETag is
      // computed from, and a stable ETag is what lets an edge worker
      // revalidate for the price of a 304.
      const next = JSON.stringify({ ...viaCache, buildId });
      if (next !== payload) adopt(viaCache);
      return;
    }
    const now = pairStamp(metaPath, htmlPath);
    if (now && now !== stamp) {
      const fresh = readShellPair(metaPath, htmlPath);
      if (fresh) {
        adopt(fresh);
        stamp = now;
      }
    }
  };
  return async (req) => {
    if (token && req.headers.get("x-nbc-shell-token") !== token) {
      return new Response(null, { status: 401 });
    }
    await current();
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(payload, { headers });
  };
}

/**
 * Compile the build's coverage rules (proxy/middleware matchers plus
 * response-altering routing rules) into a single predicate. Mirrors
 * computeStaticTiersFromSnapshot in src/generate.ts, including its
 * fail-closed handling of a source this engine won't parse.
 */
function shellGuard(sources) {
  const res = [];
  for (const source of sources) {
    try {
      res.push(new RegExp(source));
    } catch {
      res.push(/.*/); // unparseable rule: fail closed
    }
  }
  return (p) => res.some((re) => re.test(p));
}

/**
 * Publish the PPR shell/postponed pairs a CDN may serve.
 *
 * `guards` is what keeps this honest. Handing a shell to a CDN moves the
 * response head to the edge, where it is committed before the origin has
 * rendered anything — so a Set-Cookie, a redirect, or a non-200 that the
 * request would have earned at the origin can no longer reach the client.
 * The CDN has already sent 200 + headers and can only append body bytes.
 *
 * The invariant: a route that can emit a Set-Cookie, a redirect, or a
 * non-200 status before or during its dynamic render must not have an
 * edge-served shell. Middleware coverage is the part of that we can see
 * from a build, and it is the part that bites hardest — an auth gate that
 * silently stops running is indistinguishable from no auth gate. It is
 * not the whole invariant: a `redirect()` or `notFound()` from inside a
 * dynamic hole fails the same way on a route no matcher covers. Those
 * routes must be kept off the CDN by hand (drop them from the worker's
 * route list); this only guarantees the statically-provable half.
 */
function buildShellRoutes(baseDir, guards = []) {
  const raw = process.env.NBC_PPR_SHELL;
  if (!raw) return {};
  const covered = shellGuard(guards);
  const token = raw === "1" || raw === "true" ? null : raw;
  const appDir = path.join(baseDir, ".next", "server", "app");
  let buildId = "";
  try {
    buildId = fs
      .readFileSync(path.join(baseDir, ".next", "BUILD_ID"), "utf-8")
      .trim();
  } catch {}
  const routes = {};
  let excluded = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.endsWith(".meta")) continue;
      const htmlPath = full.slice(0, -".meta".length) + ".html";
      const pair = readShellPair(full, htmlPath);
      if (!pair) continue;
      const rel = path
        .relative(appDir, full)
        .slice(0, -".meta".length)
        .split(path.sep)
        .join("/");
      const routePath = rel === "index" ? "/" : "/" + rel;
      // No route, so the endpoint 404s and the CDN passes through
      // permanently — the origin keeps owning this response head.
      if (covered(routePath)) {
        excluded++;
        continue;
      }
      routes[SHELL_PREFIX + rel] = shellRoute(
        full,
        htmlPath,
        routePath,
        buildId,
        token,
        pair
      );
    }
  };
  walk(appDir);
  const count = Object.keys(routes).length;
  if (count > 0) {
    console.log(
      `next-bun-compile: PPR shell endpoint serving ${count} route(s) from memory`
    );
  }
  // Worth saying out loud: someone who put these routes in a CDN route
  // list is otherwise left staring at 404s with no explanation.
  if (excluded > 0) {
    console.log(
      `next-bun-compile: PPR shell endpoint withholding ${excluded} route(s) covered by proxy/routing rules — their response head belongs to the origin`
    );
  }
  return routes;
}

/* ---------------------------------------------------------------- *
 * start()
 * ---------------------------------------------------------------- */

/** Host this server can dial itself on, given the address it binds. */
function selfOrigin(hostname) {
  if (!hostname || hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]")
    return "localhost";
  // Bare IPv6 needs brackets to survive URL parsing.
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

async function start(opts) {
  const {
    assetMap,
    gzippedAssets,
    nextConfig,
    port,
    hostname,
    keepAliveTimeout,
    tier1 = [],
    staticPages = [],
    baseDir,
    enableL1 = true,
    shellGuards = [],
  } = opts;
  if (gzippedAssets) gzippedAssetSet = gzippedAssets;

  // `next start` sets this on its listening handler; we replace that listener,
  // so nothing did. Unset, a fetch action that redirect()s falls back to the
  // request's initURL — `${x-forwarded-proto}://${hostname}:${port}` — which
  // behind any TLS-terminating gateway is https://0.0.0.0:PORT. This listener
  // terminates no TLS, so the self-fetch for the redirect target's RSC payload
  // failed the handshake, the action returned an empty body, and the client
  // fell back to a full page reload (blank screen until the document lands).
  // Always http, and 0.0.0.0/:: means "every interface" — not an address to
  // dial back on.
  if (process.env.__NEXT_PRIVATE_ORIGIN === undefined) {
    process.env.__NEXT_PRIVATE_ORIGIN = `http://${selfOrigin(hostname)}:${port}`;
  }

  // Next boots lazily on the first Tier-3 request; static tiers serve
  // immediately. This keeps time-to-first-static-byte low while Next's
  // module graph loads.
  // Next is loaded from the extracted traced tree via computed paths —
  // the bundler never follows these, so no framework code is compiled
  // into the binary and nothing is carried twice.
  const nextModule = (rel) =>
    require(path.join(baseDir, ".next/node_modules/next", rel));

  let handlerPromise = null;
  const getHandlerOnce = () => {
    if (!handlerPromise) {
      handlerPromise = (async () => {
        // The exact stack `next start`/standalone server.js runs — same
        // compression, error pages, and header handling — minus its HTTP
        // listener. Config comes from __NEXT_PRIVATE_STANDALONE_CONFIG.
        const { initialize } = nextModule("dist/server/lib/router-server.js");
        const { requestHandler } = await initialize({
          dir: baseDir,
          port,
          dev: false,
          hostname,
          keepAliveTimeout,
          onDevServerCleanup: undefined,
        });
        // Must run before the first request is handled (invalidations can
        // only originate from Next code paths, so none can flow earlier),
        // and can't run before initialize(): the wrapper module's import
        // chain touches AsyncLocalStorage at load time and throws until
        // Next has set up its server environment.
        installInvalidationHook();
        return requestHandler;
      })();
    }
    return handlerPromise;
  };
  let handler = null;
  const bridge = createBridge(() => handler);
  const bridgeLazy = async (req, server) => {
    if (!handler) handler = await getHandlerOnce();
    return bridge(req, server);
  };

  /* ------------------------------------------------------------ *
   * L1 response cache for ISR / cache-component pages.
   *
   * Next's own response cache answers these at handler-stack speed;
   * this memory tier answers them at route-dispatch speed. Semantics
   * are preserved because every way an entry can change flows through
   * the patched cache handler (set on regeneration, revalidateTag on
   * on-demand invalidation) and drops the L1 entry, and the TTL never
   * exceeds the response's own s-maxage.
   * ------------------------------------------------------------ */
  const L1_MAX_ENTRIES = 256;
  const l1 = new Map(); // key → { body, status, headers, expires }
  const l1DropPath = (p) => {
    for (const key of l1.keys()) {
      if (key.startsWith(p + "|")) l1.delete(key);
    }
  };
  let l1Enabled = enableL1; // also turned off if the hook can't install
  const l1Cacheable = (req) => {
    if (!l1Enabled) return null;
    if (req.method !== "GET") return null;
    if (req.headers.has("range")) return null;
    // Per-request RSC render state produces per-request payloads.
    if (
      req.headers.has("next-router-state-tree") ||
      req.headers.has("next-router-prefetch") ||
      req.headers.has("next-router-segment-prefetch")
    ) {
      return null;
    }
    const cookie = req.headers.get("cookie");
    if (cookie && cookie.includes("__prerender_bypass")) return null;
    const url = new URL(req.url);
    const rsc = req.headers.has("rsc") || url.searchParams.has("_rsc");
    return `${url.pathname}|${rsc ? "r" : "h"}|${acceptsGzip(req) ? "z" : "i"}`;
  };
  const l1Ttl = (res) => {
    if (res.status !== 200) return 0;
    if (res.headers.get("x-nextjs-cache") !== "HIT") return 0;
    const cc = res.headers.get("cache-control") ?? "";
    const m = cc.match(/s-maxage=(\d+)/);
    if (!m || /private|no-store|no-cache/.test(cc)) return 0;
    return Math.min(Number(m[1]), 31536000) * 1000;
  };

  const fetchWithL1 = async (req, server) => {
    const key = l1Cacheable(req);
    if (key) {
      const hit = l1.get(key);
      if (hit) {
        if (hit.expires > Date.now()) {
          return new Response(hit.body, {
            status: hit.status,
            headers: hit.headers,
          });
        }
        l1.delete(key);
      }
    }
    const res = await bridgeLazy(req, server);
    if (!key || res.body == null) return res;
    const ttl = l1Ttl(res);
    if (ttl === 0) return res;
    const [toClient, toCache] = res.body.tee();
    // Buffer the copy off the hot path; store only once complete.
    new Response(toCache)
      .arrayBuffer()
      .then((buf) => {
        if (l1.size >= L1_MAX_ENTRIES) {
          l1.delete(l1.keys().next().value); // drop oldest insertion
        }
        const headers = new Headers(res.headers);
        headers.delete("transfer-encoding");
        headers.set("content-length", String(buf.byteLength));
        l1.set(key, {
          body: new Uint8Array(buf),
          status: res.status,
          headers,
          expires: Date.now() + ttl,
        });
      })
      .catch(() => {});
    return new Response(toClient, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  const [tier1Routes, tier2Routes] = await Promise.all([
    buildTier1Routes(tier1, assetMap, bridgeLazy),
    buildTier2Routes(
      staticPages,
      assetMap,
      bridgeLazy,
      nextConfig?.deploymentId
    ),
  ]);

  const routes = {
    ...tier1Routes,
    ...tier2Routes,
    ...buildShellRoutes(baseDir, shellGuards),
  };
  const tier2Paths = new Set(Object.keys(tier2Routes));

  // Bun's idleTimeout is in seconds, capped at 255. Default to the max —
  // the Node server this replaces had no idle deadline, and slow streamed
  // renders must not be cut off mid-response.
  const idleTimeout = Number.isFinite(keepAliveTimeout)
    ? Math.min(255, Math.ceil(keepAliveTimeout / 1000))
    : 255;
  const serveOptions = () => ({
    port,
    hostname,
    ...(idleTimeout !== undefined && { idleTimeout }),
    routes: { ...routes },
    fetch: fetchWithL1,
    error(err) {
      console.error(err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  const server = Bun.serve(serveOptions());

  // Invalidation: patch the IncrementalCache wrapper in-process — every
  // revalidateTag/revalidatePath and fresh cache write flows through it
  // before it delegates to whichever handler is configured (the default
  // filesystem one or a custom `cacheHandler`), so the observation is
  // handler-agnostic. A Tier-2 page whose build-time tag set matches gets
  // dropped from the route table so the next request re-renders through
  // Next. The config is untouched, so Next's in-memory LRU stays enabled.
  const tagIndex = new Map(); // tag → Set<pathname>
  for (const spec of staticPages) {
    for (const tag of spec.tags || []) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
      tagIndex.get(tag).add(spec.path);
    }
  }
  const dropPage = (p) => {
    if (!tier2Paths.has(p)) return false;
    tier2Paths.delete(p);
    delete routes[p];
    console.log(
      `next-bun-compile: ${p} revalidated — serving via Next from now on`
    );
    return true;
  };
  // The shell endpoint is NOT dropped on revalidation. A PPR route's
  // postponed pair is code-shaped, not data-shaped: it encodes where the
  // Suspense holes are, which only a new build changes — and a new build
  // is a new process that re-reads the pair at boot. Within a process the
  // boot-frozen shell stays valid and its holes resume fresh per request.
  // These routes never regenerate at runtime (revalidate:false, no set()),
  // so dropping the entry left it dropped until reboot — forcing an edge
  // worker onto origin RTT for the life of the process.
  const onInvalidate = (tags, pathnameKey) => {
    let changed = false;
    if (typeof pathnameKey === "string") {
      changed = dropPage(pathnameKey) || changed;
      l1DropPath(pathnameKey); // regeneration → refresh on next request
    }
    for (const tag of Array.isArray(tags) ? tags : tags ? [tags] : []) {
      if (typeof tag !== "string") continue;
      // L1 entries don't carry tag metadata (stripped upstream); a tag
      // revalidation clears the whole L1 — it refills request by request.
      l1.clear();
      for (const p of tagIndex.get(tag) ?? []) changed = dropPage(p) || changed;
      if (tag.startsWith("_N_T_")) {
        const p = tag.slice("_N_T_".length);
        const norm = p === "/index" ? "/" : p;
        changed = dropPage(norm) || changed;
      }
    }
    if (changed) server.reload(serveOptions());
  };
  const installInvalidationHook = () => {
    try {
      const mod = nextModule("dist/server/lib/incremental-cache/index.js");
      const IncCache = mod.IncrementalCache;
      // The wrapper's set() sees the pathname before normalizePagePath
      // (the concrete handler sees it after) — "/" not "/index"; spec
      // paths and the _N_T_ branch already use the "/" form.
      const normKey = (k) => (k === "/index" ? "/" : k);
      // Next owns the instance, so the shell endpoint borrows it here.
      // get() is the hook that matters: a pod which only ever reads a
      // shared cache handler never calls set(), and its endpoint would
      // otherwise never see a pair regenerated on another pod.
      const origGet = IncCache.prototype.get;
      IncCache.prototype.get = function (...args) {
        incrementalCache = this;
        return origGet.apply(this, args);
      };
      const origRevalidateTag = IncCache.prototype.revalidateTag;
      IncCache.prototype.revalidateTag = function (...args) {
        incrementalCache = this;
        try {
          onInvalidate(args[0], null);
        } catch {}
        return origRevalidateTag.apply(this, args);
      };
      const origSet = IncCache.prototype.set;
      IncCache.prototype.set = function (key, ...rest) {
        incrementalCache = this;
        try {
          onInvalidate(null, typeof key === "string" ? normKey(key) : key);
        } catch {}
        return origSet.apply(this, [key, ...rest]);
      };
    } catch (err) {
      // Fail safe: without revalidation events the memory tiers could go
      // stale — hand everything back to Next.
      console.warn(
        "next-bun-compile: cache handler patch failed, memory page tiers disabled:",
        err && err.message
      );
      l1Enabled = false;
      const shellKeys = Object.keys(routes).filter((k) =>
        k.startsWith(SHELL_PREFIX)
      );
      for (const k of shellKeys) delete routes[k];
      if (tier2Paths.size > 0 || shellKeys.length > 0) {
        for (const p of Array.from(tier2Paths)) {
          tier2Paths.delete(p);
          delete routes[p];
        }
        server.reload(serveOptions());
      }
    }
  };

  const shutdown = async () => {
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`   ▲ Next.js (next-bun-compile)`);
  console.log(`   - Local:    http://localhost:${port}`);
  console.log(
    `   - Static:   ${tier1.length} assets, ${tier2Paths.size} prerendered pages served from memory`
  );
  return server;
}

module.exports = { start };
// Test-only escape hatch for unit-testing the fetch→node bridge. Not a public
// API — may change or disappear in any release without notice.
module.exports._internal = {
  createBridge,
  NodeResponseShim,
  makeNodeRequest,
  selfOrigin,
  shellGuard,
};
