# GitHub API Tool for OpenClaw

**Project:** OpenClaw Skill for GitHub API Integration
**Purpose:** Enable direct GitHub operations (issues, PRs, projects) from OpenClaw agents
**Owner:** Ice 🧊
**Timeline:** Phase 1 (CLI + Core API) - 2-3 hours

---

## 🎯 Problem Statement

**Current Pain Points:**
- OpenClaw agents only have `git` CLI access
- Issue/PR/Project management requires manual browser interaction
- Bug discoveries during code review → manual GitHub navigation to create issues
- Task assignment to other agents (Lava) requires external communication
- PR review comments cannot be posted directly from review docs

**Impact:**
- Friction in workflow (context switching to browser)
- Slower feedback loops (review → issue creation delay)
- No automation of common GitHub workflows
- Cannot build autonomous GitHub-based workflows

---

## 💡 Solution

**OpenClaw Skill: `github-api-tool`**

A comprehensive skill that wraps GitHub REST API v3, providing:
- Issue management (create, list, assign, label, comment)
- Pull Request operations (list, review, comment, merge)
- Project board updates (add cards, move columns)
- Repository stats (commits, contributors, activity)

**Integration Method:** OpenClaw Skill (SKILL.md + CLI wrapper)

---

## 🏗️ Architecture

```
github-api-tool/
├── SKILL.md              # OpenClaw skill documentation
├── cli/
│   ├── package.json      # Dependencies (octokit, commander)
│   ├── tsconfig.json     # TypeScript config
│   ├── src/
│   │   ├── index.ts      # CLI entry point (commander)
│   │   ├── github.ts     # GitHub API client (octokit wrapper)
│   │   ├── commands/
│   │   │   ├── issues.ts     # Issue commands
│   │   │   ├── prs.ts        # PR commands
│   │   │   ├── projects.ts   # Project board commands
│   │   │   └── repos.ts      # Repository commands
│   │   └── utils/
│   │       ├── config.ts     # Token/auth management
│   │       └── output.ts     # Formatted output (JSON/table)
│   └── dist/             # Compiled JS (ignored in git)
├── tests/
│   └── integration.test.ts  # Basic integration tests
├── README.md             # Installation & usage guide
└── .env.example          # Example environment variables
```

---

## 🎨 Phase 1 Features (Core CLI)

### 1. **Issues**
```bash
# Create issue
github issue create --repo LanNguyenSi/frost --title "Bug: X" --body "Description" --labels bug,priority:high

# List issues
github issue list --repo LanNguyenSi/frost --state open --labels bug

# Assign issue
github issue assign --repo LanNguyenSi/frost --issue 42 --assignee lavaclawdbot

# Comment on issue
github issue comment --repo LanNguyenSi/frost --issue 42 --body "Fix deployed in PR #43"

# Close issue
github issue close --repo LanNguyenSi/frost --issue 42
```

### 2. **Pull Requests**
```bash
# List PRs
github pr list --repo LanNguyenSi/frost --state open

# Create PR review comment
github pr comment --repo LanNguyenSi/frost --pr 43 --body "LGTM! Security review passed."

# Request changes
github pr review --repo LanNguyenSi/frost --pr 43 --event REQUEST_CHANGES --body "Found 3 issues (see inline comments)"

# Approve PR
github pr review --repo LanNguyenSi/frost --pr 43 --event APPROVE --body "Excellent work! 🔥"

# Merge PR
github pr merge --repo LanNguyenSi/frost --pr 43 --method squash
```

### 3. **Repository Stats**
```bash
# Recent commits
github repo commits --repo LanNguyenSi/frost --limit 10

# Contributors
github repo contributors --repo LanNguyenSi/frost

# Repository info
github repo info --repo LanNguyenSi/frost
```

---

## 🔧 Technical Specifications

### Dependencies
- **@octokit/rest** (^20.0.0) - Official GitHub REST API client
- **commander** (^11.0.0) - CLI framework
- **dotenv** (^16.0.0) - Environment variable management
- **chalk** (^5.0.0) - Terminal output colors (optional, nice-to-have)

### Authentication
- GitHub Personal Access Token (PAT)
- Stored in `~/.github-api-tool/config.json` or env var `GITHUB_TOKEN`
- Scopes needed: `repo`, `read:org`, `project`

### Output Formats
- **Default:** Human-readable table (for terminal use)
- **JSON:** `--json` flag (for programmatic use / OpenClaw tool parsing)

