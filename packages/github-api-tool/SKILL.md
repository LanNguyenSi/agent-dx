# GitHub API Tool - OpenClaw Skill

**Skill Name:** github-api-tool  
**Purpose:** Enable OpenClaw agents to perform GitHub operations (issues, PRs, projects)  
**Author:** Ice 🧊  
**Version:** 0.1.0

## Overview

This skill provides direct GitHub API access for OpenClaw agents, enabling:
- Issue creation, assignment, and management
- Pull request reviews and comments
- Repository information queries
- Automated GitHub workflows

## Prerequisites

1. **GitHub Personal Access Token (PAT):**
   - Create at: https://github.com/settings/tokens
   - Required scopes: `repo`, `read:org`
   - Store via: `github config set-token <token>`
   - Or set env var: `GITHUB_TOKEN=<token>`

2. **Tool Installation:**
   ```bash
   cd /root/.openclaw/workspace/git/github-api-tool/cli
   npm install
   npm run build
   npm link  # Makes 'github' command globally available
   ```

3. **Verify Installation:**
   ```bash
   github --version  # Should output: 0.1.0
   github --help     # Shows all commands
   ```

## Available Commands

### Issue Management

| Command | Description | Example |
|---------|-------------|---------|
| `issue create` | Create new issue | `github issue create --repo LanNguyenSi/frost --title "Bug: X" --body "..." --labels bug` |
| `issue list` | List issues | `github issue list --repo LanNguyenSi/frost --state open` |
| `issue assign` | Assign issue | `github issue assign --repo LanNguyenSi/frost --issue 42 --assignee lavaclawdbot` |
| `issue comment` | Add comment | `github issue comment --repo LanNguyenSi/frost --issue 42 --body "Fixed!"` |
| `issue close` | Close issue | `github issue close --repo LanNguyenSi/frost --issue 42` |

### Pull Request Operations

| Command | Description | Example |
|---------|-------------|---------|
| `pr list` | List PRs | `github pr list --repo LanNguyenSi/frost --state open` |
| `pr comment` | Comment on PR | `github pr comment --repo LanNguyenSi/frost --pr 43 --body "LGTM!"` |
| `pr review` | Submit review | `github pr review --repo LanNguyenSi/frost --pr 43 --event APPROVE --body "Approved!"` |
| `pr merge` | Merge PR | `github pr merge --repo LanNguyenSi/frost --pr 43 --method squash` |

### Repository Info

| Command | Description | Example |
|---------|-------------|---------|
| `repo commits` | List commits | `github repo commits --repo LanNguyenSi/frost --limit 10` |
| `repo contributors` | List contributors | `github repo contributors --repo LanNguyenSi/frost` |
| `repo info` | Get repo info | `github repo info --repo LanNguyenSi/frost` |

## Usage Patterns

### 1. Bug Found During Code Review → Create Issue

```typescript
// You discovered a security bug during review
exec(`github issue create \
  --repo LanNguyenSi/frost \
  --title "Security: SSRF vulnerability in auth.ts" \
  --body "Found SSRF vulnerability at line 42. External URL not validated before fetch()." \
  --labels security,bug,priority:high \
  --assignee lavaclawdbot \
  --json`);
```

### 2. List Open Issues for Daily Standup

```typescript
// Get all open issues to report status
const result = exec(`github issue list --repo LanNguyenSi/frost --state open --json`);
const issues = JSON.parse(result.stdout);

// Report to Lan
console.log(`Open issues: ${issues.length}`);
issues.forEach(issue => {
  console.log(`#${issue.number}: ${issue.title} (${issue.labels.join(', ')})`);
});
```

### 3. Approve PR After Security Review

```typescript
// You completed thorough security review
exec(`github pr review \
  --repo LanNguyenSi/frost \
  --pr 43 \
  --event APPROVE \
  --body "Security review complete. All 50+ checkpoints validated. LGTM! 🧊"`);
```

### 4. Request Changes on PR

```typescript
// Found issues during review
const issues = [
  "Line 42: Missing input validation",
  "Line 87: Potential memory leak",
  "Line 120: Type error (any usage)"
];

exec(`github pr review \
  --repo LanNguyenSi/frost \
  --pr 43 \
  --event REQUEST_CHANGES \
  --body "Found ${issues.length} issues:\n\n${issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}"`);
```

### 5. Comment on PR with Review Summary

```typescript
// After completing 8KB review document
exec(`github pr comment \
  --repo LanNguyenSi/frost \
  --pr 43 \
  --body "Comprehensive review complete! See full analysis: [REVIEW-2026-03-16.md](link).\n\n**Summary:**\n- Security: ✅ No issues\n- Type Safety: ✅ All strict\n- Error Handling: ⚠️ 2 minor improvements suggested\n\n**Overall:** 9/10 - Excellent work! 🔥"`);
```

### 6. Auto-Assign Issue Based on Type

```typescript
// Create issue and assign based on label
const issueType = "frontend";  // or "backend", "security", etc.
const assignee = issueType === "frontend" ? "lavaclawdbot" : "ice";

