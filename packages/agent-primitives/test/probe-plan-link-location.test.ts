import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probePlan } from "../src/probe/index.js";
import { linkSourceIsOperatorInput } from "../src/probe/link-policy.js";
import { parsePlanFile } from "../src/probe/plan.js";
import { caseInsensitiveVolume } from "./helpers/case-fs.js";
import {
  buildSpawnEnv,
  CLI_PATH,
  collectCli,
  spawnCli,
  type PipedCli,
} from "./helpers/spawn-cli.js";

/**
 * Where a `--plan` file lives decides how its `link` list is judged: a
 * plan stored outside the containment root is the operator's own input
 * (judged like `--link`), a plan under the root is repository content
 * and keeps the strict rule, and so does anything that cannot be shown
 * to lie outside.
 */

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-primitives-plan-loc-")),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  base: string;
  repo: string;
  /** The directory the in-repo `lib` symlink points at, outside the repo. */
  sharedLib: string;
  /** A directory outside the repo for plan files (the run directory). */
  runDir: string;
  logs: string;
  planBody: Record<string, unknown>;
}

/** A repository whose gitignored `lib` is a symlink to a directory outside
 * it. The test command passes only when `lib` is linked into the
 * isolation copy, so a plan that does not get its link honoured fails its
 * baseline instead of killing the mutant. */
function makeFixture(): Fixture {
  const base = makeTmpDir();
  const sharedLib = path.join(base, "shared", "lib");
  fs.mkdirSync(sharedLib, { recursive: true });
  fs.writeFileSync(path.join(sharedLib, "x.js"), "module.exports = 1;\n");
  const repo = path.join(base, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "src", "a.sh"), "x=1\n");
  fs.writeFileSync(
    path.join(repo, "test.js"),
    [
      'const fs = require("fs");',
      'const ok = fs.existsSync("lib/x.js") &&',
      '  fs.readFileSync("src/a.sh", "utf8").includes("x=1");',
      'if (ok) console.log("OK (1 test)");',
      "process.exit(ok ? 0 : 1);",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(repo, ".gitignore"), "lib\nplan*.json\nrunlink\n");
  fs.symlinkSync("../shared/lib", path.join(repo, "lib"));
  git("add", ".gitignore", "src", "test.js");
  git("commit", "-qm", "init");
  const runDir = path.join(base, "run");
  fs.mkdirSync(runDir);
  return {
    base,
    repo,
    sharedLib,
    runDir,
    logs: path.join(base, "logs"),
    planBody: {
      test: "node test.js",
      link: ["lib"],
      passWhen: { regex: "^OK \\(" },
      mutants: [{ file: "src/a.sh", line: 1, replace: "x=2" }],
    },
  };
}

