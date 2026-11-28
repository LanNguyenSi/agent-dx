import { describe, expect, it } from "vitest";
import { maskOptionValues, REDACTED } from "../src/cli-output.js";

describe("maskOptionValues", () => {
  it("masks the value of an unknown option and keeps its name", () => {
    expect(maskOptionValues("error: unknown option '--a=b'\n")).toBe(
      `error: unknown option '--a=${REDACTED}'\n`,
    );
  });

  it("masks what is attached to a short option and keeps its letter", () => {
    expect(maskOptionValues("error: unknown option '-tSECRET'\n")).toBe(
      `error: unknown option '-t${REDACTED}'\n`,
    );
    expect(maskOptionValues("error: unknown option '-t=SECRET'\n")).toBe(
      `error: unknown option '-t${REDACTED}'\n`,
    );
    expect(maskOptionValues("error: unknown option '-abc d'e'\n")).toBe(
      `error: unknown option '-a${REDACTED}'\n`,
    );
  });

  it("leaves a bare short option unchanged: no placeholder is added", () => {
    const line = "error: unknown option '-t'\n";
    expect(maskOptionValues(line)).toBe(line);
    expect(maskOptionValues("error: unknown option '-t'")).toBe(
      "error: unknown option '-t'",
    );
  });

  it("masks from the first equals sign to the last quote when a line holds two options", () => {
    expect(maskOptionValues("error: unknown option '--a=b --c=d'\n")).toBe(
      `error: unknown option '--a=${REDACTED}'\n`,
    );
  });

  it("masks a value with an equals sign, quotes and spaces in it", () => {
    expect(
      maskOptionValues("error: unknown option '--token=a=b'c d=e'\n"),
    ).toBe(`error: unknown option '--token=${REDACTED}'\n`);
  });

  it("masks an empty value", () => {
    expect(maskOptionValues("error: unknown option '--a='\n")).toBe(
      `error: unknown option '--a=${REDACTED}'\n`,
    );
  });

  it("keeps the suggestion line of the parser", () => {
    expect(
      maskOptionValues(
        "error: unknown option '--proflie=secret'\n(Did you mean --profile?)\n",
      ),
    ).toBe(
      `error: unknown option '--proflie=${REDACTED}'\n(Did you mean --profile?)\n`,
    );
  });

  it("masks a value that holds a quote followed by a suggestion-like line", () => {
    expect(
      maskOptionValues(
        "error: unknown option '--a=x'\n(Did you mean --b?)\n(Did you mean --c?)'\n(Did you mean --d?)\n",
      ),
    ).toBe(`error: unknown option '--a=${REDACTED}'\n(Did you mean --d?)\n`);
  });

  it("leaves an unknown option without a value unchanged", () => {
    const line = "error: unknown option '--nope'\n";
    expect(maskOptionValues(line)).toBe(line);
    const withSuggestion =
      "error: unknown option '--proflie'\n(Did you mean --profile?)\n";
    expect(maskOptionValues(withSuggestion)).toBe(withSuggestion);
  });

  it("masks a refused value of a known option, from the command line and from the environment", () => {
    expect(
      maskOptionValues(
        "error: option '--profile <profile>' argument 'secret' is invalid. Allowed choices are light, full.\n",
      ),
    ).toBe(
      `error: option '--profile <profile>' argument '${REDACTED}' is invalid. Allowed choices are light, full.\n`,
    );
    expect(
      maskOptionValues(
        "error: option '--profile <profile>' value 'sec'ret' from env 'X' is invalid.\n",
      ),
    ).toBe(
      `error: option '--profile <profile>' value '${REDACTED}' from env 'X' is invalid.\n`,
    );
  });

  it("leaves an unknown command unchanged: a bare word is never masked", () => {
    const line = "error: unknown command 'ghs_bare_word'\n";
    expect(maskOptionValues(line)).toBe(line);
    const withSuggestion =
      "error: unknown command 'lnit'\n(Did you mean lint?)\n";
    expect(maskOptionValues(withSuggestion)).toBe(withSuggestion);
  });

  it("masks a refused value that holds a quote and a space", () => {
    expect(
      maskOptionValues(
        "error: option '--profile <profile>' argument 'a'b c' is invalid. Allowed choices are light, full.\n",
      ),
    ).toBe(
      `error: option '--profile <profile>' argument '${REDACTED}' is invalid. Allowed choices are light, full.\n`,
    );
  });

  it("leaves a line with no option value unchanged", () => {
    for (const line of [
      "error: missing required argument 'spec-dir'\n",
      "error: required option '--repo <dir>' not specified\n",
      "error: too many arguments for 'lint'. Expected 1 argument but got 2.\n",
      "error: option '--repo <dir>' argument missing\n",
      "key=value is plain text\n",
      "",
    ]) {
      expect(maskOptionValues(line)).toBe(line);
    }
  });

  it("is idempotent", () => {
    const once = maskOptionValues("error: unknown option '--a=b'\n");
    expect(maskOptionValues(once)).toBe(once);
  });
});
