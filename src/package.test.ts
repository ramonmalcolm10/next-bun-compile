import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")
) as { scripts?: Record<string, string> };

describe("package.json lifecycle scripts", () => {
  // npm, pnpm and bun run these in every consumer's project when the
  // package is installed from the registry. The repo's own dev setup (the
  // self-link the examples resolve through) belongs in `prepare`, which a
  // registry install never runs.
  test("nothing runs in a consumer's install", () => {
    for (const hook of ["preinstall", "install", "postinstall"]) {
      expect(pkg.scripts?.[hook]).toBeUndefined();
    }
  });

  test("the self-link for the repo's own workspaces runs on prepare", () => {
    expect(pkg.scripts?.prepare).toContain("node_modules/next-bun-compile");
  });
});
