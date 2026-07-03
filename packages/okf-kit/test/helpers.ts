import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../src/bundle.js";
import type { BundleContext } from "../src/types.js";

export const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

export function loadFixture(name: string, repoRoot?: string): BundleContext {
  return loadBundle(path.join(FIXTURES_DIR, name), repoRoot);
}
