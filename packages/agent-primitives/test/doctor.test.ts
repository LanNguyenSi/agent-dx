import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { doctor } from "../src/doctor/index.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-primitives-doctor-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor", () => {
  it("finds node and npm on the real process.env.PATH", async () => {
    const result = await doctor({ required: ["node", "npm"], optional: [] });
    expect(result.status).toBe("ok");
    const node = result.tools.find((t) => t.name === "node");
    const npm = result.tools.find((t) => t.name === "npm");
    expect(node?.found).toBe(true);
    expect(node?.path).toBeTruthy();
    expect(npm?.found).toBe(true);
  });

  it("finds a stub binary on a fake PATH directory and captures its version", async () => {
    const dir = makeTmpDir();
    const stubPath = path.join(dir, "definitely-a-stub");
    fs.writeFileSync(
      stubPath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'stub-tool 9.9.9\'; fi\n',
    );
    fs.chmodSync(stubPath, 0o755);
    const result = await doctor({
      required: ["definitely-a-stub"],
      optional: [],
      pathEnv: dir,
    });
    const tool = result.tools.find((t) => t.name === "definitely-a-stub");
    expect(tool?.found).toBe(true);
    expect(tool?.path).toBe(stubPath);
    expect(tool?.version).toBe("stub-tool 9.9.9");
    expect(result.status).toBe("ok");
  });

  it("reports status missing and found: false for a binary that does not exist anywhere on PATH", async () => {
    const result = await doctor({
      required: ["git", "definitely-not-a-binary-xyz"],
      optional: [],
    });
    const tool = result.tools.find(
      (t) => t.name === "definitely-not-a-binary-xyz",
    );
    expect(tool?.found).toBe(false);
    expect(result.status).toBe("missing");
  });

  it("finds ast-grep via its sg alias", async () => {
    const dir = makeTmpDir();
    const stubPath = path.join(dir, "sg");
    fs.writeFileSync(stubPath, "#!/bin/sh\necho 'ast-grep 0.0.0-stub'\n");
    fs.chmodSync(stubPath, 0o755);
    const result = await doctor({
      required: [],
      optional: ["ast-grep"],
      pathEnv: dir,
    });
    const tool = result.tools.find((t) => t.name === "ast-grep");
    expect(tool?.found).toBe(true);
    expect(tool?.path).toBe(stubPath);
  });
});