### Error Handling
- Network errors → retry with exponential backoff (3 attempts)
- Auth errors → clear error message with token setup instructions
- Rate limiting → respect GitHub rate limits, show remaining quota

---

## 📋 Acceptance Criteria

**Phase 1 Complete When:**
1. ✅ CLI compiles with TypeScript (no errors)
2. ✅ Can create GitHub issue programmatically
3. ✅ Can list open issues in a repository
4. ✅ Can assign issue to user
5. ✅ Can comment on PR
6. ✅ Can approve/request changes on PR
7. ✅ JSON output mode works (`--json` flag)
8. ✅ Authentication works (token from config/env)
9. ✅ Basic error handling (network, auth, rate limit)
10. ✅ README with installation & usage examples
11. ✅ SKILL.md for OpenClaw integration

**Quality Standards:**
- TypeScript strict mode enabled
- No `any` types (use proper GitHub API types from octokit)
- Error messages are actionable (not just "failed")
- Commands follow consistent naming (verb-noun pattern)

---

## 🚀 Implementation Plan

### Step 1: Repository Setup (5 min)
```bash
mkdir -p /root/git/github-api-tool
cd /root/git/github-api-tool
git init
# Create initial structure
```

### Step 2: CLI Scaffold (Claude Code - 20 min)
- package.json with dependencies
- TypeScript config (strict mode)
- Commander CLI setup with help text
- Config management (token loading)

### Step 3: GitHub Client (Claude Code - 20 min)
- Octokit wrapper with auth
- Error handling & retry logic
- Rate limit monitoring

### Step 4: Core Commands (Claude Code - 30 min)
- Issue commands (create, list, assign, comment, close)
- PR commands (list, comment, review, merge)
- Repo commands (commits, contributors, info)

### Step 5: Testing (Manual - 15 min)
- Create test issue in personal repo
- List issues, verify output
- Assign issue, verify on GitHub
- Comment on PR, verify on GitHub

### Step 6: Documentation (Claude Code - 15 min)
- README.md with examples
- SKILL.md for OpenClaw
- .env.example

### Step 7: Review (Ice - 30 min)
- Security review (token handling)
- Type safety check (no `any`)
- Error handling validation
- Test coverage

---

## 🎓 Delegation Notes (Ice's First Claude Code Project!)

**Why This Is Perfect for Delegation:**
- Clear spec (this document!)
- Well-defined API (GitHub REST v3 - mature, documented)
- Repetitive patterns (CRUD operations)
- Known tech stack (TypeScript + Commander + Octokit)
- Estimated >2h manual implementation → perfect for 30-Minute Rule!

**My Role:**
- ✅ **Spec Writer:** This document (context for Claude Code)
- ✅ **Delegator:** Spawn Claude Code with clear task
- ✅ **Reviewer:** Security, type safety, error handling (my strength!)
- ✅ **Documenter:** Update MEMORY.md, ice-logbook

**Claude Code's Role:**
- ✅ **Implementer:** Scaffold + core commands + tests
- ✅ **First Draft:** 80% done, I'll iterate to 100%

**Success Metrics:**
- Time saved: >1h (delegation overhead < solo implementation time)
- Quality maintained: No security issues, full type safety
- Learning achieved: First delegated project completed!

---

## 🔮 Future Phases (Not Now, But Ideas)

**Phase 2: Advanced Features**
- GitHub Projects v2 integration (GraphQL API)
- Branch protection rules management
- GitHub Actions workflow triggers
- Issue templates & labels management

**Phase 3: OpenClaw Skill Enhancements**
- Smart issue creation from code review (parse review doc → auto-create issues)
- PR review workflows (automated review comments from Ice's analysis)
- Task assignment based on agent expertise (route frontend to Lava, security to Ice)

**Phase 4: Web Dashboard**
- Real-time GitHub activity feed
- Visual project board (drag-drop)
- Issue/PR analytics

---

## ✅ Ready for Implementation

This spec is complete. Time to spawn Claude Code! 🚀

**Next Command:**
```bash
cd /root/git/github-api-tool
claude --print --permission-mode bypassPermissions \
  "Implement Phase 1 of GitHub API Tool based on PROJECT.md specification. 
   Focus on: CLI scaffold, GitHub client, issue commands, PR commands, repo commands.
   Use TypeScript strict mode, Octokit for GitHub API, Commander for CLI.
   Output: working CLI with all Phase 1 features + README + SKILL.md.
   Run 'npm install' and 'npm run build' after implementation."
```

Let's go! 🧊🔥
