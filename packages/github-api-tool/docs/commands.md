# Command reference

## Issue commands

```bash
# Create issue
github issue create --repo owner/repo --title "Bug: Login fails" --body "Description here" --labels bug,priority:high

# List open issues
github issue list --repo owner/repo --state open

# List issues with specific labels
github issue list --repo owner/repo --labels bug,security

# Assign issue
github issue assign --repo owner/repo --issue 42 --assignee octocat

# Comment on issue
github issue comment --repo owner/repo --issue 42 --body "Fixed in PR #43"

# Close issue
github issue close --repo owner/repo --issue 42
```

## Pull request commands

```bash
# List open PRs
github pr list --repo owner/repo --state open

# Comment on PR
github pr comment --repo owner/repo --pr 43 --body "LGTM"

# Approve PR
github pr review --repo owner/repo --pr 43 --event APPROVE --body "Looks good"

# Request changes
github pr review --repo owner/repo --pr 43 --event REQUEST_CHANGES --body "Please fix type errors"

# Merge PR (method: merge, squash, rebase; default merge)
github pr merge --repo owner/repo --pr 43 --method squash
```

## Repository commands

```bash
# List recent commits
github repo commits --repo owner/repo --limit 10

# List contributors
github repo contributors --repo owner/repo

# Get repository info
github repo info --repo owner/repo
```

`issue list`, `pr list` and `repo contributors` return at most 30 results unless you pass `--limit <n>`; `repo commits` defaults to 10. Each command reads a single page and does not paginate, so GitHub's per-page maximum (100) caps larger values.

## Standup digest

Show commits across repos for a given time range, for daily standups or async team updates.

```bash
# Up to 100 most recently pushed repos, last day (default)
github standup -o your-org

# Last 7 days
github standup -o your-org -d 7

# Specific repos only
github standup -o your-org -r repo-a repo-b

# Filter by author
github standup -o your-org --author octocat

# JSON output for scripting
github standup -o your-org -d 3 --json
```

Without `-r`, one page of up to 100 repositories is read, sorted by last push (organization first, then user). Each repository lists at most 100 commits, with or without `-r`.

## Bug report

Creates an issue whose body has the sections Observed Behavior, Expected Behavior, Steps to Reproduce, Minimal Reproduce Case, Hypothesis and Root Cause.

```bash
github bug-report --repo owner/repo --title "Bug: Login fails" \
  --observed "Login returns 500" --expected "Login succeeds" \
  --reproduce "curl -X POST /login" --labels bug,priority:high
```

Only `--repo` is required. When `--title`, `--observed`, `--expected` or `--reproduce` is missing, the command asks for each missing field on stdin, and for a hypothesis unless `--hypothesis` is set; pass all four when an agent or CI job calls it. Other options: `--hypothesis <text>` (optional), `-l, --labels` (default `bug`), `--json` (prints `{ number, url }`).

## Coverage check

Checks a Vitest `coverage-summary.json` against a minimum threshold. Defaults: `--input coverage/coverage-summary.json`, `--threshold 80`, `--label Coverage`. It compares the statements percentage, or lines when statements is missing, and exits 1 below the threshold.

```bash
github coverage-check --input coverage/coverage-summary.json --threshold 80 --label Coverage
```

## JSON output mode

Add `--json` to any issue, PR, repo, standup, bug-report or coverage-check command for machine-readable output:

```bash
github issue list --repo owner/repo --json
github pr list --repo owner/repo --json --state open
github repo commits --repo owner/repo --json
```

## Agent integration

This tool is designed to be used by AI agents via an `exec` tool. See [SKILL.md](../SKILL.md) for detailed skill documentation.

```typescript
// Create issue from code review
exec(`github issue create --repo owner/repo --title "Security: SSRF vulnerability" --body "Found in auth.ts line 42" --labels security --assignee octocat --json`);

// List open issues
const result = exec(`github issue list --repo owner/repo --state open --json`);
const issues = JSON.parse(result.stdout);

// Approve PR after review
exec(`github pr review --repo owner/repo --pr 43 --event APPROVE --body "Review passed"`);
```

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
    ├── args.ts        # Numeric option validation
    ├── config.ts      # Token/config management
    └── output.ts      # Formatted output (JSON/table)
```

## Error handling

- **Transient failures:** each API call is tried up to 3 times, waiting 1s and then 2s, on 5xx and 429 responses (Octokit reports a network failure as status 500) and on errors without an HTTP status, such as a timeout abort. Other 4xx responses, including 401 and 403, fail on the first attempt.
- **Auth errors:** clear error message with setup instructions
- **Rate limiting:** there is no client-side throttling. A rate-limit rejection returned as 403 fails at once; one returned as 429 is retried as above. Spread out bulk runs such as `standup` without `-r`.
- **Invalid input:** validates repository format, event types, merge methods
