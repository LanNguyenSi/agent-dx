// Small shared helpers with no dependencies on the rest of the package.

/**
 * Split a configured command string into argv. The first element is the
 * binary, the rest are prefix arguments, so a config value like
 * `"npx codebase-oracle"` or `"node /abs/dist/index.js"` works as a command.
 */
export function splitCommand(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Command string is empty");
  }
  return parts;
}

/** Escape a string so it can be used as a literal inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cap a string to `max` characters, appending an ellipsis when truncated. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)) + "...";
}

/** Collapse all whitespace runs to single spaces and trim, for one-line detail strings. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
