import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

function json(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, name), "utf8"));
}

describe("evaluation tooling stays out of the published package", () => {
  it("is not listed in the package files", () => {
    const files: string[] = json("package.json").files;
    expect(files.length).toBeGreaterThan(0);
    for (const entry of files) {
      expect(entry.replace(/^\.\//, "")).not.toMatch(/^eval(\/|$)/);
    }
  });

  it("is not compiled into dist", () => {
    const tsconfig = json("tsconfig.json");
    expect(tsconfig.compilerOptions.rootDir).toBe("./src");
    expect(tsconfig.include.join(" ")).not.toContain("eval");
  });

  it("is typechecked and format-checked with the tests", () => {
    expect(json("tsconfig.test.json").include).toContain("eval/**/*");
    const scripts = json("package.json").scripts;
    expect(scripts["format:check"]).toContain("eval/**/*.ts");
    expect(scripts.eval).toContain("eval/cli.ts");
  });
});
