import { expect, it } from "vitest";
import {
  GIT_TIMEOUT_MS,
  IntakeError,
  resolveGitTimeoutMs,
} from "../src/intake/index.js";

const NO_ENV: NodeJS.ProcessEnv = {};

function refusal(fn: () => unknown): IntakeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(IntakeError);
    return err as IntakeError;
  }
  throw new Error("expected a refusal");
}

it("the default constant is 15 seconds and the default is used when neither flag nor env is set", () => {
  expect(GIT_TIMEOUT_MS).toBe(15_000);
  expect(resolveGitTimeoutMs(undefined, NO_ENV)).toBe(15_000);
});

it("flag only: the flag value is used", () => {
  expect(resolveGitTimeoutMs("30", NO_ENV)).toBe(30_000);
});

it("env only: the env value is used", () => {
  expect(resolveGitTimeoutMs(undefined, { SPEC_GATE_GIT_TIMEOUT: "45" })).toBe(
    45_000,
  );
});

it("flag and env both valid: the flag wins", () => {
  expect(resolveGitTimeoutMs("30", { SPEC_GATE_GIT_TIMEOUT: "45" })).toBe(
    30_000,
  );
});

it("flag valid and env invalid: the flag wins and the env is not read", () => {
  expect(resolveGitTimeoutMs("30", { SPEC_GATE_GIT_TIMEOUT: "abc" })).toBe(
    30_000,
  );
  expect(resolveGitTimeoutMs("30", { SPEC_GATE_GIT_TIMEOUT: "" })).toBe(30_000);
});

it("flag invalid and env valid: refused, the env never replaces the flag", () => {
  const err = refusal(() =>
    resolveGitTimeoutMs("abc", { SPEC_GATE_GIT_TIMEOUT: "45" }),
  );
  expect(err.code).toBe("bad-git-timeout");
  expect(err.message).toContain("--git-timeout");
});

it("env set to the empty string with no flag: refused, not treated as absent", () => {
  const err = refusal(() =>
    resolveGitTimeoutMs(undefined, { SPEC_GATE_GIT_TIMEOUT: "" }),
  );
  expect(err.code).toBe("bad-git-timeout");
  expect(err.message).toContain("SPEC_GATE_GIT_TIMEOUT");
});

it("flag given as the empty string: refused", () => {
  expect(refusal(() => resolveGitTimeoutMs("", NO_ENV)).code).toBe(
    "bad-git-timeout",
  );
});

it("the bounds 1 and 3600 are accepted", () => {
  expect(resolveGitTimeoutMs("1", NO_ENV)).toBe(1000);
  expect(resolveGitTimeoutMs("3600", NO_ENV)).toBe(3_600_000);
});

const INVALID = [
  "0",
  "-5",
  "abc",
  "1.5",
  "1e3",
  " 30",
  "30 ",
  "3601",
  "007",
  "",
];

for (const value of INVALID) {
  it(`flag value ${JSON.stringify(value)} is refused without echoing it`, () => {
    const err = refusal(() => resolveGitTimeoutMs(value, NO_ENV));
    expect(err.code).toBe("bad-git-timeout");
    expect(err.message).toContain("--git-timeout");
    expect(err.message).toContain("1 to 3600");
    const withoutRange = err.message.replace("1 to 3600", "");
    if (value.trim() !== "") expect(withoutRange).not.toContain(value);
  });
  it(`env value ${JSON.stringify(value)} is refused without echoing it`, () => {
    const err = refusal(() =>
      resolveGitTimeoutMs(undefined, { SPEC_GATE_GIT_TIMEOUT: value }),
    );
    expect(err.code).toBe("bad-git-timeout");
    expect(err.message).toContain("SPEC_GATE_GIT_TIMEOUT");
    expect(err.message).toContain("1 to 3600");
    const withoutRange = err.message.replace("1 to 3600", "");
    if (value.trim() !== "") expect(withoutRange).not.toContain(value);
  });
}
