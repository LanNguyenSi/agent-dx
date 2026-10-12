import { describe, expect, it } from "vitest";
import { stdoutErrorOutcome } from "../src/cli.js";

const err = (code: string, message = `write ${code}`): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

describe("stdoutErrorOutcome", () => {
  it.each(["EPIPE", "ENOTCONN"])(
    "a closed reader (%s) keeps the verdict code silently",
    (code) => {
      expect(stdoutErrorOutcome(err(code), 1)).toEqual({ code: 1 });
      expect(stdoutErrorOutcome(err(code), undefined)).toEqual({ code: 0 });
    },
  );

  it("any other write error exits 2 with one stderr line", () => {
    expect(stdoutErrorOutcome(err("ENOSPC", "write ENOSPC"), 0)).toEqual({
      code: 2,
      message: "okf-kit: cannot write to stdout: write ENOSPC\n",
    });
    expect(stdoutErrorOutcome(err("ENOSPC"), 1).code).toBe(2);
  });
});
