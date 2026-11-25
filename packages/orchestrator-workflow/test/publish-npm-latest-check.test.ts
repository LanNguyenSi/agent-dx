// The Publish step fails when dist-tags.latest is not on the highest published
// stable version. These tests pin the wiring in publish-npm.yml (every success
// exit passes through the check, the helper scripts come from the workflow's
// own revision, publishes are serialised per package) and run the real `run:`
// body against a stub `npm` under the Actions bash invocation.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean>;
}

const workflow = parse(
  readFileSync(
    new URL("../../../.github/workflows/publish-npm.yml", import.meta.url),
    "utf8",
  ),
) as {
  jobs: {
    publish: {
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      steps: Step[];
    };
  };
};

const job = workflow.jobs.publish;
const steps = job.steps;
const publishStep = steps.find((s) => s.name === "Publish");
const body = publishStep?.run ?? "";
const scriptsDir = new URL("../../../.github/scripts", import.meta.url)
  .pathname;

describe("publish-npm.yml latest check, wiring", () => {
  it("serialises publishes per package without cancelling", () => {
    expect(job.concurrency?.group).toBe(
      "publish-npm-${{ needs.parse.outputs.pkg }}",
    );
    expect(job.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("passes every success exit through assert_latest", () => {
    const lines = body.split("\n").map((l) => l.trim());
    const exits = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l === "exit 0");
    expect(exits).toHaveLength(3);
    for (const { i } of exits) {
      expect(lines[i - 1]).toBe("assert_latest || exit 1");
    }
  });

  it("never passes an explicit --tag to npm publish", () => {
    expect(body).toMatch(/npm publish --access public --provenance/);
    expect(body).not.toMatch(/npm publish[^\n]*--tag/);
  });

  it("runs the helper scripts from the workflow's own revision", () => {
    const gate = steps.findIndex(
      (s) => s.name === "Verify tagged commit is on master",
    );
    const own = steps.findIndex((s) =>
      String(s.with?.path ?? "").startsWith("_publish-scripts"),
    );
    expect(own).toBeGreaterThan(gate);
    // Right before Publish, so the package's npm ci, build and test never
    // run next to the nested tree.
    expect(steps.findIndex((s) => s.name === "Publish")).toBe(own + 1);
    expect(steps[own]?.uses ?? "").toMatch(/^actions\/checkout@/);
    expect(steps[own]?.with?.ref).toBe("${{ github.sha }}");
    expect(steps[own]?.with?.path).toBe("_publish-scripts");
    expect(steps[own]?.with?.["sparse-checkout"]).toBe(".github/scripts");
    expect(steps[own]?.with?.["persist-credentials"]).toBe(false);
    expect(body).toContain(
      '"${GITHUB_WORKSPACE}/_publish-scripts/.github/scripts"',
    );
    expect(body).not.toContain('"${GITHUB_WORKSPACE}/.github/scripts"');
  });
});

describe("publish-npm.yml credentials", () => {
  it("persists no git credential from any checkout of the OIDC job", () => {
    const checkouts = steps.filter((s) =>
      (s.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkouts).toHaveLength(2);
    for (const c of checkouts) {
      expect(c.with?.["persist-credentials"]).toBe(false);
    }
  });
});

const operatorWorkflow = (file: string) =>
  readFileSync(
    new URL(`../../../.github/workflows/${file}`, import.meta.url),
    "utf8",
  );

describe("operator workflows are serialised with publish", () => {
  const publishGroup = job.concurrency?.group ?? "";
  const cases: Array<[string, string]> = [
    ["npm-dist-tag.yml", "dist-tag"],
    ["npm-deprecate.yml", "deprecate"],
  ];
  for (const [file, jobName] of cases) {
    it(`${file} shares the per-package publish group without cancelling`, () => {
      const wf = parse(operatorWorkflow(file)) as {
        jobs: Record<
          string,
          { concurrency?: { group?: string; "cancel-in-progress"?: boolean } }
        >;
      };
      const c = wf.jobs[jobName]?.concurrency;
      expect(c?.group).toBe(
        publishGroup.replace("needs.parse.outputs.pkg", "inputs.package"),
      );
      expect(c?.group).toBe("publish-npm-${{ inputs.package }}");
      expect(c?.["cancel-in-progress"]).toBe(false);
    });
  }
});

describe("npm-dist-tag.yml deprecated-latest guard", () => {
  const wf = parse(operatorWorkflow("npm-dist-tag.yml")) as {
    jobs: { "dist-tag": { steps: Step[] } };
  };
  const dsteps = wf.jobs["dist-tag"].steps;
  const guardIdx = dsteps.findIndex(
    (s) => s.name === "Refuse latest on a deprecated version",
  );
  const moveIdx = dsteps.findIndex((s) => s.name === "Move the dist-tag");

  it("runs before the tag is moved", () => {
    expect(guardIdx).toBeGreaterThan(-1);
    expect(moveIdx).toBeGreaterThan(guardIdx);
  });

  it("reads the deprecation of the target version for the latest tag only", () => {
    const run = dsteps[guardIdx]?.run ?? "";
    expect(run).toContain('[ "$TAG" = "latest" ]');
    expect(run).toContain('npm view "${PACKAGE}@${VERSION}" deprecated');
    expect(run).toMatch(/::error::[^\n]*deprecated/);
    expect(run).toContain("exit 1");
  });
});

describe("publish-npm.yml latest check, executed", () => {
  const stubNpm = `#!/usr/bin/env bash
case "$*" in
  publish*) touch "$STUB_DIR/published"; [ "\${STUB_PUBLISH_FAIL:-0}" = 1 ] && exit 1; exit 0;;
  *dist.attestations*) echo sigstore;;
  *"dist-tags --json"*)
    [ "\${STUB_VIEW_FAIL:-0}" = 1 ] && exit 1
    echo "{\\"latest\\":\\"$STUB_LATEST\\"}";;
  *"versions --json"*) echo '["0.1.0","0.2.0"]';;
  *"@"*" version"*)
    if [ "\${STUB_PRESENT:-0}" = 1 ] || [ -f "$STUB_DIR/published" ]; then echo 0.2.0; exit 0; fi
    exit 1;;
esac
`;

  const runStep = (env: Record<string, string>, withScripts = true) => {
    const dir = mkdtempSync(join(tmpdir(), "publish-latest-"));
    try {
      const bin = join(dir, "bin");
      const ws = join(dir, "ws");
      const pkgDir = join(ws, "packages", "demo");
      mkdirSync(bin, { recursive: true });
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(bin, "npm"), stubNpm);
      writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(bin, "npm"), 0o755);
      chmodSync(join(bin, "sleep"), 0o755);
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "demo", version: "0.2.0" }),
      );
      // The tagged tree may predate the scripts; only the workflow's own
      // revision (the _publish-scripts checkout) is guaranteed to carry them.
      mkdirSync(join(ws, "_publish-scripts", ".github"), { recursive: true });
      cpSync(scriptsDir, join(ws, "_publish-scripts", ".github", "scripts"), {
        recursive: true,
      });
      if (withScripts) {
        mkdirSync(join(ws, ".github"), { recursive: true });
        cpSync(scriptsDir, join(ws, ".github", "scripts"), { recursive: true });
      }
      const r = spawnSync("bash", ["-e", "-c", body], {
        cwd: pkgDir,
        encoding: "utf8",
        timeout: 60000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          STUB_DIR: dir,
          GITHUB_WORKSPACE: ws,
          VERSION: "0.2.0",
          ...env,
        },
      });
      // A timeout or spawn failure surfaces as r.error, never as a status.
      expect(r.error).toBeUndefined();
      return r;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("idempotent re-run with latest on the highest version passes", () => {
    const r = runStep({ STUB_PRESENT: "1", STUB_LATEST: "0.2.0" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("the highest stable version");
  });

  it("idempotent re-run with latest lagging fails and names the repair", () => {
    const r = runStep({ STUB_PRESENT: "1", STUB_LATEST: "0.1.0" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("expected 0.2.0");
    expect(r.stderr).toContain("npm-dist-tag.yml");
  });

  it("a fresh publish with latest lagging fails", () => {
    const r = runStep({ STUB_LATEST: "0.1.0" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("expected 0.2.0");
  });

  it("a fresh publish with latest on the highest version passes", () => {
    expect(runStep({ STUB_LATEST: "0.2.0" }).status).toBe(0);
  });

  it("the landed-despite-error path checks latest too", () => {
    expect(
      runStep({ STUB_PUBLISH_FAIL: "1", STUB_LATEST: "0.2.0" }).status,
    ).toBe(0);
    const bad = runStep({ STUB_PUBLISH_FAIL: "1", STUB_LATEST: "0.1.0" });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("expected 0.2.0");
  });

  it("a tagged tree that predates the scripts still passes on a correct registry", () => {
    const r = runStep({ STUB_PRESENT: "1", STUB_LATEST: "0.2.0" }, false);
    expect(r.status).toBe(0);
  });

  it("an unreadable registry fails as 'could not verify', without the repair hint", () => {
    const r = runStep({
      STUB_PRESENT: "1",
      STUB_VIEW_FAIL: "1",
      STUB_LATEST: "0.2.0",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not verify");
    expect(r.stderr).not.toContain(
      "is not on its highest published stable version",
    );
  });

  it("a real mismatch fails with the repair hint, not 'could not verify'", () => {
    const r = runStep({ STUB_PRESENT: "1", STUB_LATEST: "0.1.0" });
    expect(r.stderr).toContain(
      "is not on its highest published stable version",
    );
    expect(r.stderr).not.toContain("could not verify");
  });
});
