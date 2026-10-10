#!/usr/bin/env node
// Entry point. Static imports are evaluated before any code in the importing
// module, and the real CLI reaches better-sqlite3 through them. So this file
// imports only the dependency-free guard and loads the CLI dynamically after
// the Node version check has passed.
import { nodeGuardMessage, readEnginesNode } from "./node-guard.js";

const message = nodeGuardMessage(process.versions.node, readEnginesNode());
if (message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
await import("./main.js");
