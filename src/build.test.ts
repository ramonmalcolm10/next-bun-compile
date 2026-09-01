import { describe, test, expect, afterEach } from "bun:test";
import { resolveExtraArgs } from "./build.js";

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
