import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalDestRelPath,
  entryRelationTo,
  hasOperatorLatitude,
  linkRelPath,
  linkTargetRelPath,
  nestedRepoBoundaryRelPath,
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
 * `tracked` is a list of paths git's index carries, and the stub
 * answers it the way `beginWorktree`'s own `isTrackedPath` does: a
 * question about a DIRECTORY is answered by any tracked path at or
 * under it, since `git ls-files` reports the files in a directory and
 * never the directory itself.
 *
 * `canonicalRelPath` and `canonicalRootRelPath` default to the
 * identity: a copy and a source tree that spell every path exactly the
 * way the other does, which is what a case-sensitive filesystem always
 * gives and what a case-insensitive one gives for every candidate
 * spelled the way the directory really is. The tests that are ABOUT the
 * other case pass their own. */
function ctx(
  rootReal: string,
  over: {
    protectedRelPaths?: string[];
    tracked?: string[];
    trackedUnknown?: boolean;
    copyRootReal?: string;
    canonicalRelPath?: (relPath: string) => string;
    canonicalRootRelPath?: (relPath: string) => string;
  } = {},
): {
  rootReal: string;
  protectedRelPaths: string[];
  isTrackedPath: (relPath: string) => boolean;
  trackedUnknown: boolean;
  copyRootReal: string | undefined;
  canonicalRootRelPath: (relPath: string) => string;
  canonicalRelPath: (relPath: string) => string;
} {
  const tracked = over.tracked ?? [];
  return {
    rootReal,
    protectedRelPaths: over.protectedRelPaths ?? [],
    isTrackedPath: (relPath) =>
      tracked.some((t) => t === relPath || t.startsWith(relPath + path.sep)),
    trackedUnknown: over.trackedUnknown ?? false,
    copyRootReal: over.copyRootReal,
    canonicalRootRelPath: over.canonicalRootRelPath ?? ((relPath) => relPath),
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

  it("reports the destination half's fail-closed refusal honestly too: 'could not check', never 'git tracks', when the listing never answered", () => {
    const root = makeTmpDir();

    const plan = planLinks(
      [
        {
          absDir: path.join(root, "src"),
          namedBy: '"src" named in the "link" list of .agent-primitives.json',
        },
      ],
      ctx(root, { tracked: ["src"], trackedUnknown: true }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain(
      "could not check whether git tracks src; treated as tracked",
    );
    expect(plan.warnings[0]).not.toContain("git tracks it");
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

/** The same directory name in the two Unicode normalisation forms:
 * `é` as one code point (NFC) and as `e` plus a combining acute (NFD).
 * Written as escapes so the two are unmistakable in the source, where
 * an editor would render them identically. */
const NFC_NAME = "r\u00e9sources";
const NFD_NAME = "re\u0301sources";

/**
 * Whether the volume `dir` sits on treats two spellings that differ only
 * in normalisation form as one entry, MEASURED on that volume rather
 * than assumed from the platform: APFS's case-insensitive variant is
 * normalisation-insensitive, its case-sensitive variant is not, and a
 * Linux host is neither. The sibling of `caseInsensitiveVolume` for the
 * second spelling `fs.realpathSync` does not normalise away.
 */
function normalisingVolume(dir: string): boolean {
  const probe = path.join(dir, "nfd\u00e9probe");
  fs.mkdirSync(probe);
  try {
    return fs.existsSync(path.join(dir, "nfde\u0301probe"));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

describe("entryRelationTo: 'is the root' and 'contains the root' by identity", () => {
  it("answers the exact spellings from the path strings alone", () => {
    const base = makeTmpDir();
    const root = path.join(base, "a", "b", "repo");
    fs.mkdirSync(root, { recursive: true });

    expect(entryRelationTo(root, root)).toBe("same");
    expect(entryRelationTo(path.join(base, "a", "b"), root)).toBe("contains");
    expect(entryRelationTo(base, root)).toBe("contains");
    expect(entryRelationTo(path.join(root, "vendor"), root)).toBeUndefined();
    expect(
      entryRelationTo(path.join(base, "a", "other"), root),
    ).toBeUndefined();
  });

  it("reports nothing for a path that is not on disk and is no ancestor by spelling either", () => {
    const base = makeTmpDir();
    const root = path.join(base, "repo");
    fs.mkdirSync(root);

    expect(entryRelationTo(path.join(base, "gone"), root)).toBeUndefined();
  });

  it("reports 'same' for a CASE variant of the root, which realpath leaves alone", () => {
    const base = makeTmpDir();
    const root = path.join(base, "repo");
    fs.mkdirSync(root);
    const variant = path.join(base, "REPO");
    if (!caseInsensitiveVolume(base)) {
      // `REPO` names a different directory here, and nothing is there.
      expect(entryRelationTo(variant, root)).toBeUndefined();
      return;
    }

    // What makes this shape dangerous, stated as measurements: the two
    // spellings are different STRINGS, realpath does not close the gap,
    // and they are one directory.
    expect(variant).not.toBe(root);
    expect(fs.realpathSync(variant)).not.toBe(root);
    expect(fs.statSync(variant).ino).toBe(fs.statSync(root).ino);

    expect(entryRelationTo(variant, root)).toBe("same");
  });

  it("reports 'contains' for a CASE variant of an ancestor two levels above the root, which a walk that stops at the parent never reaches", () => {
    const base = makeTmpDir();
    const root = path.join(base, "Ancestor", "mid", "repo");
    fs.mkdirSync(root, { recursive: true });
    const variant = path.join(base, "ancestor");
    if (!caseInsensitiveVolume(base)) {
      expect(entryRelationTo(variant, root)).toBeUndefined();
      return;
    }

    expect(fs.realpathSync(variant)).not.toBe(path.join(base, "Ancestor"));

    expect(entryRelationTo(variant, root)).toBe("contains");
  });

  it("reports 'same' for an NFD spelling of an NFC root on a volume that normalises", () => {
    const base = makeTmpDir();
    const root = path.join(base, NFC_NAME);
    fs.mkdirSync(root);
    const variant = path.join(base, NFD_NAME);
    if (!normalisingVolume(base)) {
      expect(entryRelationTo(variant, root)).toBeUndefined();
      return;
    }

    expect(variant).not.toBe(root);
    expect(fs.realpathSync(variant)).not.toBe(root);
    expect(fs.statSync(variant).ino).toBe(fs.statSync(root).ino);

    expect(entryRelationTo(variant, root)).toBe("same");
  });
});

describe("entryRelationTo: pinned on any volume, through a symlinked alias", () => {
  it("reports 'same' for an ALIAS of the root: statSync follows the link, so identity answers what neither path string can (the identity branch, whatever the volume's case behaviour)", () => {
    const base = makeTmpDir();
    const root = path.join(base, "repo");
    fs.mkdirSync(root);
    const alias = path.join(base, "REPOLINK");
    fs.symlinkSync(root, alias, "dir");

    // The string pre-filter cannot answer this one: the alias is a
    // SIBLING of the root, neither equal to it nor under it, so both
    // halves of the pre-filter are false and only identity is left.
    // That is what makes this test volume-independent, where every
    // other test of this function needs a case-insensitive (or a
    // normalising) volume to produce two spellings of one directory.
    expect(alias).not.toBe(root);
    expect(path.relative(root, alias).startsWith("..")).toBe(true);

    expect(entryRelationTo(alias, root)).toBe("same");
  });

  it("reports 'contains' for an alias of a GRANDPARENT of the base, on any volume: the walk up the base's own ancestors is what reaches it", () => {
    const base = makeTmpDir();
    const root = path.join(base, "repo");
    const deep = path.join(root, "sub", "deep");
    fs.mkdirSync(deep, { recursive: true });
    const alias = path.join(base, "ROOTLINK");
    fs.symlinkSync(root, alias, "dir");

    // Again a sibling spelling, so the pre-filter is silent and the
    // ancestor walk is the branch under test; `root` is two levels
    // above `deep`, so a walk that stopped at the parent would miss it.
    expect(path.relative(deep, alias).startsWith("..")).toBe(true);

    expect(entryRelationTo(alias, deep)).toBe("contains");
  });
});

describe("linkTargetRelPath: where a candidate's TARGET sits inside the root", () => {
  it("answers from the strings alone for a target spelled the way it sits, and reports the root itself as the empty path", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });

    expect(linkTargetRelPath(path.join(root, "a", "b"), root)).toBe(
      path.join("a", "b"),
    );
    expect(linkTargetRelPath(root, root)).toBe("");
  });

  it("finds the in-root path of a target reached through a symlinked ALIAS of the root, which relativizing the two strings reads as outside it (the identity branch, on any volume)", () => {
    const base = makeTmpDir();
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.symlinkSync(root, path.join(base, "REPOLINK"), "dir");
    const target = path.join(base, "REPOLINK", "src");

    // What a plain relativize says about it, and why it is not enough:
    // this is the same shape a `node_modules -> ../REPO/src` produces
    // on a case-insensitive volume, reproduced here with a symlink so
    // the branch is exercised on every volume.
    expect(path.relative(root, target).startsWith("..")).toBe(true);

    expect(linkTargetRelPath(target, root)).toBe("src");
  });

  it("reports nothing for a target genuinely outside the root: that is rule 1's latitude for a sibling checkout's install, not something to ask git about", () => {
    const base = makeTmpDir();
    const root = path.join(base, "repo");
    fs.mkdirSync(root);
    const sibling = path.join(base, "sibling", "node_modules");
    fs.mkdirSync(sibling, { recursive: true });

    expect(linkTargetRelPath(sibling, root)).toBeUndefined();
  });
});

describe("planLinks: rule 3's tracked-TARGET half", () => {
  it("hasOperatorLatitude is true for a candidate carrying neither provenance flag, and false for each flag on its own", () => {
    expect(hasOperatorLatitude({ absDir: "/r/nm" })).toBe(true);
    expect(hasOperatorLatitude({ absDir: "/r/nm", discovered: true })).toBe(
      false,
    );
    expect(
      hasOperatorLatitude({ absDir: "/r/nm", namedBy: '"v" named in x' }),
    ).toBe(false);
  });

  it("refuses an auto-discovered candidate whose TARGET git tracks, naming the target: the destination is a name no other rule objects to", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "src"));
    fs.symlinkSync("src", path.join(root, "node_modules"), "dir");

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      ctx(root, { tracked: ["src"] }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain(path.join(root, "node_modules"));
    expect(plan.warnings[0]).toContain(
      `git tracks its target ${path.join(root, "src")}`,
    );
  });

  it("refuses one repository content named for the same reason, in the same wording, with its provenance in the warning", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "src"));
    fs.symlinkSync("src", path.join(root, "vendor"), "dir");

    const plan = planLinks(
      [
        {
          absDir: path.join(root, "vendor"),
          namedBy: `"vendor" named in "vendor-dir" of ${root}/composer.json`,
        },
      ],
      ctx(root, { tracked: ["src"] }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain("vendor-dir");
    expect(plan.warnings[0]).toContain(
      `git tracks its target ${path.join(root, "src")}`,
    );
  });

  it("keeps an operator's own --link usable for that same target: rule 3's documented latitude covers both of its halves", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "src"));
    fs.symlinkSync("src", path.join(root, "node_modules"), "dir");

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules") }],
      ctx(root, { tracked: ["src"] }),
    );

    expect(plan.links.map((planned) => planned.candidate.absDir)).toEqual([
      path.join(root, "node_modules"),
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("links a discovered candidate whose target is UNTRACKED and inside the root (a hoisted install, a shared cache): the rule is what git tracks, not where the target sits", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, ".cache"));
    fs.symlinkSync(".cache", path.join(root, "node_modules"), "dir");

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      ctx(root, { tracked: ["src"] }),
    );

    expect(plan.links.map((planned) => planned.candidate.absDir)).toEqual([
      path.join(root, "node_modules"),
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("links a discovered candidate whose target is outside the root, tracked paths or not: it is not this repository's source at all", () => {
    const base = makeTmpDir();
    const root = path.join(base, "repo");
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(base, "sibling", "node_modules"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join("..", "sibling", "node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      // Everything tracked, so only "the target is outside the root"
      // can be what lets this candidate through.
      { ...ctx(root), isTrackedPath: () => true },
    );

    expect(plan.links.map((planned) => planned.candidate.absDir)).toEqual([
      path.join(root, "node_modules"),
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("asks git about the SOURCE tree's own spelling of the target, never the one realpath hands back: a target really named 'SRC' is the tracked 'src' the repository carries", () => {
    const root = makeTmpDir();
    // A directory really named `SRC` on any volume, so this test does
    // not need a case-insensitive one to produce the two spellings.
    fs.mkdirSync(path.join(root, "SRC"));
    fs.symlinkSync("SRC", path.join(root, "node_modules"), "dir");
    const candidates = [
      { absDir: path.join(root, "node_modules"), discovered: true as const },
    ];

    // Asked with the raw spelling, git's case-sensitive index answers
    // "untracked" and the link is created: the fail-open this
    // canonicalisation exists to close.
    expect(
      planLinks(candidates, ctx(root, { tracked: ["src"] })).links,
    ).toHaveLength(1);

    const plan = planLinks(
      candidates,
      ctx(root, {
        tracked: ["src"],
        canonicalRootRelPath: (relPath) =>
          relPath === "SRC" ? "src" : relPath,
      }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain(
      `git tracks its target ${path.join(root, "SRC")}`,
    );
  });

  it("refuses a target git tracks only BELOW it (a directory whose own path is not in the index, carrying a tracked file)", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "src"));
    fs.symlinkSync("src", path.join(root, "node_modules"), "dir");

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      // What `git ls-files` really returns: the FILES under the
      // directory, never the directory itself.
      ctx(root, { tracked: [path.join("src", "tracked.js")] }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain(
      `git tracks its target ${path.join(root, "src")}`,
    );
  });

  it("refuses a target BELOW a nested repository's own root, which the outer index lists nowhere (a submodule's content, a nested plain repository's)", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "sub", "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "sub", ".git"), { recursive: true });
    fs.symlinkSync(
      path.join("sub", "lib"),
      path.join(root, "node_modules"),
      "dir",
    );

    const plan = planLinks(
      // `tracked: []`: the outer index never lists a submodule's own
      // content, only its gitlink at "sub" -- which this candidate does
      // not even name.
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      ctx(root),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain(
      `its target ${path.join(root, "sub", "lib")} sits inside a nested ` +
        "repository at sub",
    );
    expect(plan.warnings[0]).toContain("inside a nested repository at sub");
    expect(plan.warnings[0]).toContain(
      "whose content the outer index never lists",
    );
    expect(plan.warnings[0]).not.toContain(
      `git tracks its target ${path.join(root, "sub", "lib")}`,
    );
  });

  it("refuses a target at or under the repository's own '.git' directory: neither a tracked path nor a nested-repository boundary would otherwise catch it", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, ".git"));
    fs.symlinkSync(".git", path.join(root, "node_modules"), "dir");

    const plan = planLinks(
      // Neither tracked nor a nested boundary: `.git/.git` does not
      // exist, so `nestedRepoBoundaryRelPath` would find nothing here
      // without the dedicated check.
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      ctx(root),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain(
      `its target ${path.join(root, ".git")} is the repository's own git directory`,
    );
  });

  it("does not add the nested-repository clause when the target is already a directly tracked path (the gitlink itself)", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.mkdirSync(path.join(root, "sub", ".git"), { recursive: true });
    fs.symlinkSync("sub", path.join(root, "node_modules"), "dir");

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      // The gitlink itself, exactly as `git ls-files` would report it.
      ctx(root, { tracked: ["sub"] }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain(
      `git tracks its target ${path.join(root, "sub")}; source is copied ` +
        "into the isolation copy, never shared with the tree being " +
        "isolated from, so every write through such a link would land in " +
        "the source tree",
    );
    expect(plan.warnings[0]).not.toContain("inside a nested repository");
  });

  it("leaves a target under a gitignored PLAIN nested directory (no '.git' of its own) linkable: the boundary, not mere nesting, is what refuses", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "plain", "lib"), { recursive: true });
    fs.symlinkSync(
      path.join("plain", "lib"),
      path.join(root, "node_modules"),
      "dir",
    );

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      ctx(root),
    );

    expect(plan.links.map((planned) => planned.candidate.absDir)).toEqual([
      path.join(root, "node_modules"),
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("reports the fail-closed refusal honestly: 'could not check', never 'git tracks', when the listing never answered", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "src"));
    fs.symlinkSync("src", path.join(root, "node_modules"), "dir");

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      // `isTrackedPath` answering `true` for every path is what a real
      // `trackedUnknown` caller's own closure does (see `isolation.ts`);
      // this stub is told the same thing directly rather than
      // reimplementing that closure.
      ctx(root, { tracked: ["src"], trackedUnknown: true }),
    );

    expect(plan.links).toEqual([]);
    expect(plan.warnings[0]).toContain(
      `could not check whether git tracks its target ${path.join(root, "src")}; treated as tracked`,
    );
  });

  it("never refuses a target INSIDE the isolation copy's own directory as a nested repository, even though a linked worktree carries its own '.git' too", () => {
    const root = makeTmpDir();
    // The isolation copy's own root, somewhere inside the source tree
    // (a `--log-dir` placed inside the repository): a linked git
    // worktree carries a `.git` FILE at its own root the same way a
    // submodule does, and this candidate's target sits inside it.
    const copyRoot = path.join(root, "probe-logs", "wt-1", "wt");
    fs.mkdirSync(path.join(copyRoot, "vendor"), { recursive: true });
    fs.mkdirSync(path.join(copyRoot, ".git"), { recursive: true });
    fs.symlinkSync(
      path.join(copyRoot, "vendor"),
      path.join(root, "node_modules"),
      "dir",
    );

    const plan = planLinks(
      [{ absDir: path.join(root, "node_modules"), discovered: true }],
      ctx(root, { copyRootReal: copyRoot }),
    );

    // Accepted here: `beginWorktree`'s own, more specific postcondition
    // (not exercised by this unit test) is what actually refuses a
    // target resolving into the copy, with the right reason.
    expect(plan.links.map((planned) => planned.candidate.absDir)).toEqual([
      path.join(root, "node_modules"),
    ]);
    expect(plan.warnings).toEqual([]);
  });
});

describe("planLinks: a target that reaches the root under a second spelling", () => {
  it("skips an auto-discovered node_modules whose target is a CASE variant of the repository root, in the same wording the exact spelling gets", (t) => {
    const base = makeTmpDir();
    const root = path.join(base, "repo");
    fs.mkdirSync(root);
    t.skip(!caseInsensitiveVolume(base), "not on a case-insensitive volume");
    const absDir = path.join(root, "node_modules");
    fs.symlinkSync(path.join("..", "REPO"), absDir);

    // No `namedBy`: the auto-discovery lane, which rule 1 grants its
    // latitude to, is exactly the lane this shape reaches through.
    const plan = planLinks([{ absDir }], ctx(root));

    expect(plan.links).toEqual([]);
    expect(plan.warnings).toEqual([
      `skipped linking ${absDir}: it resolves to the repository root ` +
        "itself; linking it would put the source tree inside the isolation " +
        "copy",
    ]);
  });

  it("skips one whose target is a CASE variant of a directory containing the root", (t) => {
    const base = makeTmpDir();
    const root = path.join(base, "Ancestor", "repo");
    fs.mkdirSync(root, { recursive: true });
    t.skip(!caseInsensitiveVolume(base), "not on a case-insensitive volume");
    const absDir = path.join(root, "node_modules");
    const variant = path.join(base, "ancestor");
    fs.symlinkSync(variant, absDir);

    const plan = planLinks([{ absDir }], ctx(root));

    expect(plan.links).toEqual([]);
    expect(plan.warnings).toEqual([
      `skipped linking ${absDir}: it resolves to ${variant}, which contains ` +
        "the repository root; linking it would put the source tree inside " +
        "the isolation copy",
    ]);
  });
});

describe("nestedRepoBoundaryRelPath: a target inside a nested repository's own boundary", () => {
  it("finds the boundary at a directory strictly BELOW a nested repository's own root", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "sub", "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "sub", ".git"), { recursive: true });

    expect(nestedRepoBoundaryRelPath(path.join("sub", "lib"), root)).toBe(
      "sub",
    );
  });

  it("finds the boundary at the nested repository's own root when the target IS that root", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    fs.mkdirSync(path.join(root, "nested", ".git"), { recursive: true });

    expect(nestedRepoBoundaryRelPath("nested", root)).toBe("nested");
  });

  it("recognizes a '.git' FILE as the boundary too (a linked worktree or a submodule's own root)", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "sub", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "sub", ".git"),
      "gitdir: /elsewhere/.git/modules/sub\n",
    );

    expect(nestedRepoBoundaryRelPath(path.join("sub", "lib"), root)).toBe(
      "sub",
    );
  });

  it("returns undefined for a plain nested directory carrying no '.git' of its own", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "plain", "lib"), { recursive: true });

    expect(
      nestedRepoBoundaryRelPath(path.join("plain", "lib"), root),
    ).toBeUndefined();
  });

  it("returns the OUTERMOST boundary when a nested repository itself contains a further-nested one", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "outer", "inner", "lib"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, "outer", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "outer", "inner", ".git"), {
      recursive: true,
    });

    expect(
      nestedRepoBoundaryRelPath(path.join("outer", "inner", "lib"), root),
    ).toBe("outer");
  });
});
