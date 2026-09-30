import { describe, it, expect } from "vitest";
import {
  STDOUT_READER_GONE_CODES,
  classifyStdoutError,
} from "../src/stdout-error.js";

function errno(code: string | undefined): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  if (code !== undefined) err.code = code;
  return err;
}

describe("classifyStdoutError", () => {
  it("names the reader-gone family", () => {
    expect([...STDOUT_READER_GONE_CODES].sort()).toEqual([
      "ECONNRESET",
      "ENOTCONN",
      "EPIPE",
    ]);
  });

  for (const code of ["EPIPE", "ENOTCONN", "ECONNRESET"]) {
    it(`${code}: silent, exits with the verdict code`, () => {
      expect(classifyStdoutError(errno(code), undefined)).toEqual({
        exitCode: 0,
        stderrLine: null,
      });
      expect(classifyStdoutError(errno(code), 0)).toEqual({
        exitCode: 0,
        stderrLine: null,
      });
      expect(classifyStdoutError(errno(code), 1)).toEqual({
        exitCode: 1,
        stderrLine: null,
      });
    });
  }

  for (const code of ["ENOSPC", "EBADF", "EIO", "EAGAIN"]) {
    it(`${code}: one stderr line naming the code, exit 2 whatever the verdict`, () => {
      for (const verdict of [undefined, 0, 1]) {
        expect(classifyStdoutError(errno(code), verdict)).toEqual({
          exitCode: 2,
          stderrLine: `slop-detector: could not write the report to stdout (${code})`,
        });
      }
    });
  }

  it("an error without a code is a failure, not a gone reader", () => {
    expect(classifyStdoutError(errno(undefined), 1)).toEqual({
      exitCode: 2,
      stderrLine:
        "slop-detector: could not write the report to stdout (unknown error)",
    });
  });
});
