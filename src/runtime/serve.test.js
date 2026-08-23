/**
 * Regression: a client disconnect mid-stream must tear the response down
 * cleanly. The bridge used to error() the response body's controller with
 * `new Error("aborted")` on abort, which surfaced every routine disconnect
 * (probes, gateways, users navigating away) as an
 * `unhandledRejection: Error: aborted` in Bun's response pump — at
 * production volume, a log-noise firehose.
 */
const { test, expect } = require("bun:test");
const { _internal } = require("./serve.js");

/** Bridge a streaming handler, return { response, res, timer }. */
async function streamingRequest(signal) {
  let res;
  let timer;
  const handler = (nodeReq, nodeRes) => {
    res = nodeRes;
    nodeRes.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    nodeRes.write("<shell>");
    // keep rendering, like streamed SSR / PPR resume mid-flight
    timer = setInterval(() => {
      nodeRes.write("<chunk>");
    }, 5);
  };
  const bridge = _internal.createBridge(() => handler);
  const request = new Request("http://localhost/ssr", { signal });
  const response = await bridge(request, undefined);
  return { response, getRes: () => res, stopWriting: () => clearInterval(timer) };
}

test("client abort mid-stream ends the response body cleanly (no Error: aborted)", async () => {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);

  const ac = new AbortController();
  const { response, getRes, stopWriting } = await streamingRequest(ac.signal);
  try {
    // Bun's pump: read the streaming body
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("<shell>");

    // the client hangs up mid-stream
    ac.abort();
    expect(getRes().req.aborted).toBe(true);

    // The pump keeps reading. It must see a clean end-of-stream — an
    // errored stream here is exactly the unhandledRejection from prod.
    let sawError = null;
    let done = false;
    try {
      for (let i = 0; i < 10 && !done; i++) {
        ({ done } = await reader.read());
      }
    } catch (err) {
      sawError = err;
    }
    expect(sawError).toBeNull();
    expect(done).toBe(true);

    // and nothing may have leaked as a process-level unhandled rejection
    await new Promise((r) => setTimeout(r, 20));
    expect(rejections).toHaveLength(0);
  } finally {
    stopWriting();
    process.off("unhandledRejection", onRejection);
  }
});

test("selfOrigin maps bind addresses to a dialable host", () => {
  // A wildcard bind is "every interface", not an address to connect back to —
  // and https://0.0.0.0:3000 is exactly what broke action redirects in prod.
  for (const wildcard of ["0.0.0.0", "::", "[::]", "", undefined]) {
    expect(_internal.selfOrigin(wildcard)).toBe("localhost");
  }
  expect(_internal.selfOrigin("127.0.0.1")).toBe("127.0.0.1");
  expect(_internal.selfOrigin("example.internal")).toBe("example.internal");
  // Bare IPv6 needs brackets or the URL parser reads the last colon as a port.
  expect(_internal.selfOrigin("::1")).toBe("[::1]");
  expect(_internal.selfOrigin("[::1]")).toBe("[::1]");
});

test("shellGuard refuses covered routes and fails closed", () => {
  // The shape Next actually emits for `matcher: ["/agent/:path*"]`.
  const covered = _internal.shellGuard(["^/agent(?:/(.*))?$"]);
  expect(covered("/agent")).toBe(true);
  expect(covered("/agent/integrations/shopify")).toBe(true);
  // Not a prefix match: /agent-account is its own route.
  expect(covered("/agent-account")).toBe(false);
  expect(covered("/")).toBe(false);

  // No rules means nothing is withheld — the endpoint's prior behavior.
  expect(_internal.shellGuard([])("/agent")).toBe(false);

  // A source this engine can't parse must withhold everything rather than
  // silently publish a shell for a route something upstream guards.
  const broken = _internal.shellGuard(["(unclosed"]);
  expect(broken("/anything")).toBe(true);
  // ...and one bad rule must not disarm the good ones alongside it.
  expect(_internal.shellGuard(["(unclosed", "^/ok$"])("/elsewhere")).toBe(true);
});

test("handler writes racing a client abort do not error the response", async () => {
  const ac = new AbortController();
  const { getRes, stopWriting } = await streamingRequest(ac.signal);
  try {
    const res = getRes();
    const errors = [];
    res.on("error", (e) => errors.push(e));

    ac.abort();
    // Next's render pipeline doesn't stop on a dime — writes keep landing
    res.write("<late-1>");
    res.write("<late-2>");
    res.end();

    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(0);
  } finally {
    stopWriting();
  }
});

