import { describe, expect, it } from "vitest";
import {
  accountKey,
  allowlisted,
  isLogin,
  sameAccount,
} from "../../src/approve/index.js";

describe("isLogin", () => {
  it.each(["alice", "Alice-2", "dependabot[bot]", "Ünal", "a".repeat(255)])(
    "accepts %j",
    (login) => {
      expect(isLogin(login)).toBe(true);
    },
  );

  it.each([
    ["the empty string", ""],
    ["a space", "al ice"],
    ["a tab", "alice\t"],
    ["a line end", "alice\n"],
    ["a NUL", "ali\u0000ce"],
    ["a zero-width joiner", "ali‍ce"],
    ["a right-to-left override", "‮ecila"],
    ["a private-use character", "alice"],
    ["256 characters", "a".repeat(256)],
    ["a number", 7],
    ["null", null],
    ["an object", { login: "alice" }],
  ])("refuses %s", (_what, value) => {
    expect(isLogin(value)).toBe(false);
  });
});

describe("allowlisted: is this reviewer one of the approvers", () => {
  it("ignores the case of ASCII letters, in the login and in the list", () => {
    expect(allowlisted("alice", ["Alice"])).toBe(true);
    expect(allowlisted("ALICE", ["bob", "alice"])).toBe(true);
    expect(allowlisted("alice", ["alice"])).toBe(true);
  });

  it("is false for a login that is not in the list, and for an empty list", () => {
    expect(allowlisted("mallory", ["alice", "bob"])).toBe(false);
    expect(allowlisted("alice", [])).toBe(false);
    expect(allowlisted("alic", ["alice"])).toBe(false);
    expect(allowlisted("alice2", ["alice"])).toBe(false);
  });

  it("does not take a look-alike for the approver: other scripts and compatibility forms differ", () => {
    // Cyrillic a, a full-width a, the Kelvin sign for k
    expect(allowlisted("аlice", ["alice"])).toBe(false);
    expect(allowlisted("ａlice", ["alice"])).toBe(false);
    expect(allowlisted("Kate", ["kate"])).toBe(false);
  });

  it("compares letters outside ASCII exactly", () => {
    expect(allowlisted("Ünal", ["Ünal"])).toBe(true);
    expect(allowlisted("ünal", ["Ünal"])).toBe(false);
  });

  it("does not drop the [bot] suffix: an app is not the person of that name", () => {
    expect(allowlisted("alice[bot]", ["alice"])).toBe(false);
    expect(allowlisted("alice", ["alice[bot]"])).toBe(false);
  });
});

describe("sameAccount: might this be the author or an agent identity", () => {
  it("ignores case", () => {
    expect(sameAccount("Spec-Bot", "spec-bot")).toBe(true);
    expect(sameAccount("ünal", "ÜNAL")).toBe(true);
  });

  it("ignores the [bot] suffix on either side, in any case", () => {
    expect(sameAccount("spec-bot[bot]", "Spec-Bot")).toBe(true);
    expect(sameAccount("spec-bot", "spec-bot[BOT]")).toBe(true);
    expect(sameAccount("spec-bot[bot]", "spec-bot[bot]")).toBe(true);
  });

  it("ignores compatibility forms and special case forms", () => {
    expect(sameAccount("ａlice", "alice")).toBe(true);
    expect(sameAccount("Kate", "kate")).toBe(true);
    expect(sameAccount("straße", "STRASSE")).toBe(true);
  });

  it("is false for two different names", () => {
    expect(sameAccount("alice", "bob")).toBe(false);
    expect(sameAccount("spec-bot", "spec-bot2")).toBe(false);
    expect(sameAccount("spec-bot[bot]x", "spec-bot")).toBe(false);
  });
});

describe("accountKey", () => {
  it("is one key for every case of a login and keeps the [bot] suffix", () => {
    expect(accountKey("Alice")).toBe(accountKey("aLICE"));
    expect(accountKey("alice[bot]")).not.toBe(accountKey("alice"));
  });
});
