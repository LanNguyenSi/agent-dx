// The two free-text strings the MCP `slop_check` tool schema carries, kept
// in their own module so `test/mcp-descriptions.test.ts` can assert them
// against the pack registry without importing the MCP transport. The
// off-by-default list is generated from `OFF_BY_DEFAULT_PACKS` (derived
// from `DEFAULT_PACKS` in `config.ts`), so a new pack or a flipped default
// updates the tool schema in the same commit as the registry change; the
// test pins that derivation.

import { OFF_BY_DEFAULT_PACKS } from "./config.js";

/** The off-by-default pack ids joined for prose, e.g. `comment-slop, ...`. */
export const OFF_BY_DEFAULT_PACK_LIST = OFF_BY_DEFAULT_PACKS.join(", ");

export const SLOP_CHECK_TOOL_DESCRIPTION =
  "Scan text or a file/directory for AI-slop tells: agent-tics leaked MCP serialization artefacts (</result> tags), doubled '## Summary' headings, and auto-appended Claude Code attribution footers; prose-slop em-dashes in prose, hedging openers, and empty marketing adjectives; and (with the opt-in packs) comment-slop JSDoc on trivial getters, code-slop defensive try/catch around non-throwing code, ui-slop tells such as removed focus outlines and missing alt text, placement-slop org-/machine-/date-bound evidence leaking into instruction files, workflow-slop GitHub Actions `run:` expression injection, and review-slop run-local review tokens leaking into reusable content. Pass `text` to scan an in-memory string such as a commit message or PR body, or `path` to scan a file or directory tree. Returns each violation as `SEVERITY line:col rule message` plus a one-line tally.";

export const SLOP_CHECK_PACKS_DESCRIPTION = `Restrict to these rule packs (e.g. ["prose-slop"], ["code-slop"]). The off-by-default packs (${OFF_BY_DEFAULT_PACK_LIST}) only run when named here. Default: every default-on pack.`;