test("memory pressure releases the L1 so the OS doesn't kill the process", () => {
  const { EventEmitter } = require("node:events");
  // Stand-in for `process` so the assertions can't be satisfied by, or
  // interfere with, a listener the test runner itself installed.
  const target = new EventEmitter();
  const cache = new Map([
    ["/a|h|z", { body: new Uint8Array(1024) }],
    ["/b|r|z", { body: new Uint8Array(1024) }],
  ]);

  let now = 1_000_000;
  const unbind = _internal.bindMemoryPressure(cache, target, {
    cooldownMs: 30_000,
    now: () => now,
  });

  // macOS reports "warning" before "critical"; Linux and Windows only ever
  // send "critical". By the time the one signal Linux gives you arrives it is
  // already urgent, so every level has to drop — the cooldown, not the level,
  // is what keeps the handler from thrashing.
  target.emit("memoryPressure", "warning");
  expect(cache.size).toBe(0);

  now += 30_000;
  cache.set("/c|h|z", { body: new Uint8Array(1024) });
  target.emit("memoryPressure", "critical");
  expect(cache.size).toBe(0);

  now += 30_000;

  // An empty cache under pressure is a no-op, not an error.
  expect(() => target.emit("memoryPressure", "critical")).not.toThrow();

  // start() can run more than once in-process (the test suite does exactly
  // this); a bind that outlives its cache is a leaked listener holding a
  // dead Map alive, which is the opposite of the point.
  unbind();
  cache.set("/d|h|z", { body: new Uint8Array(1024) });
  target.emit("memoryPressure", "critical");
  expect(cache.size).toBe(1);
  expect(target.listenerCount("memoryPressure")).toBe(0);
});

/** Entry shaped like the L1 stores them; only `body` is size-accounted. */
const l1Entry = (bytes) => ({
  body: new Uint8Array(bytes),
  status: 200,
  headers: new Headers(),
  expires: Date.now() + 60_000,
});

test("L1 is bounded by bytes, not just entry count", () => {
  // The entry-count cap alone says nothing about memory: 256 entries is 25MB
  // of 100KB pages but 512MB of 2MB pages, and nothing in the tier notices.
  const store = _internal.createL1Store({
    maxBytes: 1024 * 1024,
    maxEntries: 256,
  });

  for (let i = 0; i < 32; i++) store.set(`/p${i}|h|z`, l1Entry(100 * 1024));

  expect(store.bytes).toBeLessThanOrEqual(1024 * 1024);
  expect(store.size).toBeLessThan(32); // oldest were evicted to make room
  // Eviction is oldest-insertion-first, so the newest survivor is still here.
  expect(store.get("/p31|h|z")).toBeDefined();
  expect(store.get("/p0|h|z")).toBeUndefined();
});

test("L1 keeps the entry cap for many small responses", () => {
  // A byte budget alone lets tiny responses pile up until the per-entry
  // overhead (key string, Headers object, Map slot) dwarfs the bodies.
  const store = _internal.createL1Store({ maxBytes: 64 * 1024 * 1024, maxEntries: 8 });
  for (let i = 0; i < 20; i++) store.set(`/s${i}|h|z`, l1Entry(64));
  expect(store.size).toBe(8);
});

test("L1 byte accounting survives delete, replace, dropPath and clear", () => {
  // A counter that drifts is worse than no counter: it silently converts the
  // ceiling into either a permanent stall or an unbounded cache.
  const store = _internal.createL1Store({ maxBytes: 1024 * 1024, maxEntries: 256 });

  store.set("/a|h|z", l1Entry(1000));
  store.set("/a|r|z", l1Entry(2000));
  expect(store.bytes).toBe(3000);

  // Replacing a key must not double-count the old body.
  store.set("/a|h|z", l1Entry(500));
  expect(store.bytes).toBe(2500);

  store.delete("/a|r|z");
  expect(store.bytes).toBe(500);

  // Deleting something absent must not move the counter.
  store.delete("/nope|h|z");
  expect(store.bytes).toBe(500);

  store.set("/b|h|z", l1Entry(700));
  store.dropPath("/a"); // regeneration drops every variant of one path
  expect(store.size).toBe(1);
  expect(store.bytes).toBe(700);

  store.clear();
  expect(store.bytes).toBe(0);
  expect(store.size).toBe(0);
});

test("L1 refuses an entry larger than the whole budget", () => {
  // Admitting it would evict the entire tier and then sit there alone —
  // strictly worse than serving that one route from origin.
  const store = _internal.createL1Store({ maxBytes: 1024 * 1024, maxEntries: 256 });
  store.set("/keep|h|z", l1Entry(1000));

  expect(store.set("/huge|h|z", l1Entry(2 * 1024 * 1024))).toBe(false);
  expect(store.get("/huge|h|z")).toBeUndefined();
  expect(store.get("/keep|h|z")).toBeDefined();
  expect(store.bytes).toBe(1000);
});

