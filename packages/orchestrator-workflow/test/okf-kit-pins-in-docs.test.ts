import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

// An okf-kit invocation in `npx` form has to name the release it installs:
// the placeholder form (`@<pinned-version>`), an environment value
// (`@$OKF_KIT_VERSION` or `@${OKF_KIT_VERSION}`) or a concrete version.
// An unpinned `npx okf-kit` floats to whatever okf-kit publishes next, and
// a dist-tag (`@latest`) floats too; the worked example in
// docs/verification-sets.md used to carry the unpinned form, and the CI
// reference (assets/skill/references/bundle-gate-in-ci.md) is what pins.

/** An okf-kit invocation in `npx` form: shell form or JSON argv form. */
const SHELL_FORM =
  /(?<![\w./-])npx\s+(?:-y\s+)?["']?okf-kit(@[^\s"'`,()[\]]*)?/g;
const ARGV_FORM = /"npx"\s*,\s*(?:"-y"\s*,\s*)?"okf-kit(@[^"\s]*)?"/g;

/** The `@` suffixes that name a fixed release (or a placeholder for one). */
const ACCEPTED_PIN =
  /^@(?:<[^"'>]+>|\$\{?[A-Za-z_]\w*\}?|\d+(?:\.\d+)*(?:[-+][\w.-]+)?)$/;

interface OkfKitSite {
  file: string;
  line: number;
  /** The text between `okf-kit` and the token end; "" when unpinned. */
  pin: string;
  form: "shell" | "argv";
}

function findSites(content: string, file: string): OkfKitSite[] {
  const sites: OkfKitSite[] = [];
  content.split("\n").forEach((line, index) => {
    for (const [form, pattern] of [
      ["shell", SHELL_FORM],
      ["argv", ARGV_FORM],
    ] as const) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        sites.push({ file, line: index + 1, pin: match[1] ?? "", form });
      }
    }
  });
  return sites;
}

/** README.md, INSTALL-AGENT.md, every Markdown file directly under docs/
 * (the docs/okf/ bundle is exempt: its prose is knowledge, not install
 * instructions) and every Markdown file under assets/. */
function scannedFiles(): string[] {
  const files = ["README.md", "INSTALL-AGENT.md"];
  const walk = (dir: string, recurse: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recurse) walk(full, recurse);
      } else if (entry.name.endsWith(".md")) {
        files.push(relative(PACKAGE_DIR, full));
      }
    }
  };
  walk(join(PACKAGE_DIR, "docs"), false); // false: docs/okf/ is exempt
  walk(join(PACKAGE_DIR, "assets"), true);
  return files.sort();
}

describe("no kit doc or asset runs okf-kit through npx unpinned", () => {
  const sites = scannedFiles().flatMap((rel) =>
    findSites(readFileSync(join(PACKAGE_DIR, rel), "utf8"), rel),
  );

  it("scans README.md, INSTALL-AGENT.md, docs/*.md and assets/**/*.md", () => {
    const files = scannedFiles();
    for (const expected of [
      "README.md",
      "INSTALL-AGENT.md",
      "docs/verification-sets.md",
      "docs/architecture.md",
      "assets/skill/references/bundle-gate-in-ci.md",
    ]) {
      expect(files).toContain(expected);
    }
    expect(files.filter((f) => f.startsWith("docs/okf/"))).toEqual([]);
  });

  it("finds npx-form sites in both the shell and the JSON argv form (sanity: not vacuous)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(sites.some((site) => site.form === "shell")).toBe(true);
    expect(sites.some((site) => site.form === "argv")).toBe(true);
  });

  it("every npx-form okf-kit invocation in the scanned files carries a pin", () => {
    const unpinned = sites.filter((site) => !ACCEPTED_PIN.test(site.pin));
    expect(
      unpinned.map(
        (site) => `${site.file}:${site.line} ${site.pin || "(none)"}`,
      ),
    ).toEqual([]);
  });
});

describe("the npx-form okf-kit matcher", () => {
  it("reports unpinned shell-form invocations", () => {
    expect(findSites("npx okf-kit check docs/okf", "fixture.md")).toEqual([
      { file: "fixture.md", line: 1, pin: "", form: "shell" },
    ]);
    expect(
      findSites("run: npx -y okf-kit check docs/okf", "fixture.md"),
    ).toEqual([{ file: "fixture.md", line: 1, pin: "", form: "shell" }]);
  });

  it("reports unpinned JSON argv invocations and finds the pinned argv form", () => {
    expect(
      findSites(
        '"argv": ["npx", "okf-kit", "check", "docs/okf"]',
        "fixture.md",
      ),
    ).toEqual([{ file: "fixture.md", line: 1, pin: "", form: "argv" }]);
    expect(
      findSites(
        '"argv": ["npx", "-y", "okf-kit@<pinned-version>", "check", "docs/okf"]',
        "fixture.md",
      ),
    ).toEqual([
      {
        file: "fixture.md",
        line: 1,
        pin: "@<pinned-version>",
        form: "argv",
      },
    ]);
  });

  it("unpinned fixtures of both forms fail the pin requirement", () => {
    const unpinned = [
      "npx okf-kit check docs/okf",
      "npx -y okf-kit check docs/okf",
      '["npx", "okf-kit", "check", "docs/okf"]',
      "npx -y okf-kit@latest check docs/okf",
    ]
      .flatMap((text) => findSites(text, "fixture.md"))
      .filter((site) => !ACCEPTED_PIN.test(site.pin));
    expect(unpinned).toHaveLength(4);
  });

  it("accepts the placeholder, environment-value and concrete-version pins", () => {
    for (const pin of [
      "@<pinned-version>",
      "@$OKF_KIT_VERSION",
      "@${OKF_KIT_VERSION}",
      "@0.23.0",
    ]) {
      expect(pin).toMatch(ACCEPTED_PIN);
    }
    for (const pin of ["", "@latest", "@next", "@1.x", "@<pinned-version>,"]) {
      expect(pin).not.toMatch(ACCEPTED_PIN);
    }
  });

  it("counts only okf-kit and only the npx form", () => {
    expect(findSites("npx orchestrator-workflow@0.53.0 init", "f")).toEqual([]);
    expect(
      findSites("run `okf-kit check` from the installed binary", "f"),
    ).toEqual([]);
    expect(findSites("when npx or the registry is unavailable", "f")).toEqual(
      [],
    );
  });
});
