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

  it("accepts the -v alias for an explicit version on `prep`", async () => {
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
      version: "9.9.9",
      dryRun: true,
    });
  });

  // Regression for df353865-7e8b-4935-89a8-0074cfe884cc: the `prep` subcommand
  // declares `-v, --version <version>` but the root program also exposes
  // commander's built-in `--version` (from `.version("0.1.0")`). When invoked
  // as `prep --version <value>`, commander short-circuits on the root flag and
  // prints "0.1.0" instead of forwarding to the prep handler.
  //
  // `it.fails` documents the bug without breaking CI. When df353865 is fixed
  // (e.g. by renaming the subcommand flag to `--target-version`), this test
  // must be flipped to `it(...)`, which gives the fix a clean ratchet.
  it.fails(
    "forwards `prep --version <value>` to runPrep without colliding with root --version (df353865)",
    async () => {
      const runPrep = vi.fn().mockResolvedValue(undefined);
      const program = makeProgram({ runPrep });

      try {
        await program.parseAsync([
          "node",
          "release-prep",
          "prep",
          "--version",
          "9.9.9",
          "--dry-run",
        ]);
      } catch {
        // commander.exitOverride() throws when --version short-circuits.
      }

      expect(runPrep).toHaveBeenCalledOnce();
      expect(runPrep.mock.calls[0]?.[0]).toMatchObject({
        version: "9.9.9",
        dryRun: true,
      });
    },
  );

  it("rejects an unknown subcommand", async () => {
    const program = makeProgram();

    await expect(
      program.parseAsync(["node", "release-prep", "not-a-command"]),
    ).rejects.toThrow();
  });
});
