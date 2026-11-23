import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Digest } from "../../src/canonical/index.js";

describe("canonicalJson (RFC 8785)", () => {
  it("serialises the RFC example of section 3.2.4", () => {
    const value = {
      numbers: [
        333333333.3333333, 1e30, 4.5, 2e-3, 0.000000000000000000000000001,
      ],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalJson(value)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts keys by UTF-16 code units (RFC section 3.2.3)", () => {
    const value = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    // Not JSON.parse: it would list the integer-like key "1" first.
    const text = canonicalJson(value);
    expect(text).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",' +
        '"\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign",' +
        '"\ud83d\ude00":"Emoji: Grinning Face",' +
        '"\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
    // The emoji is a surrogate pair, so it sorts before U+FB33.
    expect(text.indexOf("😀")).toBeLessThan(text.indexOf("דּ"));
  });

  it("sorts nested objects, and keeps array order", () => {
    expect(canonicalJson({ b: [3, 1, 2], a: { d: 1, c: 2 } })).toBe(
      '{"a":{"c":2,"d":1},"b":[3,1,2]}',
    );
  });

  it("serialises numbers as ECMAScript does, with -0 as 0", () => {
    const cases: Array<[number, string]> = [
      [0, "0"],
      [-0, "0"],
      [1e21, "1e+21"],
      [1e-7, "1e-7"],
      [0.000001, "0.000001"],
      [9007199254740992, "9007199254740992"],
      [5e-324, "5e-324"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
      [-1.5, "-1.5"],
      [120, "120"],
    ];
    for (const [n, text] of cases) expect(canonicalJson(n)).toBe(text);
  });

  it("refuses values JSON has no form for", () => {
    expect(() => canonicalJson(NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Infinity)).toThrow(TypeError);
    expect(() => canonicalJson(-Infinity)).toThrow(TypeError);
    expect(() => canonicalJson("a\ud800b")).toThrow(/lone surrogate/);
    expect(() => canonicalJson({ "\udc00": 1 })).toThrow(/lone surrogate/);
    expect(() => canonicalJson(undefined as never)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0) as never)).toThrow(/plain object/);
    expect(() => canonicalJson((() => 1) as never)).toThrow(TypeError);
    expect(() => canonicalJson(1n as never)).toThrow(TypeError);
  });

  it("refuses a value nested too deeply instead of overflowing the stack", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(() => canonicalJson(deep as never)).toThrow(/nested too deeply/);
  });

  it("writes no whitespace and escapes only what the RFC says", () => {
    expect(canonicalJson({ a: " \u007f/é" })).toBe('{"a":" \u007f/é"}');
    expect(canonicalJson("\b\t\f")).toBe('"\\b\\t\\f"');
    expect(canonicalJson("\u0001")).toBe('"\\u0001"');
  });
});

describe("sha256Digest", () => {
  it("is sha256: plus 64 lower-case hex digits over the UTF-8 bytes", () => {
    expect(sha256Digest("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Digest("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // UTF-8, not UTF-16: the euro sign is the three bytes e2 82 ac.
    const bytes = createHash("sha256")
      .update(Buffer.from([0xe2, 0x82, 0xac]))
      .digest("hex");
    expect(sha256Digest("\u20ac")).toBe(`sha256:${bytes}`);
  });
});
