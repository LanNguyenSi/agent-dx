// CLI-free resolver shared by dist-tag-version.mjs and check-latest.mjs.
// Importing this module has no side effects: it reads no stdin and parses no
// arguments, which is why the two scripts can each run their CLI
// unconditionally instead of guarding an entry point.

// Resolve the version one dist-tag points at in the body of `npm view <pkg>
// dist-tags --json` (npm 11 object shape or npm 12 array shape). Throws on
// input that is not JSON; a JSON body that carries no object to index into
// (empty array, null, a bare string) resolves to "tag absent", which the
// caller must be able to tell apart from a throw.
export function resolveVersion(text, tag) {
  const data = JSON.parse(text);
  const obj = Array.isArray(data) ? data[0] : data;
  if (obj === null || obj === undefined || typeof obj !== "object") return "";
  const version = obj[tag];
  return typeof version === "string" ? version : "";
}
