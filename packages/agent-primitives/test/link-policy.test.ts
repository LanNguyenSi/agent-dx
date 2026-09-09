import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalDestRelPath,
  linkRelPath,
  planLinks,
  relContains,
} from "../src/probe/link-policy.js";
import { caseInsensitiveVolume } from "./helpers/case-fs.js";

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
 * nothing tracked; each test overrides only the part it is about.
 *
 * `canonicalRelPath` defaults to the identity: a copy whose own
 * filesystem spells every destination exactly the way the source tree
 * does, which is what a case-sensitive filesystem always gives and what
 * a case-insensitive one gives for every candidate spelled the way the
 * directory really is. The tests that are ABOUT the other case pass
 * their own. */
function ctx(
  rootReal: string,
  over: {
    protectedRelPaths?: string[];
    tracked?: string[];
    canonicalRelPath?: (relPath: string) => string;
  } = {},
): {
  rootReal: string;
  protectedRelPaths: string[];
  isTrackedPath: (relPath: string) => boolean;
  canonicalRelPath: (relPath: string) => string;
} {
  const tracked = over.tracked ?? [];
  return {
    rootReal,
    protectedRelPaths: over.protectedRelPaths ?? [],
    isTrackedPath: (relPath) => tracked.includes(relPath),
    canonicalRelPath: over.canonicalRelPath ?? ((relPath) => relPath),
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
      {
        candidate: { absDir: path.join(root, "vendor") },
        relPath: "vendor",
        canonicalRelPath: "vendor",
      },
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
    // The phrase of THIS rule, which judges where the candidate SITS,
    // not the one of the rule below it, which judges where a candidate
    // RESOLVES ("it resolves to the repository root itself"): both
    // refuse this candidate, and a test that accepted either message
    // could not tell which rule is still doing the work.
    expect(plan.warnings[0]).toContain("it is the repository root itself");
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

  it("refuses a candidate repository content named that SITS inside the root but RESOLVES outside it (a gitignored 'esc -> ..'), naming the file and the value", () => {
    const root = makeTmpDir();
    const outside = makeTmpDir();
    fs.symlinkSync(outside, path.join(root, "esc"));

    const plan = planLinks(
      [
        {
          absDir: path.join(root, "esc"),
          namedBy: `"esc" named in "vendor-dir" of ${path.join(root, "composer.json")}`,
        },
      ],
      ctx(root),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("resolves outside the repository root");
    expect(plan.warnings[0]).toContain("composer.json");
    expect(plan.warnings[0]).toContain('"esc"');
  });

  it("keeps that latitude for a candidate NO file named: a node_modules symlinked to a sibling checkout's install still links, as the same symlink", () => {
    // The negative control for the rule above: the same shape on disk,
    // the same target outside the root, and the only difference is that
    // no repository content asked for it. This is the provisioning this
    // org's own worktrees use, and refusing it would be a regression.
    const root = makeTmpDir();
    const outside = makeTmpDir();
    fs.symlinkSync(outside, path.join(root, "node_modules"));

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules") }],
      ctx(root),
    );

    expect(plan.links.map((l) => l.relPath)).toEqual(["node_modules"]);
    expect(plan.warnings).toEqual([]);
  });

  it("decides rule 2 on the COPY's spelling of a destination, not the source tree's: a candidate whose case variant names the mutated directory is refused", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [
        {
          absDir: path.join(root, "SRC"),
          namedBy: '"SRC" named in "vendor-dir" of composer.json',
        },
      ],
      ctx(root, {
        protectedRelPaths: ["src"],
        // What a case-insensitive copy answers for this destination.
        canonicalRelPath: (relPath) => (relPath === "SRC" ? "src" : relPath),
      }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain("must stay a real directory");
  });

  it("decides rule 3 on the COPY's spelling too, so the tracked-path question is asked about the directory the copy really carries", () => {
    const root = makeTmpDir();
    const asked: string[] = [];

    const plan = planLinks(
      [
        {
          absDir: path.join(root, "LIB"),
          namedBy: '"LIB" named in the "link" list of .agent-primitives.json',
        },
      ],
      {
        ...ctx(root, {
          tracked: ["lib"],
          canonicalRelPath: (relPath) => (relPath === "LIB" ? "lib" : relPath),
        }),
        isTrackedPath: (relPath) => {
          asked.push(relPath);
          return relPath === "lib";
        },
      },
    );

    expect(asked).toEqual(["lib"]);
    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain("git tracks it");
  });

  it("refuses a candidate that RESOLVES to the repository root, whatever named it: it sits inside the root under a name of its own, so neither the empty-path rule nor the resolve-inside rule sees it", () => {
    const root = makeTmpDir();
    fs.symlinkSync(root, path.join(root, "esc"));
    fs.symlinkSync(root, path.join(root, "node_modules"));

    const plan = planLinks(
      [
        {
          absDir: path.join(root, "esc"),
          namedBy: `"esc" named in "vendor-dir" of ${path.join(root, "composer.json")}`,
        },
        // No provenance at all: the auto-discovery walk found this one
        // on disk, and rule 1's latitude does not extend to a target
        // that points AT the root.
        { absDir: path.join(root, "node_modules") },
      ],
      ctx(root),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings).toHaveLength(2);
    for (const warning of plan.warnings) {
      expect(warning).toContain("resolves to the repository root itself");
    }
    expect(plan.warnings[0]).toContain("composer.json");
  });

  it("refuses a candidate the walk found that resolves to a directory CONTAINING the root", () => {
    const root = makeTmpDir();
    fs.symlinkSync("..", path.join(root, "node_modules"));

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules") }],
      ctx(root),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("contains the repository root");
  });

  it("decides rule 4 on the COPY's spelling as well: a case variant of a destination already planned is seen as the same one, not as a second link", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [
        { absDir: path.join(root, "vendor") },
        { absDir: path.join(root, "VENDOR") },
      ],
      ctx(root, {
        canonicalRelPath: (relPath) =>
          relPath === "VENDOR" ? "vendor" : relPath,
      }),
    );

    expect(plan.links.map((l) => l.relPath)).toEqual(["vendor"]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("already covered by vendor");
  });
});

