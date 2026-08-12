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