test("memory pressure drops the L1 at most once per cooldown", () => {
  const { EventEmitter } = require("node:events");
  const target = new EventEmitter();
  const store = _internal.createL1Store({ maxBytes: 1024 * 1024, maxEntries: 256 });
  let now = 1_000_000;

  _internal.bindMemoryPressure(store, target, { cooldownMs: 30_000, now: () => now });

  store.set("/a|h|z", l1Entry(1000));
  target.emit("memoryPressure", "critical");
  expect(store.size).toBe(0);

  // Clearing frees heap but not RSS, and the refill costs fresh pages —
  // so a PSI trigger firing in a tight loop would ratchet memory upward.
  // Inside the cooldown the tier has to be left alone to refill.
  store.set("/b|h|z", l1Entry(1000));
  target.emit("memoryPressure", "critical");
  target.emit("memoryPressure", "critical");
  expect(store.size).toBe(1);

  now += 30_000;
  target.emit("memoryPressure", "critical");
  expect(store.size).toBe(0);
});

test("L1 budget scales to the container's memory limit", () => {
  const MB = 1024 * 1024;
  const budget = (limit, env = {}) =>
    _internal.resolveL1Budget({ env, readCgroupLimit: () => limit });

  // A fixed default is wrong in both directions: 64MB is a quarter of a
  // 256MB pod's entire budget, and a rounding error on a 4GB one.
  expect(budget(512 * MB)).toBe(64 * MB); // 1/8
  expect(budget(256 * MB)).toBe(32 * MB);
  expect(budget(4096 * MB)).toBe(512 * MB);

  // Unlimited (cgroup v2 "max", or v1's sentinel) and "not in a container"
  // all mean the same thing: nothing to scale against, so take the default.
  expect(budget(null)).toBe(64 * MB);

  // Floor: below this the tier holds too little to be worth the bookkeeping,
  // and evicting on nearly every store would be worse than being off.
  expect(budget(32 * MB)).toBe(8 * MB);
  // Ceiling: past this we're hoarding, not caching.
  expect(budget(64 * 1024 * MB)).toBe(512 * MB);

  // An explicit value is the operator's call and overrides the heuristic.
  expect(budget(256 * MB, { NBC_L1_MAX_BYTES: String(100 * MB) })).toBe(100 * MB);
  // ...including a deliberately tiny one; only the derived path is clamped.
  expect(budget(512 * MB, { NBC_L1_MAX_BYTES: "1024" })).toBe(1024);

  // Garbage must not become NaN and disable the ceiling entirely.
  for (const bad of ["", "lots", "-5", "0", "1e9x"]) {
    expect(budget(512 * MB, { NBC_L1_MAX_BYTES: bad })).toBe(64 * MB);
  }
});

test("cgroup limit parsing handles v1, v2 and unlimited", () => {
  const MB = 1024 * 1024;
  const read = (files) =>
    _internal.readCgroupLimit((p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    });

  // cgroup v2 — what Kubernetes gives you on any current node.
  expect(read({ "/sys/fs/cgroup/memory.max": "268435456\n" })).toBe(256 * MB);
  // v2 with no limit set.
  expect(read({ "/sys/fs/cgroup/memory.max": "max\n" })).toBeNull();
  // cgroup v1.
  expect(read({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "536870912\n" })).toBe(512 * MB);
  // v1 unlimited is a sentinel near 2^63, not a word — treat it as no limit.
  expect(read({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" })).toBeNull();
  // Not in a container at all (macOS, bare metal).
  expect(read({})).toBeNull();
});

test("cgroup read works against the real filesystem", () => {
  // The mocked tests above cover parsing; this one covers the thing a mock
  // can't — that the paths and file format are what this code assumes on a
  // real kernel. It is the only assertion here with a platform dependency,
  // so it asserts a range rather than a value: CI's root cgroup is usually
  // unlimited, a limited container is not, and both are correct.
  const limit = _internal.readCgroupLimit(); // must not throw anywhere
  if (process.platform !== "linux") {
    expect(limit).toBeNull(); // no cgroups off Linux, ever
    return;
  }
  expect(limit === null || (Number.isFinite(limit) && limit > 0)).toBe(true);

  // And whatever it reports has to produce a usable ceiling.
  const budget = _internal.resolveL1Budget({ env: {} });
  expect(budget).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  expect(budget).toBeLessThanOrEqual(512 * 1024 * 1024);
});