describe("relContains: the separator is what keeps a sibling a sibling", () => {
  it("a protected path that merely shares a prefix does not sit inside a candidate: 'src' does not contain 'src-cache/app'", () => {
    expect(relContains("src", path.join("src-cache", "app"))).toBe(false);
    expect(relContains("src", path.join("src", "app"))).toBe(true);
  });

  it("a candidate that merely shares a prefix is not covered by an earlier link: 'vendor' does not contain 'vendor-bin'", () => {
    expect(relContains("vendor", "vendor-bin")).toBe(false);
    expect(relContains("vendor", path.join("vendor", "bin"))).toBe(true);
  });

  it("both directions through planLinks: the prefix-sharing sibling of a protected path is linked, and so is the prefix-sharing sibling of an earlier link", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [
        { absDir: path.join(root, "src") },
        { absDir: path.join(root, "vendor") },
        { absDir: path.join(root, "vendor-bin") },
      ],
      ctx(root, { protectedRelPaths: [path.join("src-cache", "app")] }),
    );

    expect(plan.links.map((l) => l.relPath)).toEqual([
      "src",
      "vendor",
      "vendor-bin",
    ]);
    expect(plan.warnings).toEqual([]);
  });
});

describe("canonicalDestRelPath: the copy's own spelling of a destination", () => {
  it("reads the on-disk name of a destination reached under a different spelling, and leaves one that does not exist alone", () => {
    const wtReal = makeTmpDir();
    fs.mkdirSync(path.join(wtReal, "src"));

    // Nothing at this destination under any spelling: the planned name
    // is the one the link would be created under. True on every
    // filesystem.
    expect(canonicalDestRelPath(wtReal, "vendor")).toBe("vendor");

    if (caseInsensitiveVolume(wtReal)) {
      expect(canonicalDestRelPath(wtReal, "SRC")).toBe("src");
    } else {
      // A case-sensitive volume has no alias to resolve: `SRC` is
      // simply a directory that is not there.
      expect(canonicalDestRelPath(wtReal, "SRC")).toBe("SRC");
    }
    // The spelling that is already the on-disk one is unchanged either
    // way.
    expect(canonicalDestRelPath(wtReal, "src")).toBe("src");
  });

  it("keeps a nested destination's parent path, canonicalising the final component under it", () => {
    const wtReal = makeTmpDir();
    fs.mkdirSync(path.join(wtReal, "packages", "app"), { recursive: true });

    expect(canonicalDestRelPath(wtReal, path.join("packages", "app"))).toBe(
      path.join("packages", "app"),
    );
    if (caseInsensitiveVolume(wtReal)) {
      expect(canonicalDestRelPath(wtReal, path.join("packages", "APP"))).toBe(
        path.join("packages", "app"),
      );
    }
  });

  it("canonicalises a case-variant PARENT too, not only the final component: every segment is read back from the copy in turn", () => {
    const wtReal = makeTmpDir();
    fs.mkdirSync(path.join(wtReal, "src", "sub"), { recursive: true });

    if (caseInsensitiveVolume(wtReal)) {
      expect(canonicalDestRelPath(wtReal, path.join("SRC", "sub"))).toBe(
        path.join("src", "sub"),
      );
      expect(canonicalDestRelPath(wtReal, path.join("SRC", "SUB"))).toBe(
        path.join("src", "sub"),
      );
    } else {
      // No alias to resolve: `SRC` is a directory that is not there, and
      // from a segment that does not exist the rest is returned as
      // given.
      expect(canonicalDestRelPath(wtReal, path.join("SRC", "sub"))).toBe(
        path.join("SRC", "sub"),
      );
    }
  });

  it("returns every segment from the first missing one as given: nothing is on disk there to alias it", () => {
    const wtReal = makeTmpDir();
    fs.mkdirSync(path.join(wtReal, "src"), { recursive: true });

    // `src` exists and is canonicalised; `Deep/Nested` does not exist
    // under any spelling, so it stays exactly as planned -- which is the
    // name the link would be created under. True on every filesystem.
    expect(
      canonicalDestRelPath(wtReal, path.join("src", "Deep", "Nested")),
    ).toBe(path.join("src", "Deep", "Nested"));
    if (caseInsensitiveVolume(wtReal)) {
      expect(
        canonicalDestRelPath(wtReal, path.join("SRC", "Deep", "Nested")),
      ).toBe(path.join("src", "Deep", "Nested"));
    }
  });

  it("follows a chain that leaves the copy through a symlink, reporting the names it finds at the other end (whether such a destination may be linked at all is the caller's containment check)", () => {
    const wtReal = makeTmpDir();
    const outside = makeTmpDir();
    fs.mkdirSync(path.join(outside, "bin"));
    fs.symlinkSync(outside, path.join(wtReal, "vendor"));

    expect(canonicalDestRelPath(wtReal, path.join("vendor", "bin"))).toBe(
      path.join("vendor", "bin"),
    );
    if (caseInsensitiveVolume(wtReal)) {
      expect(canonicalDestRelPath(wtReal, path.join("VENDOR", "BIN"))).toBe(
        path.join("vendor", "bin"),
      );
    }
  });

  it("reports a destination that IS a symlink by its own name, never by its target's", () => {
    const wtReal = makeTmpDir();
    const outside = makeTmpDir();
    fs.symlinkSync(outside, path.join(wtReal, "node_modules"));

    expect(canonicalDestRelPath(wtReal, "node_modules")).toBe("node_modules");
  });
});

describe("planLinks: candidates outside the root", () => {
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
