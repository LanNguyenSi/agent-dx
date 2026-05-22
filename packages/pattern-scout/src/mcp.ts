#!/usr/bin/env node
// stdio MCP server exposing pattern-scout's federated search as a
// `pattern_search` tool, so agents can mine refactor exemplars without
// shelling out to the CLI. The search logic lives in `search.ts`; this file
// is only the transport wiring. See README.md for the registration block.

import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { renderSummary } from "./render.js";
import { federatedSearch } from "./search.js";

// Single source of truth for the version string emitted by both the MCP
// handshake and the `--version` CLI short-circuit. Read from package.json at
// runtime so it cannot drift from a release bump.
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
  name: "pattern-scout",
  version: PACKAGE_VERSION,
});

server.registerTool(
  "pattern_search",
  {
    title: "Pattern search",
    description:
      "Federated pattern search for refactor research. Fans out in parallel to (1) the source of opensrc-cached exemplar repos, searched lexically, and (2) your codebase-oracle index, searched semantically. Returns hits tagged by source: kind \"exemplar\" for third-party reference code, kind \"ours\" for your own repos. Use it to find how a well-built library implements a pattern and where your own code should adopt it. Pass `query` as a natural-language description (drives the semantic side); pass `pattern` as a regex to control the exemplar side precisely. The oracle source is optional: if codebase-oracle is unreachable, exemplar hits are still returned and the source is reported as unavailable.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe(
          "Natural-language description of the pattern. Drives the codebase-oracle semantic search, and is the literal substring match for exemplar repos when `pattern` is omitted.",
        ),
      pattern: z
        .string()
        .optional()
        .describe(
          "Optional case-insensitive regex for the exemplar (opensrc) side. Overrides the literal-substring default.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max results per source. Default 15."),
      repo: z
        .string()
        .optional()
        .describe(
          "Restrict both sources to repos whose name contains this substring.",
        ),
      exemplarsOnly: z
        .boolean()
        .optional()
        .describe(
          "Skip the codebase-oracle source and search exemplar repos only.",
        ),
      configPath: z
        .string()
        .optional()
        .describe(
          "Path to a pattern-scout.config.json. Default: the built-in config.",
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, pattern, limit, repo, exemplarsOnly, configPath }) => {
    try {
      const config = loadConfig(configPath);
      const summary = await federatedSearch(config, {
        query,
        pattern,
        limit,
        repo,
        exemplarsOnly,
      });
      return {
        content: [{ type: "text" as const, text: renderSummary(summary) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `pattern_search error: ${msg}` },
        ],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  // `<bin> --version` probes (e.g. harness doctor's tools.mcp min_version
  // check) must not hang waiting for an MCP initialize request that never
  // arrives: short-circuit before opening the stdio transport.
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `pattern-scout-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
