import { execFile } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratch, validFiles } from "./lint/helpers.js";

const execFileAsync = promisify(execFile);

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cli = cliPath): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli,
      ...args,
    ]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("spec-gate CLI", () => {
  it("--version prints the package.json version and exits 0", async () => {
    const run = await runCli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(pkg.version);
  });

  it("--help exits 0 and names the program", async () => {
    const run = await runCli(["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Usage: ${pkg.name}`);
  });

  it("an unknown option exits non-zero with a usage message on stderr", async () => {
    const run = await runCli(["--nope"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("unknown option");
    expect(run.stderr).toContain("Usage: spec-gate");
  });

  it("an unknown command exits non-zero with a usage message on stderr", async () => {
    const run = await runCli(["frobnicate"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("unknown command");
    expect(run.stderr).toContain("Usage: spec-gate");
  });

  describe("version source", () => {
    const tmpRoots: string[] = [];
    afterEach(() => {
      for (const dir of tmpRoots.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // The copy lives inside the package so that `commander` still resolves
    // from the package's node_modules. The whole `dist` tree is copied:
    // `cli.js` imports the triage and format modules by relative path, so a
    // lone `cli.js` would fail to load.
    function copyCli(pkgJson: string): string {
      const root = fs.mkdtempSync(
        path.join(fileURLToPath(new URL("..", import.meta.url)), ".tmp-cli-"),
      );
      tmpRoots.push(root);
      // The whole build output: cli.js imports the modules next to it.
      fs.cpSync(path.dirname(cliPath), path.join(root, "dist"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, "package.json"), pkgJson);
      return path.join(root, "dist", "cli.js");
    }

    it("--version reads the version from the package.json next to dist", async () => {
      const cli = copyCli(JSON.stringify({ version: "9.8.7", type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe("9.8.7");
    });

    it("fails loudly when package.json has no version", async () => {
      const cli = copyCli(JSON.stringify({ type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("no version");
    });

    it("fails loudly when package.json has an empty version", async () => {
      const cli = copyCli(JSON.stringify({ version: "", type: "module" }));
      const run = await runCli(["--version"], cli);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("no version");
    });
  });
});

describe("spec-gate questions, answer and status", () => {
  const qfile = (questions: unknown[], answers: unknown[]): string =>
    JSON.stringify({ questions, answers });
  const qn = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    target: "AC-1",
    class: "blind-spot",
    blocking: false,
    question: `Open point ${id}?`,
    options: [],
    ...over,
  });

  function specHome(questions: unknown[], answers: unknown[]): string {
    const dir = path.join(scratch(), "specs", "s1");
    for (const [rel, text] of Object.entries(
      Object.assign(validFiles(), {
        "questions.json": qfile(questions, answers),
      }),
    )) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return dir;
  }

  describe("questions", () => {
    it("exits 1 and prints spec-gate-questions/1 with an unanswered question", async () => {
      const dir = specHome([qn("QN-1", { blocking: true })], []);
      const run = await runCli(["questions", dir]);
      expect(run.code).toBe(1);
      const report = JSON.parse(run.stdout) as {
        format: string;
        counts: { unanswered: number };
      };
      expect(report.format).toBe("spec-gate-questions/1");
      expect(report.counts.unanswered).toBe(1);
    });

    it("exits 0 when nothing is unanswered", async () => {
      const run = await runCli(["questions", specHome([], [])]);
      expect(run.code).toBe(0);
    });

    it("exits 2 on a directory that is not one", async () => {
      const run = await runCli(["questions", path.join(scratch(), "nope")]);
      expect(run.code).toBe(2);
    });
  });

  describe("answer", () => {
    it("exits 0 and writes the answer, then exits 2 on a second answer", async () => {
      const dir = specHome([qn("QN-1")], []);
      const run = await runCli([
        "answer",
        dir,
        "QN-1",
        "--answer",
        "yes",
        "--channel",
        "chat",
        "--author",
        "alice",
      ]);
      expect(run.code).toBe(0);
      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "questions.json"), "utf8"),
      ) as { answers: { question: string; time: string }[] };
      expect(written.answers.map((a) => a.question)).toEqual(["QN-1"]);
      expect(written.answers[0]!.time).toMatch(
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/,
      );
      const again = await runCli([
        "answer",
        dir,
        "QN-1",
        "--answer",
        "no",
        "--channel",
        "chat",
        "--author",
        "alice",
      ]);
      expect(again.code).toBe(2);
    });

    it("exits 2 when --channel is missing", async () => {
      const dir = specHome([qn("QN-1")], []);
      const run = await runCli([
        "answer",
        dir,
        "QN-1",
        "--answer",
        "yes",
        "--author",
        "alice",
      ]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("--channel");
    });

    it("exits 2 when --accept-recommended is given with --option", async () => {
      const dir = specHome(
        [
          qn("QN-1", {
            class: "divergence",
            options: [{ label: "keep", consequence: "sessions stay" }],
            recommended: "keep",
          }),
        ],
        [],
      );
      const run = await runCli([
        "answer",
        dir,
        "QN-1",
        "--accept-recommended",
        "--option",
        "keep",
        "--channel",
        "chat",
        "--author",
        "alice",
      ]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("--option");
    });
  });

  describe("status", () => {
    it("exits 0 and prints spec-gate-status/1", async () => {
      const run = await runCli(["status", specHome([], [])]);
      expect(run.code).toBe(0);
      const report = JSON.parse(run.stdout) as {
        format: string;
        status: string;
      };
      expect(report.format).toBe("spec-gate-status/1");
      expect(report.status).toBe("draft");
    });

    it("exits 2 on a directory that is not one", async () => {
      const run = await runCli(["status", path.join(scratch(), "nope")]);
      expect(run.code).toBe(2);
    });
  });
});
