import { describe, test, expect, afterEach } from "bun:test";
import { resolveExtraArgs, resolveOutfile } from "./build.js";

const original = process.env.NBC_BUILD_ARGS;

afterEach(() => {
  if (original === undefined) delete process.env.NBC_BUILD_ARGS;
  else process.env.NBC_BUILD_ARGS = original;
});

describe("resolveExtraArgs", () => {
  test("no options and no env yields no extra args", () => {
    delete process.env.NBC_BUILD_ARGS;
    expect(resolveExtraArgs({})).toEqual([]);
  });

  test("explicit extraArgs pass through", () => {
    delete process.env.NBC_BUILD_ARGS;
    expect(resolveExtraArgs({ extraArgs: ["--bytecode"] })).toEqual([
      "--bytecode",
    ]);
  });

  // The build adapter's onBuildComplete has no argv, so env is the only way
  // in for adapter-driven builds — the same contract as NBC_TARGET/NBC_OUT.
  test("NBC_BUILD_ARGS reaches an adapter build that passes no options", () => {
    process.env.NBC_BUILD_ARGS = "--bytecode";
    expect(resolveExtraArgs({})).toEqual(["--bytecode"]);
  });

  test("whitespace-separated env args are split, extra whitespace ignored", () => {
    process.env.NBC_BUILD_ARGS = "  --bytecode   --banner=x ";
    expect(resolveExtraArgs({})).toEqual(["--bytecode", "--banner=x"]);
  });

  test("an empty or whitespace-only env value contributes nothing", () => {
    process.env.NBC_BUILD_ARGS = "   ";
    expect(resolveExtraArgs({})).toEqual([]);
  });

  test("explicit options win position over env so env can override them", () => {
    process.env.NBC_BUILD_ARGS = "--minify=false";
    expect(resolveExtraArgs({ extraArgs: ["--bytecode"] })).toEqual([
      "--bytecode",
      "--minify=false",
    ]);
  });
});

describe("resolveOutfile", () => {
  const saved = { out: process.env.NBC_OUT, bin: process.env.NBC_BINARY };
  afterEach(() => {
    for (const [k, v] of [["NBC_OUT", saved.out], ["NBC_BINARY", saved.bin]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("defaults to dist/app, not the project root", () => {
    // v2 moved it off the root: a 78MB `server` sitting where source lives
    // is easy to commit by accident, and `server` collides with framework
    // conventions (Nitro treats server/ as a convention dir).
    delete process.env.NBC_OUT;
    delete process.env.NBC_BINARY;
    expect(resolveOutfile("/proj", {})).toBe("/proj/dist/app");
  });

  test("explicit options win over the default", () => {
    expect(resolveOutfile("/proj", { out: "build", binaryName: "srv" })).toBe(
      "/proj/build/srv"
    );
  });

  test("env supplies the path for adapter flows with no argv", () => {
    process.env.NBC_OUT = "out";
    process.env.NBC_BINARY = "bin";
    expect(resolveOutfile("/proj", {})).toBe("/proj/out/bin");
  });

  test("explicit options beat env", () => {
    process.env.NBC_OUT = "env-dir";
    process.env.NBC_BINARY = "env-bin";
    expect(resolveOutfile("/proj", { out: "opt", binaryName: "opt-bin" })).toBe(
      "/proj/opt/opt-bin"
    );
  });

  test("an absolute out dir is used as-is", () => {
    expect(resolveOutfile("/proj", { out: "/somewhere/else" })).toBe(
      "/somewhere/else/app"
    );
  });

  test("the v1 location is still reachable", () => {
    // Documented escape hatch for anyone whose deploy scripts expect it.
    expect(resolveOutfile("/proj", { out: ".", binaryName: "server" })).toBe(
      "/proj/server"
    );
  });
});
