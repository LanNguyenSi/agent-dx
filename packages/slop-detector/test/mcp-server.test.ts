/**
 * Tests for the MCP server wiring in src/mcp.ts:
 *   - arg unwrapping (tool args forwarded to runSlopCheck)
 *   - catch / error-content path (isError when runSlopCheck throws)
 *   - --version short-circuit (writes version, skips server.connect)
 *
 * mcp-check.ts is intentionally separate so it can be tested without the MCP
 * transport; these tests cover the thin wiring layer on top of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted box so the vi.mock factory (which is hoisted too) can reference it
const box = vi.hoisted(() => {
  const connectSpy = vi.fn().mockResolvedValue(undefined);
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null =
    null;
  return { connectSpy, handler };
});

// ── mock the MCP SDK: use a class so `new McpServer(...)` works ──────────────
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  return {
    McpServer: class MockMcpServer {
      registerTool(
        _name: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) {
        box.handler = handler;
      }
      connect() {
        return box.connectSpy();
      }
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockTransport {},
}));

// ── mock mcp-check so we can control its return values ───────────────────────
vi.mock("../src/mcp-check.js", () => ({
  runSlopCheck: vi.fn(),
  renderSummary: vi.fn(),
}));

import { runSlopCheck, renderSummary } from "../src/mcp-check.js";

describe("slop-detector MCP wiring — tool handler", () => {
  beforeEach(async () => {
    // Import the MCP server module; it registers the tool and calls main().
    // The mocked transport resolves immediately so there's no hang.
    await import("../src/mcp.js");
    await Promise.resolve(); // let main()'s async tail settle
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers a slop_check tool (handler is captured)", () => {
    expect(box.handler).not.toBeNull();
  });

  it("unwraps args and forwards them to runSlopCheck then renderSummary", async () => {
    const summary = {
      violations: [],
      filesScanned: 1,
      blockCount: 0,
      warnCount: 0,
      infoCount: 0,
    };
    vi.mocked(runSlopCheck).mockReturnValue(summary as never);
    vi.mocked(renderSummary).mockReturnValue(
      "slop-detector: clean (1 file(s) scanned)",
    );

    const result = (await box.handler!({
      text: "Hello world",
      filename: "msg.md",
      packs: ["prose-slop"],
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(runSlopCheck).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello world", filename: "msg.md" }),
    );
    expect(renderSummary).toHaveBeenCalledWith(summary);
    expect(result.content[0]?.text).toBe(
      "slop-detector: clean (1 file(s) scanned)",
    );
    expect(result.isError).toBeUndefined();
  });

  it("returns isError:true and the error message when runSlopCheck throws", async () => {
    vi.mocked(runSlopCheck).mockImplementation(() => {
      throw new Error("pass either text or path, not both");
    });

    const result = (await box.handler!({
      text: "x",
      path: "y",
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "pass either text or path, not both",
    );
  });

  it("prefixes error content with 'slop_check error:'", async () => {
    vi.mocked(runSlopCheck).mockImplementation(() => {
      throw new Error("bad path");
    });

    const result = (await box.handler!({ path: "/nonexistent" })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content[0]?.text).toMatch(/^slop_check error:/);
  });
});

describe("slop-detector MCP wiring — --version short-circuit", () => {
  let originalArgv: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset module cache so each test gets a fresh mcp.js that runs main() again.
    vi.resetModules();
    originalArgv = process.argv;
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true as never);
    box.connectSpy.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("writes the version string to stdout and does not call server.connect", async () => {
    process.argv = ["node", "mcp.js", "--version"];

    await import("../src/mcp.js");
    await new Promise((r) => setTimeout(r, 10));

    const written = stdoutSpy.mock.calls.flat().map(String).join("");
    // The version string must look like x.y.z\n
    expect(written).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(box.connectSpy).not.toHaveBeenCalled();
  });

  it("writes the version string when the -v short flag is used", async () => {
    process.argv = ["node", "mcp.js", "-v"];

    await import("../src/mcp.js");
    await new Promise((r) => setTimeout(r, 10));

    const written = stdoutSpy.mock.calls.flat().map(String).join("");
    expect(written).toMatch(/\d+\.\d+\.\d+/);
    expect(box.connectSpy).not.toHaveBeenCalled();
  });
});
