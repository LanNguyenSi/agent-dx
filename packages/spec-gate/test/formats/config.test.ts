import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUESTIONS_WARN_ABOVE,
  parseConfig,
  validateConfig,
} from "../../src/formats/index.js";

describe("config.yaml defaults", () => {
  it("defaults warn_above to 7", () => {
    expect(DEFAULT_QUESTIONS_WARN_ABOVE).toBe(7);
  });

  it("an empty mapping takes every default", () => {
    expect(validateConfig({})).toEqual({
      ok: true,
      value: {
        questions: { warn_above: 7 },
        approvers: [],
        agent_identities: [],
        signing_keys: [],
      },
    });
  });

  it("an absent questions block, an empty one and an absent warn_above all give 7", () => {
    for (const doc of [{}, { questions: {} }, { approvers: ["a"] }]) {
      const r = validateConfig(doc);
      expect(r.ok && r.value.questions.warn_above).toBe(7);
    }
  });

  it("an explicit warn_above wins over the default, whatever else is set", () => {
    for (const n of [1, 3, 7, 100]) {
      const alone = validateConfig({ questions: { warn_above: n } });
      expect(alone.ok && alone.value.questions.warn_above).toBe(n);
      const together = validateConfig({
        questions: { warn_above: n },
        approvers: ["a"],
        agent_identities: ["bot"],
        signing_keys: ["k"],
      });
      expect(together.ok && together.value.questions.warn_above).toBe(n);
    }
  });

  it("each list set alone leaves the others empty", () => {
    const only = (key: string) => {
      const r = validateConfig({ [key]: ["x"] });
      if (!r.ok) throw new Error("not ok");
      return r.value;
    };
    expect(only("approvers")).toMatchObject({
      approvers: ["x"],
      agent_identities: [],
      signing_keys: [],
    });
    expect(only("agent_identities")).toMatchObject({
      approvers: [],
      agent_identities: ["x"],
      signing_keys: [],
    });
    expect(only("signing_keys")).toMatchObject({
      approvers: [],
      agent_identities: [],
      signing_keys: ["x"],
    });
  });

  it("an explicit empty list equals the absent list", () => {
    expect(validateConfig({ approvers: [] })).toEqual(validateConfig({}));
  });

  it("all keys set together are all kept", () => {
    const r = validateConfig({
      questions: { warn_above: 2 },
      approvers: ["a", "b"],
      agent_identities: ["bot"],
      signing_keys: ["k1", "k2"],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        questions: { warn_above: 2 },
        approvers: ["a", "b"],
        agent_identities: ["bot"],
        signing_keys: ["k1", "k2"],
      },
    });
  });

  it("an empty file is an error, an empty mapping is not", () => {
    expect(parseConfig("").ok).toBe(false);
    expect(parseConfig("# only a comment\n").ok).toBe(false);
    expect(parseConfig("{}").ok).toBe(true);
  });

  it("does not reject an identity that is both approver and agent", () => {
    expect(
      validateConfig({ approvers: ["a"], agent_identities: ["a"] }).ok,
    ).toBe(true);
  });

  it("accepts identities such as bot accounts and mail addresses but not whitespace", () => {
    expect(
      validateConfig({ approvers: ["octo-bot[bot]", "a@example.com"] }).ok,
    ).toBe(true);
    expect(validateConfig({ approvers: ["a b"] }).ok).toBe(false);
    expect(validateConfig({ approvers: ["a\tb"] }).ok).toBe(false);
    expect(validateConfig({ agent_identities: ["a\nb"] }).ok).toBe(false);
  });

  it("accepts a signing key with spaces (a key fingerprint line)", () => {
    expect(validateConfig({ signing_keys: ["ssh-ed25519 AAAA user"] }).ok).toBe(
      true,
    );
  });
});
