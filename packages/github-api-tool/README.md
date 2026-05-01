# GitHub API Tool for OpenClaw

A command-line interface for GitHub API operations, designed for OpenClaw AI agents.

## Features

✅ **Issue Management:** Create, list, assign, comment, close  
✅ **Pull Request Operations:** List, comment, review, merge  
✅ **Repository Info:** Commits, contributors, repository details  
✅ **Standup Digest:** Daily commit overview across multiple repos  
✅ **JSON Output Mode:** Machine-readable output for programmatic use  
✅ **Error Handling:** Automatic retry with exponential backoff  
✅ **Type-Safe:** Full TypeScript implementation with strict mode

## Installation

```bash
npm install
npm run build
npm link  # Make 'github' command globally available
```

## Configuration

Set your GitHub Personal Access Token:

```bash
github config set-token <your-github-pat>
```

Or use environment variable:

```bash
export GITHUB_TOKEN=<your-github-pat>
```

### Required Token Scopes

- `repo` - Full repository access (for issues, PRs, commits)
- `read:org` - Read organization data (for contributors)

## Usage

### Issue Commands

```bash
# Create issue
github issue create --repo LanNguyenSi/frost --title "Bug: Login fails" --body "Description here" --labels bug,priority:high

# List open issues
github issue list --repo LanNguyenSi/frost --state open

# List issues with specific labels
github issue list --repo LanNguyenSi/frost --labels bug,security

# Assign issue
github issue assign --repo LanNguyenSi/frost --issue 42 --assignee lavaclawdbot

# Comment on issue
github issue comment --repo LanNguyenSi/frost --issue 42 --body "Fixed in PR #43"

# Close issue
github issue close --repo LanNguyenSi/frost --issue 42
```

### Pull Request Commands

```bash
# List open PRs
github pr list --repo LanNguyenSi/frost --state open

# Comment on PR
github pr comment --repo LanNguyenSi/frost --pr 43 --body "LGTM! 🔥"

# Approve PR
github pr review --repo LanNguyenSi/frost --pr 43 --event APPROVE --body "Excellent work!"

# Request changes
github pr review --repo LanNguyenSi/frost --pr 43 --event REQUEST_CHANGES --body "Please fix type errors"

# Merge PR
github pr merge --repo LanNguyenSi/frost --pr 43 --method squash
```

### Repository Commands

```bash
# List recent commits
github repo commits --repo LanNguyenSi/frost --limit 10

# List contributors
github repo contributors --repo LanNguyenSi/frost

# Get repository info
github repo info --repo LanNguyenSi/frost
```

### Standup Digest

Show all commits across repos for a given time range — ideal for daily standups or async team updates.

```bash
# All repos for the last day (default)
github standup -o LanNguyenSi

# Last 7 days
github standup -o LanNguyenSi -d 7

# Specific repos only
github standup -o LanNguyenSi -r agent-entrypoint github-api-tool

# Filter by author
github standup -o LanNguyenSi --author lavaclawdbot

# JSON output for scripting
github standup -o LanNguyenSi -d 3 --json
```

### JSON Output Mode

Add `--json` flag to any command for machine-readable output:

```bash
github issue list --repo LanNguyenSi/frost --json
github pr list --repo LanNguyenSi/frost --json --state open
github repo commits --repo LanNguyenSi/frost --json
```

## OpenClaw Integration

This tool is designed to be used by OpenClaw agents via the `exec` tool.

Example OpenClaw usage:

```typescript
// Create issue from code review
exec(`github issue create --repo LanNguyenSi/frost --title "Security: SSRF vulnerability" --body "Found in auth.ts line 42" --labels security --assignee lavaclawdbot --json`);

// List open issues
const result = exec(`github issue list --repo LanNguyenSi/frost --state open --json`);
const issues = JSON.parse(result.stdout);

// Approve PR after review
exec(`github pr review --repo LanNguyenSi/frost --pr 43 --event APPROVE --body "Security review passed. All 50+ checkpoints validated."`);
```

See `SKILL.md` for detailed OpenClaw Skill documentation.

## Architecture

```
src/
├── index.ts           # CLI entry point
├── github.ts          # GitHub API client (Octokit wrapper)
├── commands/
│   ├── issues.ts      # Issue commands
│   ├── prs.ts         # PR commands
│   ├── repos.ts       # Repository commands
│   ├── standup.ts     # Standup digest command
│   ├── bug-report.ts  # Bug report command
│   └── coverage-check.ts  # Coverage check command
└── utils/
    ├── config.ts      # Token/config management
    └── output.ts      # Formatted output (JSON/table)
```

## Error Handling

- **Network Errors:** Automatic retry (3 attempts) with exponential backoff
- **Auth Errors:** Clear error message with setup instructions
- **Rate Limiting:** Respects GitHub rate limits (built into Octokit)
- **Invalid Input:** Validates repository format, event types, merge methods

## Development

```bash
# Build
npm run build

# Watch mode (auto-rebuild on changes)
npm run watch

# Test CLI locally
node dist/index.js --help
node dist/index.js issue list --repo LanNguyenSi/frost
```

## License

MIT

## Author

Ice 🧊 - OpenClaw AI Agent
