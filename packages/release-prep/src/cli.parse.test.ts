import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "./cli.js";

function makeProgram(
  handlers: Parameters<typeof buildProgram>[0] = {},
): ReturnType<typeof buildProgram> {
  const program = buildProgram(handlers);
  program.exitOverride();
  return program;
}

describe("release-prep CLI parser", () => {
  it("routes `version` to suggestVersion", async () => {
    const suggestVersion = vi.fn().mockResolvedValue(undefined);
    const program = makeProgram({ suggestVersion });

    await program.parseAsync(["node", "release-prep", "version"]);

    expect(suggestVersion).toHaveBeenCalledOnce();
  });

  it("passes --format and --output through to generateChangelog", async () => {
    const generateChangelog = vi.fn().mockResolvedValue(undefined);
    const program = makeProgram({ generateChangelog });

    await program.parseAsync([
      "node",
      "release-prep",
      "changelog",
      "--format",
      "json",
      "-o",
      "/tmp/release-prep-out.md",
    ]);

    expect(generateChangelog).toHaveBeenCalledOnce();
    expect(generateChangelog.mock.calls[0]?.[0]).toMatchObject({
      format: "json",
      output: "/tmp/release-prep-out.md",
    });
  });

  it("passes --type and --dry-run plus --no-tag / --no-release to runPrep", async () => {
    const runPrep = vi.fn().mockResolvedValue(undefined);
    const program = makeProgram({ runPrep });

    await program.parseAsync([
      "node",
      "release-prep",
      "prep",
      "--type",
      "minor",
      "--dry-run",
      "--no-tag",
      "--no-release",
    ]);

    expect(runPrep).toHaveBeenCalledOnce();
    expect(runPrep.mock.calls[0]?.[0]).toMatchObject({
      type: "minor",
      dryRun: true,
      tag: false,
      release: false,
    });
  });

  it("forwards `prep --target-version <value>` to runPrep (df353865 fix)", async () => {
    const runPrep = vi.fn().mockResolvedValue(undefined);
    const program = makeProgram({ runPrep });

    await program.parseAsync([
      "node",
      "release-prep",
      "prep",
      "--target-version",
      "9.9.9",
      "--dry-run",
    ]);

    expect(runPrep).toHaveBeenCalledOnce();
    expect(runPrep.mock.calls[0]?.[0]).toMatchObject({
      targetVersion: "9.9.9",
      dryRun: true,
    });
  });

  it("accepts the -v short alias for --target-version on `prep`", async () => {
    const runPrep = vi.fn().mockResolvedValue(undefined);
    const program = makeProgram({ runPrep });

    await program.parseAsync([
      "node",
      "release-prep",
      "prep",
      "-v",
      "9.9.9",
      "--dry-run",
    ]);

    expect(runPrep).toHaveBeenCalledOnce();
    expect(runPrep.mock.calls[0]?.[0]).toMatchObject({
      targetVersion: "9.9.9",
      dryRun: true,
    });
  });

  // The subcommand option was renamed from --version to --target-version in
  // df353865. Commander's built-in --version on the root program now owns the
  // long form unambiguously; invoking `prep --version` short-circuits to the
  // root version-printer (and exitOverride throws CommanderError version), the
  // prep handler is never called. This test pins that contract so a future
  // change that re-introduces a subcommand --version trips it.
  it("treats `prep --version` as the root version short-circuit, not a prep option", async () => {
    const runPrep = vi.fn().mockResolvedValue(undefined);
    const program = makeProgram({ runPrep });

    await expect(
      program.parseAsync([
        "node",
        "release-prep",
        "prep",
        "--version",
      ]),
    ).rejects.toThrow();
    expect(runPrep).not.toHaveBeenCalled();
  });

  it("rejects an unknown subcommand", async () => {
    const program = makeProgram();

    await expect(
      program.parseAsync(["node", "release-prep", "not-a-command"]),
    ).rejects.toThrow();
  });
});