exec(`github issue create \
  --repo LanNguyenSi/frost \
  --title "Feature: Add dark mode toggle" \
  --body "User requested dark mode in dashboard." \
  --labels feature,${issueType} \
  --assignee ${assignee} \
  --json`);
```

### 7. Query Repository Activity

```typescript
// Get recent commits for daily log
const result = exec(`github repo commits --repo LanNguyenSi/frost --limit 10 --json`);
const commits = JSON.parse(result.stdout);

// Analyze activity
const authors = new Set(commits.map(c => c.author));
console.log(`Recent activity: ${commits.length} commits by ${authors.size} contributors`);
```

## Error Handling

The CLI handles errors gracefully:

```typescript
try {
  const result = exec(`github issue create --repo LanNguyenSi/frost --title "Bug" --body "..." --json`);
  const issue = JSON.parse(result.stdout);
  console.log(`Issue #${issue.number} created`);
} catch (error) {
  // GitHub API error (auth, rate limit, network)
  console.error("Failed to create issue:", error.message);
}
```

## JSON Mode

Always use `--json` flag when programmatically parsing output:

```typescript
// ❌ BAD - Human-readable output (hard to parse)
exec(`github issue list --repo LanNguyenSi/frost`);

// ✅ GOOD - JSON output (easy to parse)
const result = exec(`github issue list --repo LanNguyenSi/frost --json`);
const issues = JSON.parse(result.stdout);
```

## Best Practices

### 1. **Always Include Context in Issue Bodies**

```typescript
// ❌ BAD
exec(`github issue create --repo LanNguyenSi/frost --title "Bug" --body "Fix this"`);

// ✅ GOOD
exec(`github issue create --repo LanNguyenSi/frost \
  --title "Bug: Authentication fails with OAuth2" \
  --body "**Issue:** OAuth2 login returns 500 error\n**Expected:** Should return 401 with clear error message\n**Steps to Reproduce:**\n1. Click Login\n2. Enter invalid credentials\n3. Observe 500 error\n\n**Files:** src/auth/oauth.ts:42"`);
```

### 2. **Use Descriptive Labels**

```typescript
// Labels help with filtering and organization
--labels security,bug,priority:high,needs-review
```

### 3. **Assign Based on Expertise**

```typescript
// Frontend issues → Lava (fast prototyper)
// Security/Backend → Ice (rigorous reviewer)
const assignee = labels.includes("frontend") ? "lavaclawdbot" : "ice";
```

### 4. **Link Issues to PRs**

```typescript
// In PR review comment
--body "Fixes #42, #43, #44. All issues validated and resolved."
```

### 5. **Use Structured Review Comments**

```typescript
// Clear structure helps humans process feedback
--body "**Security Review:**\n✅ No vulnerabilities found\n\n**Type Safety:**\n✅ Strict mode compliant\n\n**Performance:**\n⚠️ Consider memoization at line 87\n\n**Verdict:** Approved with minor suggestions."
```

## Integration with Other Skills

### With Code Review Workflow

```typescript
// 1. Review code (Ice's strength)
const review = performCodeReview(prNumber);

// 2. Create issues for critical bugs
review.criticalIssues.forEach(issue => {
  exec(`github issue create --repo ${repo} --title "${issue.title}" --body "${issue.description}" --labels security,bug`);
});

// 3. Submit PR review
const verdict = review.score >= 8 ? "APPROVE" : "REQUEST_CHANGES";
exec(`github pr review --repo ${repo} --pr ${prNumber} --event ${verdict} --body "${review.summary}"`);
```

### With Memory System

```typescript
// Log GitHub activity to memory
const issues = JSON.parse(exec(`github issue list --repo LanNguyenSi/frost --json`).stdout);
memory.write(`ice-logbook/2026-03-16.md`, `
## GitHub Activity

Created ${issues.filter(i => i.author === "ice").length} issues today:
${issues.map(i => `- #${i.number}: ${i.title}`).join('\n')}
`);
```

## Troubleshooting

### "No GitHub token found"

```bash
# Set token via config
github config set-token ghp_...

# Or via environment variable
export GITHUB_TOKEN=ghp_...
```

### "Invalid repository format"

```bash
# ❌ Wrong
--repo frost

# ✅ Correct
--repo LanNguyenSi/frost
```

### "Failed to create issue" (403 Forbidden)

- Check token has `repo` scope
- Verify you have write access to repository
- Token may be expired (regenerate on GitHub)

## Limitations

- **Rate Limits:** GitHub API has rate limits (5000 requests/hour for authenticated users)
- **No Project Board Operations:** Phase 1 focuses on issues/PRs (Project boards in future phase)
- **No Advanced PR Features:** No inline code comments yet (only general PR comments/reviews)

## Future Enhancements (Phase 2+)

- GitHub Projects v2 integration (GraphQL API)
- Branch protection rules management
- GitHub Actions workflow triggers
- Issue template management
- Inline PR code review comments
- Smart issue creation (parse review docs → auto-create issues)

## Support

- **Author:** Ice 🧊
- **Repository:** /root/.openclaw/workspace/git/github-api-tool
- **Issues:** Use this tool to create issues about itself! 🎯
