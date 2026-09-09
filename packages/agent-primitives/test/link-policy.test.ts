import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkRelPath, planLinks } from "../src/probe/link-policy.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-link-policy-test-"),
  );
  tmpDirs.push(dir);
  // Realpath'd: every root the policy is given is already resolved by
  // `beginWorktree`, and os.tmpdir() is a symlink on macOS.
  return fs.realpathSync(dir);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The policy's defaults for a repository with nothing to protect and
 * nothing tracked; each test overrides only the part it is about. */
function ctx(
  rootReal: string,
  over: {
    protectedRelPaths?: string[];
    tracked?: string[];
  } = {},
): {
  rootReal: string;
  protectedRelPaths: string[];
  isTrackedPath: (relPath: string) => boolean;
} {
  const tracked = over.tracked ?? [];
  return {
    rootReal,
    protectedRelPaths: over.protectedRelPaths ?? [],
    isTrackedPath: (relPath) => tracked.includes(relPath),
  };
}

describe("linkRelPath: containment is judged on where a candidate SITS", () => {
  it("a directory symlink whose TARGET is outside the root still sits inside it, and keeps its own relative path", () => {
    const root = makeTmpDir();
    const outside = makeTmpDir();
    fs.mkdirSync(path.join(outside, "real-node-modules"));
    fs.symlinkSync(
      path.join(outside, "real-node-modules"),
      path.join(root, "node_modules"),
    );

    expect(linkRelPath(path.join(root, "node_modules"), root)).toBe(
      "node_modules",
    );
  });

  it("a candidate whose own parent chain leaves the root is outside it, symlinked ancestor or not", () => {
    const root = makeTmpDir();
    const outside = makeTmpDir();
    fs.mkdirSync(path.join(outside, "vendor"));

    expect(linkRelPath(path.join(outside, "vendor"), root)).toBeUndefined();
  });

  it("a symlinked ANCESTOR inside the root is resolved, so the candidate is not dropped for a spelling difference", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "real-packages", "app"), { recursive: true });
    fs.mkdirSync(path.join(root, "real-packages", "app", "node_modules"));
    fs.symlinkSync(
      path.join(root, "real-packages"),
      path.join(root, "packages"),
    );

    expect(
      linkRelPath(
        path.join(root, "packages", "app", "node_modules"),
        root,
      )?.split(path.sep),
    ).toEqual(["real-packages", "app", "node_modules"]);
  });

  it("the root itself has the empty relative path (the shape the policy refuses outright)", () => {
    const root = makeTmpDir();

    expect(linkRelPath(root, root)).toBe("");
  });
});

describe("planLinks", () => {
  it("links a candidate that sits inside the root, keeping the path it was given as the link target", () => {
    const root = makeTmpDir();

    const plan = planLinks([{ absDir: path.join(root, "vendor") }], ctx(root));

    expect(plan.links).toEqual([
      { candidate: { absDir: path.join(root, "vendor") }, relPath: "vendor" },
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("refuses the repository root itself (a composer bin-dir of '.', a defaults file naming '.'), naming it in a warning", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [{ absDir: root, namedBy: `"." named in "bin-dir" of composer.json` }],
      ctx(root),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("the repository root itself");
    expect(plan.warnings[0]).toContain("bin-dir");
  });

  it("refuses a candidate that CONTAINS a path the copy must keep real (the mutated file's directory, the mapped cwd), and one that IS it", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [
        { absDir: path.join(root, "src"), namedBy: '"src" named in a file' },
        {
          absDir: path.join(root, "packages"),
          namedBy: '"packages" named in a file',
        },
      ],
      ctx(root, {
        protectedRelPaths: ["src", path.join("packages", "app", "sub")],
      }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings[0]).toContain("must stay a real directory");
    expect(plan.warnings[1]).toContain("must stay a real directory");
  });

  it("leaves a SIBLING of a protected path linkable: containment, not a prefix match on the string", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [{ absDir: path.join(root, "src-cache") }],
      ctx(root, { protectedRelPaths: ["src"] }),
    );

    expect(plan.links.map((l) => l.relPath)).toEqual(["src-cache"]);
  });

  it("refuses a directory git tracks when repository content named it, and says why", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [
        {
          absDir: path.join(root, "src"),
          namedBy: '"src" named in the "link" list of .agent-primitives.json',
        },
      ],
      ctx(root, { tracked: ["src"] }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain("git tracks it");
    expect(plan.warnings[0]).toContain(".agent-primitives.json");
  });

  it("keeps an operator's own --link (no provenance) usable for a tracked directory: the stricter rule is for repository content only", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [{ absDir: path.join(root, "src") }],
      ctx(root, { tracked: ["src"] }),
    );

    expect(plan.links.map((l) => l.relPath)).toEqual(["src"]);
  });

  it("links a gitignored directory a file named, since that is exactly what these inputs exist for", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [
        {
          absDir: path.join(root, "vendor"),
          namedBy:
            '"vendor" named in the "link" list of .agent-primitives.json',
        },
      ],
      ctx(root, { tracked: ["src"] }),
    );

    expect(plan.links.map((l) => l.relPath)).toEqual(["vendor"]);
  });

  it("skips a candidate nested inside one already linked, at any depth, naming the covering link", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [
        { absDir: path.join(root, "vendor") },
        { absDir: path.join(root, "vendor", "bin") },
        { absDir: path.join(root, "vendor", "a", "b", "c") },
      ],
      ctx(root),
    );

    expect(plan.links.map((l) => l.relPath)).toEqual(["vendor"]);
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings[0]).toContain("already covered by vendor");
  });

  it("links TWO distinct in-repo symlinks that point at one shared target: nesting is a property of the destinations, not of what they resolve to", () => {
    const root = makeTmpDir();
    const shared = path.join(root, "shared-install");
    fs.mkdirSync(shared);
    fs.symlinkSync(shared, path.join(root, "node_modules"));
    fs.mkdirSync(path.join(root, "packages", "app"), { recursive: true });
    fs.symlinkSync(shared, path.join(root, "packages", "app", "node_modules"));

    const plan = planLinks(
      [
        { absDir: path.join(root, "node_modules") },
        { absDir: path.join(root, "packages", "app", "node_modules") },
      ],
      ctx(root),
    );

    expect(plan.links.map((l) => l.relPath)).toEqual([
      "node_modules",
      path.join("packages", "app", "node_modules"),
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("skips, never throws, on a candidate outside the root, and names it in the one warning format", () => {
    const root = makeTmpDir();
    const outside = makeTmpDir();

    const plan = planLinks(
      [
        {
          absDir: path.join(outside, "vendor"),
          namedBy: `"../x/vendor" named in "vendor-dir" of composer.json`,
        },
      ],
      ctx(root),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toBe(
      `skipped linking ${path.join(outside, "vendor")} ` +
        `("../x/vendor" named in "vendor-dir" of composer.json): ` +
        "it does not sit inside the repository root",
    );
  });
});
