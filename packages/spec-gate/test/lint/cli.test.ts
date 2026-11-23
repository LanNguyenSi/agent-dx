import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, scratch, specDir, edited } from "./helpers.js";

const NO_TRIAGE = { "triage.json": null };

function report(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trimEnd().includes("\n")).toBe(false);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("spec-gate lint", () => {
  it("lists lint and lint-ack in --help", async () => {
    const run = await runCli(["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("lint [options] <spec-dir>");
    expect(run.stdout).toContain("lint-ack [options] <spec-dir> <rule> <id>");
    const help = await runCli(["lint", "--help"]);
    expect(help.code).toBe(0);
    for (const flag of ["--strict", "--final", "--profile <profile>"]) {
      expect(help.stdout).toContain(flag);
    }
  });

  it("a clean spec: one JSON line on stdout, exit 0", async () => {
    const run = await runCli(["lint", specDir()]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(report(run.stdout)).toEqual({
      format: "spec-gate-lint/1",
      spec: "tiny-valid",
      mode: "lint",
      profile: "full",
      profile_source: "triage",
      status: "draft",
      ok: true,
      errors: [],
      warnings: [],
      acked: [],
      skipped: [],
      counts: { errors: 0, warnings: 0, acked: 0 },
    });
  });

  it("an error finding: the report is still on stdout, exit 1", async () => {
    const dir = specDir({ "testplan.yaml": null });
    const run = await runCli(["lint", dir]);
    expect(run.code).toBe(1);
    const parsed = report(run.stdout) as {
      ok: boolean;
      counts: { errors: number };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.counts.errors).toBe(1);
  });

  it("a warning alone exits 0, and 1 with --strict", async () => {
    const dir = specDir(NO_TRIAGE);
    const plain = await runCli(["lint", dir]);
    expect(plain.code).toBe(0);
    expect(report(plain.stdout)).toMatchObject({
      ok: true,
      counts: { errors: 0, warnings: 1, acked: 0 },
    });
    const strict = await runCli(["lint", dir, "--strict"]);
    expect(strict.code).toBe(1);
    expect(report(strict.stdout)).toMatchObject({
      ok: false,
      counts: { errors: 0, warnings: 1 },
    });
  });

  it("--strict passes once the warning is acknowledged with lint-ack", async () => {
    const dir = specDir(NO_TRIAGE);
    expect((await runCli(["lint", dir, "--strict"])).code).toBe(1);
    expect(
      (
        await runCli([
          "lint-ack",
          dir,
          "profile-default",
          "triage",
          "--reason",
          "later",
        ])
      ).code,
    ).toBe(0);
    const run = await runCli(["lint", dir, "--strict"]);
    expect(run.code).toBe(0);
    expect(report(run.stdout)).toMatchObject({
      ok: true,
      counts: { errors: 0, warnings: 0, acked: 1 },
    });
  });

  it("--profile sets the profile when there is no triage.json and the report says so", async () => {
    const run = await runCli([
      "lint",
      specDir(NO_TRIAGE),
      "--profile",
      "light",
    ]);
    expect(run.code).toBe(0);
    expect(report(run.stdout)).toMatchObject({
      profile: "light",
      profile_source: "flag",
      counts: { warnings: 0 },
    });
  });

  it("--profile that disagrees with triage.json exits 1", async () => {
    const run = await runCli(["lint", specDir(), "--profile", "light"]);
    expect(run.code).toBe(1);
    const parsed = report(run.stdout) as {
      errors: { rule: string }[];
      profile: string;
    };
    expect(parsed.errors.map((f) => f.rule)).toEqual(["profile-mismatch"]);
    expect(parsed.profile).toBe("full");
  });

  it("--final sets the mode in the report", async () => {
    const run = await runCli(["lint", specDir(), "--final"]);
    expect(run.code).toBe(0);
    expect(report(run.stdout)).toMatchObject({
      mode: "final",
      status: "draft",
    });
  });

  it("usage errors exit 2 with a message on stderr and nothing on stdout", async () => {
    const dir = specDir();
    for (const args of [
      ["lint"],
      ["lint", dir, "--nope"],
      ["lint", dir, "--profile", "medium"],
      ["lint", dir, "--profile"],
      ["lint", dir, "extra-argument"],
    ]) {
      const run = await runCli(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stdout, args.join(" ")).toBe("");
      expect(run.stderr, args.join(" ")).not.toBe("");
    }
  });

  it("a spec directory that is missing or not a directory exits 2", async () => {
    const holder = scratch();
    const missing = await runCli(["lint", path.join(holder, "nope")]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("is not a directory");
    fs.writeFileSync(path.join(holder, "file"), "x");
    expect((await runCli(["lint", path.join(holder, "file")])).code).toBe(2);
  });

  it("help exits 0", async () => {
    expect((await runCli(["lint", "-h"])).code).toBe(0);
  });

  it("the report has no absolute path, no timestamp and is the same on every run", async () => {
    const dir = specDir({
      "spec.md": edited("spec.md", "  - owner: alice\n", ""),
      "testplan.yaml": null,
      "triage.json": null,
    });
    const first = await runCli(["lint", dir]);
    const second = await runCli(["lint", dir]);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).not.toContain(dir);
    expect(first.stdout).not.toContain(path.dirname(dir));
    expect(first.stdout).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(first.stdout).not.toContain("/Users/");
  });

  it("a symlinked spec directory is read like a directory", async () => {
    const real = specDir();
    const holder = scratch();
    const link = path.join(holder, "link");
    fs.symlinkSync(real, link);
    const run = await runCli(["lint", link]);
    expect(run.code).toBe(0);
  });
});

describe("spec-gate lint with an empty acks.yaml", () => {
  it.each([
    ["empty", ""],
    ["comment-only", "# nothing acknowledged yet\n"],
  ])("lint: a %s acks.yaml means zero acks", async (_n, text) => {
    const run = await runCli([
      "lint",
      specDir({ ...NO_TRIAGE, "acks.yaml": text }),
    ]);
    expect(run.code).toBe(0);
    expect(report(run.stdout)).toMatchObject({
      errors: [],
      acked: [],
      warnings: [expect.objectContaining({ rule: "profile-default" })],
    });
  });

  it.each([
    ["empty", ""],
    ["comment-only", "# nothing acknowledged yet\n"],
  ])("lint-ack: appends to a %s acks.yaml", async (_n, text) => {
    const dir = specDir({ ...NO_TRIAGE, "acks.yaml": text });
    const run = await runCli([
      "lint-ack",
      dir,
      "profile-default",
      "triage",
      "--reason",
      "later",
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const linted = await runCli(["lint", dir, "--strict"]);
    expect(linted.code).toBe(0);
    expect(report(linted.stdout)).toMatchObject({
      counts: { errors: 0, warnings: 0, acked: 1 },
    });
  });
});

describe("spec-gate lint-ack: comments dropped", () => {
  const args = (dir: string) => [
    "lint-ack",
    dir,
    "profile-default",
    "triage",
    "--reason",
    "later",
  ];

  it("says on stderr that the comments were dropped when it had to rewrite the file", async () => {
    const dir = specDir({
      ...NO_TRIAGE,
      "acks.yaml": "# why\n[]\n",
    });
    const run = await runCli(args(dir));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("acknowledged profile-default triage\n");
    expect(run.stderr).toBe(
      "spec-gate: lint-ack: acks.yaml was rewritten as a block list; its comments were dropped\n",
    );
    expect(fs.readFileSync(path.join(dir, "acks.yaml"), "utf8")).not.toContain(
      "# why",
    );
  });

  it("is silent when the entry was appended and the comments are kept", async () => {
    const dir = specDir({ ...NO_TRIAGE, "acks.yaml": "# why\n" });
    const run = await runCli(args(dir));
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(
      fs
        .readFileSync(path.join(dir, "acks.yaml"), "utf8")
        .startsWith("# why\n"),
    ).toBe(true);
  });
});