function writePlan(file: string, body: Record<string, unknown>): string {
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

async function runPlan(
  fx: Fixture,
  planArg: string,
  extra: string[] = [],
  cwd: string = fx.repo,
) {
  const run = await spawnCli([
    "-C",
    cwd,
    "-l",
    fx.logs,
    "-m",
    "100000",
    "probe",
    "--plan",
    planArg,
    ...extra,
  ]);
  return {
    code: run.code,
    envelope: JSON.parse(run.stdout) as {
      status: string;
      reason?: string;
      warnings: string[];
      plan?: { results: { status: string }[] };
    },
  };
}

/** The refusal text for the fixture's `lib` (a symlink to
 * `../shared/lib`) named by the file at `namedIn`. */
function refusalFor(fx: Fixture, namedIn: string): string {
  return (
    `outside the containment root (${fx.repo}): link ` +
    `"lib" named in the "link" list of ${namedIn} is a symlink to ` +
    '"../shared/lib", which does not resolve inside the root, and a link ' +
    "named by repository content must; pass it as --link to treat it as " +
    "operator input"
  );
}

describe("probe --plan: a plan outside the repository gets the --link policy for its `link`", () => {
  it("honours the `link` of a plan stored outside the repo: the mutant is killed instead of a file_outside_root refusal", async () => {
    const fx = makeFixture();
    const plan = writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);

    const { code, envelope } = await runPlan(fx, plan);

    expect(envelope.warnings).toEqual([]);
    expect(envelope.status).toBe("killed");
    expect(envelope.reason).toBeUndefined();
    expect(envelope.plan?.results.map((r) => r.status)).toEqual(["killed"]);
    expect(code).toBe(0);
  }, 60000);

  it("resolves a relative --plan path against -C, and honours an outside plan reached through a symlinked directory that lies outside too", async () => {
    const fx = makeFixture();
    writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);
    const viaLink = path.join(fx.base, "run-alias");
    fs.symlinkSync(fx.runDir, viaLink);

    const relative = await runPlan(fx, "../run/plan.json");
    const aliased = await runPlan(fx, path.join(viaLink, "plan.json"));

    expect(relative.envelope.status).toBe("killed");
    expect(aliased.envelope.status).toBe("killed");
  }, 120000);

  it("refuses the same plan copied INSIDE the repo, with the refusal naming the link, where it points and the --link workaround", async () => {
    const fx = makeFixture();
    const plan = writePlan(path.join(fx.repo, "plan.json"), fx.planBody);

    const { code, envelope } = await runPlan(fx, plan);

    expect(envelope.status).toBe("usage_error");
    expect(envelope.reason).toBe("file_outside_root");
    expect(envelope.warnings).toEqual([refusalFor(fx, plan)]);
    expect(code).toBe(2);
  }, 60000);

  it("the workaround the refusal names works: the same inside-repo plan with the link passed as --link is killed", async () => {
    const fx = makeFixture();
    const body = { ...fx.planBody };
    delete body.link;
    const plan = writePlan(path.join(fx.repo, "plan.json"), body);

    const { envelope } = await runPlan(fx, plan, ["--link", "lib"]);

    expect(envelope.status).toBe("killed");
  }, 60000);

  it("still refuses `.agent-primitives.json`'s link when the plan itself lies outside the repo", async () => {
    const fx = makeFixture();
    const body = { ...fx.planBody };
    delete body.link;
    const plan = writePlan(path.join(fx.runDir, "plan.json"), body);
    fs.writeFileSync(
      path.join(fx.repo, ".agent-primitives.json"),
      JSON.stringify({ link: ["lib"] }),
    );

    const { envelope } = await runPlan(fx, plan);

    expect(envelope.status).toBe("usage_error");
    expect(envelope.reason).toBe("file_outside_root");
    expect(envelope.warnings).toEqual([
      refusalFor(fx, path.join(fx.repo, ".agent-primitives.json")),
    ]);
  }, 60000);

  it("treats an outside plan reached through a symlink that lives inside the repo as inside", async () => {
    const fx = makeFixture();
    const real = writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);
    const viaFile = path.join(fx.repo, "plan-link.json");
    fs.symlinkSync(real, viaFile);
    const dirLink = path.join(fx.repo, "runlink");
    fs.symlinkSync(fx.runDir, dirLink);

    const throughFile = await runPlan(fx, viaFile);
    const throughDir = await runPlan(fx, path.join(dirLink, "plan.json"));

    for (const answer of [throughFile, throughDir]) {
      expect(answer.envelope.status).toBe("usage_error");
      expect(answer.envelope.reason).toBe("file_outside_root");
    }
  }, 120000);

  it("treats an inside plan reached through a symlink that lives outside the repo as inside (the realpath of the plan decides)", async () => {
    const fx = makeFixture();
    const real = writePlan(path.join(fx.repo, "plan.json"), fx.planBody);
    const alias = path.join(fx.runDir, "alias.json");
    fs.symlinkSync(real, alias);

    const { envelope } = await runPlan(fx, alias);

    expect(envelope.status).toBe("usage_error");
    expect(envelope.reason).toBe("file_outside_root");
  }, 60000);

  it("treats a case-variant spelling of the repository as inside on a case-insensitive volume", async () => {
    const fx = makeFixture();
    writePlan(path.join(fx.repo, "plan.json"), fx.planBody);
    const variant = path.join(fx.base, "REPO", "plan.json");
    const insensitive = caseInsensitiveVolume(fx.base);

    if (insensitive) {
      expect(fs.existsSync(variant)).toBe(true);
      const { envelope } = await runPlan(fx, variant);
      expect(envelope.status).toBe("usage_error");
      expect(envelope.reason).toBe("file_outside_root");
    } else {
      // A case-sensitive volume has no such directory: the variant is not
      // a way into the repository at all.
      const { envelope } = await runPlan(fx, variant);
      expect(envelope.reason).toBe("plan_not_readable");
    }
  }, 60000);
});

