import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import {
  lintSpecDir,
  parseAcks,
  writeAck,
  type RuleDef,
} from "../../src/lint/index.js";
import { runCli, scratch, specDir } from "./helpers.js";

const NO_TRIAGE = { "triage.json": null };
const acksPath = (dir: string) => path.join(dir, "acks.yaml");
const read = (dir: string) => fs.readFileSync(acksPath(dir), "utf8");
const refused = (r: ReturnType<typeof writeAck>) => (r.ok ? "" : r.message);

const ENTRY =
  '- rule: "profile-default"\n  id: "triage"\n  reason: "triage runs later"\n';

describe("lint-ack writer: what it writes", () => {
  it("creates acks.yaml when it is absent, as one block entry", () => {
    const dir = specDir(NO_TRIAGE);
    const result = writeAck(
      dir,
      "profile-default",
      "triage",
      "triage runs later",
    );
    expect(result).toMatchObject({ ok: true, entries: 1, normalised: false });
    expect(read(dir)).toBe(ENTRY);
  });

  it("the entry it writes acknowledges the warning in the next lint run", () => {
    const dir = specDir(NO_TRIAGE);
    writeAck(dir, "profile-default", "triage", "triage runs later");
    const result = lintSpecDir(dir, { strict: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.report.ok).toBe(true);
    expect(result.report.acked).toHaveLength(1);
  });

  it("keeps the existing bytes and appends the entry after them", () => {
    const existing =
      "# acknowledged warnings\n- rule: other-warning   # note\n  id: AC-1\n  reason: kept as is\n";
    const dir = specDir({ ...NO_TRIAGE, "acks.yaml": existing });
    const result = writeAck(
      dir,
      "profile-default",
      "triage",
      "triage runs later",
    );
    expect(result).toMatchObject({ ok: true, entries: 2, normalised: false });
    expect(read(dir)).toBe(existing + ENTRY);
  });

  it("adds a line feed first when the file does not end in one", () => {
    const existing = "- {rule: other-warning, id: AC-1, reason: kept}";
    const dir = specDir({ ...NO_TRIAGE, "acks.yaml": existing });
    expect(writeAck(dir, "profile-default", "triage", "r").ok).toBe(true);
    expect(read(dir)).toBe(
      `${existing}\n${ENTRY.replace("triage runs later", "r")}`,
    );
  });

  it("appends to a CRLF file without touching its lines", () => {
    const existing =
      "- rule: other-warning\r\n  id: AC-1\r\n  reason: kept\r\n";
    const dir = specDir({ ...NO_TRIAGE, "acks.yaml": existing });
    expect(
      writeAck(dir, "profile-default", "triage", "triage runs later"),
    ).toMatchObject({
      ok: true,
      normalised: false,
    });
    expect(read(dir).startsWith(existing)).toBe(true);
    const parsed = parseAcks(read(dir));
    expect(parsed.ok && parsed.value.map((a) => a.rule)).toEqual([
      "other-warning",
      "profile-default",
    ]);
  });

  it("rewrites a flow-style list as a block list and says so", () => {
    const dir = specDir({ ...NO_TRIAGE, "acks.yaml": "[]\n" });
    expect(
      writeAck(dir, "profile-default", "triage", "triage runs later"),
    ).toMatchObject({
      ok: true,
      normalised: true,
    });
    expect(read(dir)).toBe(ENTRY);
    const dir2 = specDir({
      ...NO_TRIAGE,
      "acks.yaml": "[{rule: other-warning, id: AC-1, reason: kept}]\n",
    });
    expect(
      writeAck(dir2, "profile-default", "triage", "triage runs later").ok,
    ).toBe(true);
    const parsed = parseAcks(read(dir2));
    expect(parsed.ok && parsed.value).toEqual([
      { rule: "other-warning", id: "AC-1", reason: "kept" },
      { rule: "profile-default", id: "triage", reason: "triage runs later" },
    ]);
  });

  it("quotes a reason that YAML would read as something else", () => {
    const dir = specDir(NO_TRIAGE);
    const reason = 'yes: "quoted" # not a comment, ends with a colon:';
    expect(writeAck(dir, "profile-default", "triage", reason).ok).toBe(true);
    const parsed = parseAcks(read(dir));
    expect(parsed.ok && parsed.value[0]!.reason).toBe(reason);
  });

  it("keeps the permission bits of an existing file and adds no special bit to a new one", () => {
    const dir = specDir({
      ...NO_TRIAGE,
      "acks.yaml": ENTRY.replace("triage", "other"),
    });
    fs.chmodSync(acksPath(dir), 0o4640);
    expect(writeAck(dir, "profile-default", "triage", "r").ok).toBe(true);
    expect(fs.statSync(acksPath(dir)).mode & 0o7777).toBe(0o640);
    const fresh = specDir(NO_TRIAGE);
    writeAck(fresh, "profile-default", "triage", "r");
    expect(fs.statSync(acksPath(fresh)).mode & 0o7000).toBe(0);
  });

  it("leaves no temporary file behind", () => {
    const dir = specDir(NO_TRIAGE);
    writeAck(dir, "profile-default", "triage", "r");
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("lint-ack writer: what it refuses", () => {
  const dir = () => specDir(NO_TRIAGE);

  it("a rule that is not registered", () => {
    const d = dir();
    expect(refused(writeAck(d, "no-such-rule", "x", "r"))).toContain(
      "not a known rule",
    );
    expect(fs.existsSync(acksPath(d))).toBe(false);
  });

  it("a rule at error level, and a warning that cannot be acknowledged", () => {
    const d = dir();
    expect(refused(writeAck(d, "goal-count", "GOAL", "r"))).toContain(
      "error rule",
    );
    expect(refused(writeAck(d, "ack-unused", "x", "r"))).toContain(
      "cannot be acknowledged",
    );
    expect(fs.existsSync(acksPath(d))).toBe(false);
  });

  it("an id or a reason that is empty, blank, multi-line or has a control character", () => {
    const d = dir();
    for (const bad of [
      "",
      "   ",
      "a\nb",
      "a\rb",
      "a\tb",
      "a\u0000b",
      "a\u2028b",
    ]) {
      expect(
        refused(writeAck(d, "profile-default", bad, "r")),
        JSON.stringify(bad),
      ).toMatch(/^lint-ack: id /);
      expect(
        refused(writeAck(d, "profile-default", "triage", bad)),
        JSON.stringify(bad),
      ).toMatch(/^lint-ack: reason /);
    }
    expect(fs.existsSync(acksPath(d))).toBe(false);
  });

  it("a duplicate (rule, id), leaving the file as it was", () => {
    const d = dir();
    expect(writeAck(d, "profile-default", "triage", "first").ok).toBe(true);
    const before = read(d);
    expect(
      refused(writeAck(d, "profile-default", "triage", "second")),
    ).toContain("already acknowledged");
    expect(read(d)).toBe(before);
  });

  it("the same rule for another id is not a duplicate", () => {
    const d = dir();
    expect(writeAck(d, "profile-default", "triage", "first").ok).toBe(true);
    expect(writeAck(d, "profile-default", "other", "second")).toMatchObject({
      ok: true,
      entries: 2,
    });
  });

  it("an existing acks.yaml that is not valid, leaving it as it was", () => {
    const d = specDir({ ...NO_TRIAGE, "acks.yaml": "not: a list\n" });
    expect(refused(writeAck(d, "profile-default", "triage", "r"))).toContain(
      "not valid",
    );
    expect(read(d)).toBe("not: a list\n");
  });

  it("an acks.yaml that is a symlink, even to a valid file", () => {
    const d = dir();
    fs.writeFileSync(
      path.join(d, "real.yaml"),
      ENTRY.replace("triage", "other"),
    );
    fs.symlinkSync("real.yaml", acksPath(d));
    expect(refused(writeAck(d, "profile-default", "triage", "r"))).toContain(
      "symlink",
    );
    expect(fs.readFileSync(path.join(d, "real.yaml"), "utf8")).toBe(
      ENTRY.replace("triage", "other"),
    );
    expect(fs.lstatSync(acksPath(d)).isSymbolicLink()).toBe(true);
  });

  it("an acks.yaml that is a dangling symlink", () => {
    const d = dir();
    fs.symlinkSync("nowhere.yaml", acksPath(d));
    expect(refused(writeAck(d, "profile-default", "triage", "r"))).toContain(
      "symlink",
    );
    expect(fs.existsSync(path.join(d, "nowhere.yaml"))).toBe(false);
  });

  it("an acks.yaml that is a directory", () => {
    const d = dir();
    fs.mkdirSync(acksPath(d));
    expect(writeAck(d, "profile-default", "triage", "r").ok).toBe(false);
    expect(fs.statSync(acksPath(d)).isDirectory()).toBe(true);
  });

  it("a spec directory that is a symlink, writing nothing through it", () => {
    const real = dir();
    const holder = scratch();
    const link = path.join(holder, "link");
    fs.symlinkSync(real, link);
    expect(refused(writeAck(link, "profile-default", "triage", "r"))).toContain(
      "symlink",
    );
    expect(fs.existsSync(acksPath(real))).toBe(false);
  });

  it("a spec directory that does not exist or is a file", () => {
    const holder = scratch();
    expect(
      refused(
        writeAck(path.join(holder, "nope"), "profile-default", "triage", "r"),
      ),
    ).toContain("not a directory");
    fs.writeFileSync(path.join(holder, "file"), "x");
    expect(
      refused(
        writeAck(path.join(holder, "file"), "profile-default", "triage", "r"),
      ),
    ).toContain("not a directory");
    expect(fs.readFileSync(path.join(holder, "file"), "utf8")).toBe("x");
  });

  it("every refusal message starts with lint-ack and holds no absolute path", () => {
    const d = dir();
    const message = refused(writeAck(d, "no-such-rule", "x", "r"));
    expect(message.startsWith("lint-ack: ")).toBe(true);
    expect(message).not.toContain(d);
  });
});

describe("lint-ack writer: duplicates and fallbacks", () => {
  const rule = (id: string): RuleDef => ({
    id,
    level: "warning",
    profiles: ["light", "full"],
    gated: false,
    ackable: true,
    summary: "s",
    needs: [],
  });

  it("the same id under another rule is not a duplicate", () => {
    const d = specDir();
    const rules = [rule("w-one"), rule("w-two")];
    expect(writeAck(d, "w-one", "AC-1", "r", rules).ok).toBe(true);
    expect(writeAck(d, "w-two", "AC-1", "r", rules)).toMatchObject({
      ok: true,
      entries: 2,
    });
    expect(refused(writeAck(d, "w-one", "AC-1", "r", rules))).toContain(
      "already acknowledged",
    );
  });

  it("a document closed by an end marker is rewritten as a block list", () => {
    const d = specDir({
      ...NO_TRIAGE,
      "acks.yaml": "- {rule: other-warning, id: AC-1, reason: kept}\n...\n",
    });
    expect(
      writeAck(d, "profile-default", "triage", "triage runs later"),
    ).toMatchObject({ ok: true, entries: 2, normalised: true });
    const parsed = parseAcks(read(d));
    expect(parsed.ok && parsed.value.map((a) => a.rule)).toEqual([
      "other-warning",
      "profile-default",
    ]);
  });

  it("a rule that is not registered is refused with that reason, not another", () => {
    const d = specDir();
    expect(refused(writeAck(d, "goal-count", "GOAL", "r"))).toContain(
      "error rule",
    );
    expect(refused(writeAck(d, "no-such-rule", "x", "r"))).toContain(
      "not a known rule",
    );
  });
});

describe("lint-ack writer: atomic write", () => {
  it("never reuses or removes a path that already sits at the temporary name", () => {
    const d = specDir({
      ...NO_TRIAGE,
      "acks.yaml": ENTRY.replace("triage", "other"),
    });
    const before = read(d);
    const temp = `${acksPath(d)}.tmp-${process.pid}`;
    fs.writeFileSync(temp, "someone else's file");
    expect(refused(writeAck(d, "profile-default", "triage", "r"))).toContain(
      "cannot write",
    );
    expect(read(d)).toBe(before);
    expect(fs.readFileSync(temp, "utf8")).toBe("someone else's file");
  });

  it.skipIf(process.getuid?.() === 0)(
    "a directory that cannot be written leaves the file untouched and no temporary file",
    () => {
      const d = specDir({
        ...NO_TRIAGE,
        "acks.yaml": ENTRY.replace("triage", "other"),
      });
      const before = read(d);
      fs.chmodSync(d, 0o555);
      try {
        expect(
          refused(writeAck(d, "profile-default", "triage", "r")),
        ).toContain("cannot write");
      } finally {
        fs.chmodSync(d, 0o755);
      }
      expect(read(d)).toBe(before);
      expect(fs.readdirSync(d).filter((n) => n.includes(".tmp-"))).toEqual([]);
    },
  );

  it("a failed rename removes the temporary file it created and keeps the original", () => {
    const existing = ENTRY.replace("triage", "other");
    const d = specDir({ ...NO_TRIAGE, "acks.yaml": existing });
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EXDEV" });
    });
    try {
      expect(refused(writeAck(d, "profile-default", "triage", "r"))).toContain(
        "cannot write acks.yaml: EXDEV",
      );
    } finally {
      spy.mockRestore();
    }
    expect(read(d)).toBe(existing);
    expect(fs.readdirSync(d).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("replaces the file by rename: another handle on the old file keeps the old text", () => {
    const existing = ENTRY.replace("triage", "other");
    const d = specDir({ ...NO_TRIAGE, "acks.yaml": existing });
    const fd = fs.openSync(acksPath(d), "r");
    try {
      writeAck(d, "profile-default", "triage", "r");
      expect(fs.readFileSync(fd, "utf8")).toBe(existing);
    } finally {
      fs.closeSync(fd);
    }
    expect(read(d).length).toBeGreaterThan(existing.length);
  });
});

describe("lint-ack writer: refusals the review pinned", () => {
  it.skipIf(process.getuid?.() === 0)(
    "a read-only acks.yaml in a writable directory is refused and kept",
    () => {
      const existing = ENTRY.replace("triage", "other");
      const d = specDir({ ...NO_TRIAGE, "acks.yaml": existing });
      fs.chmodSync(acksPath(d), 0o444);
      expect(refused(writeAck(d, "profile-default", "triage", "r"))).toContain(
        "cannot write acks.yaml",
      );
      expect(read(d)).toBe(existing);
      expect(fs.readdirSync(d).filter((n) => n.includes(".tmp-"))).toEqual([]);
    },
  );

  it("a symlinked spec directory named with a trailing slash is refused", () => {
    const real = specDir(NO_TRIAGE);
    const link = path.join(scratch(), "link");
    fs.symlinkSync(real, link);
    expect(
      refused(writeAck(`${link}/`, "profile-default", "triage", "r")),
    ).toContain("is a symlink");
    expect(fs.existsSync(acksPath(real))).toBe(false);
  });
});

describe("lint-ack writer: temporary file", () => {
  it("a failed write after the exclusive create removes the temporary file and keeps the original", () => {
    const existing = ENTRY.replace("triage", "other");
    const d = specDir({ ...NO_TRIAGE, "acks.yaml": existing });
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    });
    try {
      expect(refused(writeAck(d, "profile-default", "triage", "r"))).toContain(
        "cannot write acks.yaml: ENOSPC",
      );
    } finally {
      spy.mockRestore();
    }
    expect(read(d)).toBe(existing);
    expect(fs.readdirSync(d).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  /** The mode argument of the `openSync` call that creates the temporary file. */
  function createMode(run: () => void): number | undefined {
    const spy = vi.spyOn(fs, "openSync");
    try {
      run();
      const call = spy.mock.calls.find(
        ([target]) => typeof target === "string" && target.includes(".tmp-"),
      );
      return call?.[2] as number | undefined;
    } finally {
      spy.mockRestore();
    }
  }

  it("is created with the mode of the existing file", () => {
    const d = specDir({
      ...NO_TRIAGE,
      "acks.yaml": ENTRY.replace("triage", "other"),
    });
    fs.chmodSync(acksPath(d), 0o664);
    const mode = createMode(() => {
      expect(writeAck(d, "profile-default", "triage", "r").ok).toBe(true);
    });
    expect(mode).toBe(0o664);
    expect(fs.statSync(acksPath(d)).mode & 0o777).toBe(0o664);
  });

  it("is created with the default mode when the file is new, and the umask applies", () => {
    const d = specDir(NO_TRIAGE);
    const mode = createMode(() => {
      expect(writeAck(d, "profile-default", "triage", "r").ok).toBe(true);
    });
    expect(mode).toBe(0o666);
    expect(fs.statSync(acksPath(d)).mode & 0o777).toBe(
      0o666 & ~process.umask(),
    );
  });
});

describe("lint-ack writer: an empty or comment-only file", () => {
  it.each([
    ["empty", ""],
    ["comment-only", "# acknowledged warnings\n"],
    ["comment-only without a final line feed", "# acknowledged warnings"],
  ])("%s: the entry is appended and nothing else is normalised", (_n, text) => {
    const d = specDir({ ...NO_TRIAGE, "acks.yaml": text });
    const result = writeAck(d, "profile-default", "triage", "r");
    expect(result).toMatchObject({ ok: true, entries: 1, normalised: false });
    const glue = text === "" || text.endsWith("\n") ? "" : "\n";
    expect(read(d)).toBe(
      text +
        glue +
        '- rule: "profile-default"\n  id: "triage"\n  reason: "r"\n',
    );
    const linted = lintSpecDir(d, { strict: true });
    if (!linted.ok) throw new Error(linted.message);
    expect(linted.report.acked).toHaveLength(1);
  });

  it("parseAcks reads such a file as zero acks", () => {
    for (const text of ["", "\n\n", "# only a comment\n"]) {
      expect(parseAcks(text)).toEqual({ ok: true, value: [] });
    }
  });
});

describe("lint-ack writer: rules come from the registry", () => {
  it("acknowledges any registered ackable warning", () => {
    const extra: RuleDef = {
      id: "extra-warning",
      level: "warning",
      profiles: ["light", "full"],
      gated: false,
      ackable: true,
      summary: "s",
      needs: [],
    };
    const d = specDir();
    expect(writeAck(d, "extra-warning", "AC-1", "r", [extra]).ok).toBe(true);
    expect(writeAck(d, "extra-warning", "AC-2", "r").ok).toBe(false);
  });
});

describe("spec-gate lint-ack (CLI)", () => {
  it("exits 0 and writes the entry", async () => {
    const d = specDir(NO_TRIAGE);
    const run = await runCli([
      "lint-ack",
      d,
      "profile-default",
      "triage",
      "--reason",
      "triage runs later",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("acknowledged profile-default triage\n");
    expect(read(d)).toBe(ENTRY);
  });

  it("exits 2 with a message on stderr for a refusal, writing nothing", async () => {
    const d = specDir(NO_TRIAGE);
    const run = await runCli([
      "lint-ack",
      d,
      "goal-count",
      "GOAL",
      "--reason",
      "r",
    ]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("lint-ack: goal-count is an error rule");
    expect(fs.existsSync(acksPath(d))).toBe(false);
  });

  it("exits 2 for a missing --reason, a missing argument and an unknown option", async () => {
    const d = specDir(NO_TRIAGE);
    expect(
      (await runCli(["lint-ack", d, "profile-default", "triage"])).code,
    ).toBe(2);
    expect((await runCli(["lint-ack", d, "profile-default"])).code).toBe(2);
    expect(
      (
        await runCli([
          "lint-ack",
          d,
          "profile-default",
          "triage",
          "--reason",
          "r",
          "--nope",
        ])
      ).code,
    ).toBe(2);
    expect(fs.existsSync(acksPath(d))).toBe(false);
  });

  it("exits 2 for a spec directory that is not one", async () => {
    const holder = scratch();
    const run = await runCli([
      "lint-ack",
      path.join(holder, "nope"),
      "profile-default",
      "triage",
      "--reason",
      "r",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("lint-ack:");
  });
});
