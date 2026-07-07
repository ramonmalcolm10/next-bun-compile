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
      try {
        this._controller.error(err ?? new Error("aborted"));
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

async function loadBytes(assetMap, key) {
  const ref = assetMap.get(key);
  if (ref == null) return null;
  return await Bun.file(ref).bytes();
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
 * start()
 * ---------------------------------------------------------------- */

async function start(opts) {
  const {
    assetMap,
    nextConfig,
    port,
    hostname,
    keepAliveTimeout,
    tier1 = [],
    staticPages = [],
    baseDir,
    enableL1 = true,
  } = opts;

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

  const routes = { ...tier1Routes, ...tier2Routes };
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

  // Invalidation: patch the default filesystem cache handler in-process —
  // every revalidateTag/revalidatePath and fresh cache write flows through
  // it. A Tier-2 page whose build-time tag set matches gets dropped from
  // the route table so the next request re-renders through Next. The
  // config is untouched, so Next's in-memory LRU stays enabled.
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
  const onInvalidate = (tags, pathnameKey) => {
    let dropped = false;
    if (typeof pathnameKey === "string") {
      dropped = dropPage(pathnameKey) || dropped;
      l1DropPath(pathnameKey); // regeneration → refresh on next request
    }
    for (const tag of Array.isArray(tags) ? tags : tags ? [tags] : []) {
      if (typeof tag !== "string") continue;
      // L1 entries don't carry tag metadata (stripped upstream); a tag
      // revalidation clears the whole L1 — it refills request by request.
      l1.clear();
      for (const p of tagIndex.get(tag) ?? []) dropped = dropPage(p) || dropped;
      if (tag.startsWith("_N_T_")) {
        const p = tag.slice("_N_T_".length);
        dropped = dropPage(p === "/index" ? "/" : p) || dropped;
      }
    }
    if (dropped) server.reload(serveOptions());
  };
  try {
    const mod = nextModule(
      "dist/server/lib/incremental-cache/file-system-cache.js"
    );
    const FsCache = mod.default || mod;
    const origRevalidateTag = FsCache.prototype.revalidateTag;
    FsCache.prototype.revalidateTag = function (...args) {
      try {
        onInvalidate(args[0], null);
      } catch {}
      return origRevalidateTag.apply(this, args);
    };
    const origSet = FsCache.prototype.set;
    FsCache.prototype.set = function (key, ...rest) {
      try {
        onInvalidate(null, key);
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
    if (tier2Paths.size > 0) {
      for (const p of Array.from(tier2Paths)) {
        tier2Paths.delete(p);
        delete routes[p];
      }
      server.reload(serveOptions());
    }
  }

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