describe("probe --plan: boundary shapes of the location decision", () => {
  it("keeps the strict rule for `--plan /dev/stdin` fed from a plan inside the repo", async () => {
    const fx = makeFixture();
    const plan = writePlan(path.join(fx.repo, "plan.json"), fx.planBody);
    const fd = fs.openSync(plan, "r");
    let run;
    try {
      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          "-C",
          fx.repo,
          "-l",
          fx.logs,
          "-m",
          "100000",
          "probe",
          "--plan",
          "/dev/stdin",
        ],
        { env: buildSpawnEnv(), stdio: [fd, "pipe", "pipe"] },
      ) as unknown as PipedCli;
      run = await collectCli(child);
    } finally {
      fs.closeSync(fd);
    }

    const envelope = JSON.parse(run.stdout) as {
      status: string;
      reason?: string;
    };
    expect(envelope.status).toBe("usage_error");
    expect(envelope.reason).toBe("file_outside_root");
  }, 60000);

  it("treats an outside symlink whose absolute target spells the repo in another case as inside", async () => {
    const fx = makeFixture();
    writePlan(path.join(fx.repo, "plan.json"), fx.planBody);
    const alias = path.join(fx.runDir, "alias.json");
    const variant = path.join(fx.base, "REPO", "plan.json");
    fs.symlinkSync(variant, alias);

    const { envelope } = await runPlan(fx, alias);

    if (caseInsensitiveVolume(fx.base)) {
      expect(envelope.status).toBe("usage_error");
      expect(envelope.reason).toBe("file_outside_root");
    } else {
      // On a case-sensitive volume the alias dangles: it is no way into the
      // repository at all.
      expect(envelope.reason).toBe("plan_not_readable");
    }
  }, 60000);

  it("treats a case-variant typed path through an in-repo symlink to an outside dir as inside", async () => {
    const fx = makeFixture();
    writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);
    fs.symlinkSync(fx.runDir, path.join(fx.repo, "runlink"));
    const typed = path.join(fx.base, "REPO", "runlink", "plan.json");

    const { envelope } = await runPlan(fx, typed);

    if (caseInsensitiveVolume(fx.base)) {
      expect(envelope.status).toBe("usage_error");
      expect(envelope.reason).toBe("file_outside_root");
    } else {
      expect(envelope.reason).toBe("plan_not_readable");
    }
  }, 60000);

  it("treats an outside plan with a second hard link as inside: its other name may sit in the repo", async () => {
    const fx = makeFixture();
    const plan = writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);
    fs.linkSync(plan, path.join(fx.repo, "plan-hard.json"));

    const { envelope } = await runPlan(fx, plan);

    expect(envelope.status).toBe("usage_error");
    expect(envelope.reason).toBe("file_outside_root");
  }, 60000);
});

