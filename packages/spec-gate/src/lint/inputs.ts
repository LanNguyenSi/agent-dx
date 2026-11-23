import type { Loaded } from "./types.js";

/**
 * The value of an input a rule declared in `needs`. The engine runs such a
 * rule only when the input parsed, so any other state is a bug in the rule
 * list, not in the spec.
 */
export function valueOf<T>(input: Loaded<T>): T {
  if (input.state !== "ok") {
    throw new Error("a rule read an input that it did not declare in needs");
  }
  return input.value;
}
