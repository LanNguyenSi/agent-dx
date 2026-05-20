#!/usr/bin/env node
// stdio MCP server exposing slop-detector's engine as a `slop_check` tool,
// so agents can scan commit messages, PR bodies, and files for AI-slop
// without shelling out to the CLI. The pure tool logic lives in
// `mcp-check.ts`; this file is only the transport wiring. See README.md
// for the Claude Code / harness registration block.

import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderSummary, runSlopCheck } from "./mcp-check.js";

// Single source of truth for the version string emitted by both the MCP
// `name+version` handshake and the `--version` CLI short-circuit. Read
// from package.json at runtime so it cannot drift from a release bump.
const PACKAGE_VERSION = readVersion();

function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(url, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const server = new McpServer({
  name: "slop-detector",
  version: PACKAGE_VERSION,
});

server.registerTool(
  "slop_check",
  {
    title: "Slop check",
    description:
      "Scan text or a file/directory for AI-slop tells: em-dashes in prose, hedging openers, leaked MCP serialization artefacts (</result> tags), doubled '## Summary' headings, empty marketing adjectives, and (with the code-slop / comment-slop packs) defensive try/catch and JSDoc on trivial getters. Pass `text` to scan an in-memory string such as a commit message or PR body, or `path` to scan a file or directory tree. Returns each violation as `SEVERITY line:col rule message` plus a one-line tally.",
    inputSchema: {
      text: z
        .string()
        .optional()
        .describe(
          "In-memory string to scan, e.g. a commit message or PR body. Mutually exclusive with `path`.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "File or directory path to scan. Mutually exclusive with `text`.",
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "Filename to assume for `text` input; drives prose-vs-code detection. Defaults to a markdown name (prose rules apply).",
        ),
      packs: z
        .array(z.string())
        .optional()
        .describe(
          'Restrict to these rule packs (e.g. ["prose-slop"], ["code-slop"]). The off-by-default packs (code-slop, comment-slop) only run when named here. Default: every default-on pack.',
        ),
      configPath: z
        .string()
        .optional()
        .describe(
          "Path to a slop.config.yml / .json. Default: the built-in config.",
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ text, path, filename, packs, configPath }) => {
    try {
      const summary = runSlopCheck({ text, path, filename, packs, configPath });
      return {
        content: [{ type: "text" as const, text: renderSummary(summary) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `slop_check error: ${msg}` }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  // `<bin> --version` probes (e.g. `harness doctor`'s tools.mcp min_version
  // check) must not hang waiting for an MCP initialize request that never
  // arrives — short-circuit before opening the stdio transport.
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `slop-detector-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