describe("probe --plan: the refusal for a repository link never depends on state outside the root", () => {
  type Shape = "gone-exists-oracle" | "gone-missing" | "gone-exists-bare";

  /** A repo where `dang` is a symlink to `<base>/out/gone` and `a` is a
   * symlink to `dang/../b`; the three states vary only what exists outside
   * the repo. `link` names `a/oracle`. */
  function makeDanglingShape(fx: Fixture, shape: Shape): void {
    fs.mkdirSync(path.join(fx.base, "out", "b"), { recursive: true });
    const gone = path.join(fx.base, "out", "gone");
    if (shape !== "gone-missing") fs.mkdirSync(gone);
    if (shape !== "gone-exists-bare") {
      fs.symlinkSync(
        "/SECRET/OUTSIDE/LINK/TEXT",
        path.join(fx.base, "out", "b", "oracle"),
      );
    }
    fs.symlinkSync(gone, path.join(fx.repo, "dang"));
    fs.symlinkSync("dang/../b", path.join(fx.repo, "a"));
  }

  /** A repo where `a` is a symlink to `<base>/out/y` and the far end is a
   * cycle back to `a`, a directory holding an `oracle` symlink, or absent. */
  function makeLoopShape(fx: Fixture, far: "cycle" | "dir" | "missing"): void {
    fs.mkdirSync(path.join(fx.base, "out"), { recursive: true });
    const y = path.join(fx.base, "out", "y");
    if (far === "cycle") fs.symlinkSync(path.join(fx.repo, "a"), y);
    if (far === "dir") {
      fs.mkdirSync(y);
      fs.symlinkSync("/ELSEWHERE", path.join(y, "oracle"));
    }
    fs.symlinkSync(y, path.join(fx.repo, "a"));
  }

  const shapes: [string, (fx: Fixture) => void][] = [
    [
      "dangling ancestor, far end exists with an oracle symlink",
      (fx) => makeDanglingShape(fx, "gone-exists-oracle"),
    ],
    [
      "dangling ancestor, far end missing",
      (fx) => makeDanglingShape(fx, "gone-missing"),
    ],
    [
      "dangling ancestor, far end exists without an oracle",
      (fx) => makeDanglingShape(fx, "gone-exists-bare"),
    ],
    [
      "ancestor loops through an outside symlink",
      (fx) => makeLoopShape(fx, "cycle"),
    ],
    [
      "ancestor points at an outside dir with an oracle symlink",
      (fx) => makeLoopShape(fx, "dir"),
    ],
    [
      "ancestor points at a missing outside path",
      (fx) => makeLoopShape(fx, "missing"),
    ],
  ];

  async function warningsFor(
    lane: "plan" | "defaults",
    build: (fx: Fixture) => void,
  ): Promise<string[]> {
    const fx = makeFixture();
    build(fx);
    let plan: string;
    if (lane === "plan") {
      plan = writePlan(path.join(fx.repo, "plan.json"), {
        ...fx.planBody,
        link: ["a/oracle"],
      });
    } else {
      const body = { ...fx.planBody };
      delete body.link;
      plan = writePlan(path.join(fx.runDir, "plan.json"), body);
      fs.writeFileSync(
        path.join(fx.repo, ".agent-primitives.json"),
        JSON.stringify({ link: ["a/oracle"] }),
      );
    }
    const { envelope } = await runPlan(fx, plan);
    expect(envelope.reason).toBe("file_outside_root");
    return envelope.warnings.map((w) => w.split(fx.repo).join("<repo>"));
  }

  for (const lane of ["plan", "defaults"] as const) {
    it(`gives one identical message for every outside state (${lane} lane), the in-root value alone`, async () => {
      const answers: string[][] = [];
      for (const [, build] of shapes) {
        answers.push(await warningsFor(lane, build));
      }

      for (const answer of answers) {
        expect(answer).toEqual([
          "outside the containment root (<repo>): <repo>/a/oracle",
        ]);
      }
    }, 240000);
  }

  describe("an entry spelled outside the root", () => {
    type Lane = "plan" | "defaults";
    type Spelling = "absolute" | "climbing";
    type LeafState = "symlink-A" | "symlink-B" | "missing";

    const states: LeafState[] = ["symlink-A", "symlink-B", "missing"];

    /** The leaf `<base>/out/d/oracle` is the only thing that varies; its
     * parent is a real directory outside the repo. The leaf text for each
     * state is a marker that must never appear in the refusal. */
    function setLeaf(fx: Fixture, state: LeafState): void {
      const dir = path.join(fx.base, "out", "d");
      fs.mkdirSync(dir, { recursive: true });
      const leaf = path.join(dir, "oracle");
      fs.rmSync(leaf, { force: true });
      if (state === "symlink-A") fs.symlinkSync("/MARKER-TEXT-AAA", leaf);
      if (state === "symlink-B") fs.symlinkSync("/MARKER-TEXT-BBB", leaf);
    }

    async function refusalsAcrossStates(
      lane: Lane,
      spelling: Spelling,
    ): Promise<{ fx: Fixture; entry: string; warnings: string[][] }> {
      const fx = makeFixture();
      const entry =
        spelling === "absolute"
          ? path.join(fx.base, "out", "d", "oracle")
          : "../out/d/oracle";
      let plan: string;
      if (lane === "plan") {
        plan = writePlan(path.join(fx.repo, "plan.json"), {
          ...fx.planBody,
          link: [entry],
        });
      } else {
        const body = { ...fx.planBody };
        delete body.link;
        plan = writePlan(path.join(fx.runDir, "plan.json"), body);
        fs.writeFileSync(
          path.join(fx.repo, ".agent-primitives.json"),
          JSON.stringify({ link: [entry] }),
        );
      }
      const warnings: string[][] = [];
      for (const state of states) {
        setLeaf(fx, state);
        const { envelope } = await runPlan(fx, plan);
        expect(envelope.reason).toBe("file_outside_root");
        warnings.push(envelope.warnings);
      }
      return { fx, entry, warnings };
    }

    for (const lane of ["plan", "defaults"] as const) {
      for (const spelling of ["absolute", "climbing"] as const) {
        it(`gives one identical message that quotes no outside link text (${lane} lane, ${spelling} entry)`, async () => {
          const { fx, warnings } = await refusalsAcrossStates(lane, spelling);

          const outsideValue = path.join(fx.base, "out", "d", "oracle");
          for (const answer of warnings) {
            expect(answer).toEqual([
              `outside the containment root (${fx.repo}): ${outsideValue}`,
            ]);
            expect(answer.join("\n")).not.toContain("MARKER-TEXT");
          }
        }, 240000);
      }
    }
  });

  for (const spelling of ["under the real path", "relative to -C"] as const) {
    it(`quotes the link's own readlink text when -C reaches the checkout through a symlink and the entry is spelled ${spelling}`, async () => {
      const fx = makeFixture();
      fs.mkdirSync(path.join(fx.repo, "a"));
      fs.mkdirSync(path.join(fx.base, "out"));
      fs.symlinkSync("../../out/t", path.join(fx.repo, "a", "oracle"));
      const viaLink = path.join(fx.base, "repolink");
      fs.symlinkSync(fx.repo, viaLink);
      const entry =
        spelling === "relative to -C"
          ? path.join("a", "oracle")
          : path.join(fx.repo, "a", "oracle");
      const plan = writePlan(path.join(fx.repo, "plan.json"), {
        ...fx.planBody,
        link: [entry],
      });

      const { envelope } = await runPlan(fx, plan, [], viaLink);

      expect(envelope.reason).toBe("file_outside_root");
      expect(envelope.warnings).toEqual([
        `outside the containment root (${viaLink}): link "${entry}" named in ` +
          `the "link" list of ${plan} is a symlink to "../../out/t", which ` +
          "does not resolve inside the root, and a link named by repository " +
          "content must; pass it as --link to treat it as operator input",
      ]);
    }, 60000);
  }
});

describe("linkSourceIsOperatorInput", () => {
  it("is false for a plan whose realpath could not be verified, wherever it is named", () => {
    const fx = makeFixture();
    const plan = writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);

    expect(
      linkSourceIsOperatorInput(
        { kind: "plan", planPath: plan, planRealPath: undefined },
        fx.repo,
      ),
    ).toBe(false);
    expect(
      linkSourceIsOperatorInput(
        { kind: "plan", planPath: plan, planRealPath: plan },
        fx.repo,
      ),
    ).toBe(true);
  });

  it("is false for a plan stored under the root", () => {
    const fx = makeFixture();
    const plan = writePlan(path.join(fx.repo, "sub-plan.json"), fx.planBody);

    expect(
      linkSourceIsOperatorInput(
        { kind: "plan", planPath: plan, planRealPath: plan },
        fx.repo,
      ),
    ).toBe(false);
  });
});

describe("parsePlanFile: realPath", () => {
  it("reports the realpath of a regular plan file, following a symlink to it", () => {
    const fx = makeFixture();
    const real = writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);
    const alias = path.join(fx.base, "alias.json");
    fs.symlinkSync(real, alias);

    const parsed = parsePlanFile(alias);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.realPath).toBe(real);
  });
});

describe("parsePlanFile: hard links", () => {
  it("reports no realPath for a plan file with a second hard link", () => {
    const fx = makeFixture();
    const plan = writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);
    const single = parsePlanFile(plan);
    fs.linkSync(plan, path.join(fx.runDir, "plan-2.json"));

    const linked = parsePlanFile(plan);

    expect(single.ok && single.realPath).toBe(plan);
    expect(linked.ok).toBe(true);
    expect(linked.ok && linked.realPath).toBeUndefined();
  });
});

describe("parsePlanFile: a realpath that is not the file that was read", () => {
  it("reports no realPath when the realpath names a different file than the one the bytes came from", () => {
    const fx = makeFixture();
    const opened = writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);
    const other = writePlan(path.join(fx.runDir, "other.json"), fx.planBody);
    const spy = vi
      .spyOn(fs, "realpathSync")
      .mockImplementation(((p: fs.PathLike) =>
        p === opened ? other : p) as typeof fs.realpathSync);
    try {
      const parsed = parsePlanFile(opened);

      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.realPath).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const again = parsePlanFile(opened);
    expect(again.ok && again.realPath).toBe(opened);
  });
});

describe("probePlan: no verified realpath means repository content", () => {
  it("keeps the strict rule for a plan outside the repo when the caller supplies no planRealPath", async () => {
    const fx = makeFixture();
    const plan = writePlan(path.join(fx.runDir, "plan.json"), fx.planBody);

    const result = await probePlan({
      mutants: [
        { file: "src/a.sh", line: 1, form: "replace", replaceText: "x=2" },
      ],
      testCommand: "node test.js",
      passRegex: /^OK \(/,
      isolation: "worktree",
      expect: "fail",
      cwd: fx.repo,
      logDir: fx.logs,
      planLinks: ["lib"],
      planPath: plan,
    });

    expect(result.status).toBe("usage_error");
    expect(result.reason).toBe("file_outside_root");
    expect(result.warnings).toEqual([refusalFor(fx, plan)]);
  }, 60000);
});
