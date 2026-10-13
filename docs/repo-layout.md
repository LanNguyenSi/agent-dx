# Repo layout and package status

`agent-dx` is a folder of independent packages, not an npm workspaces, pnpm,
or lerna monorepo. There is no root `package.json`, no workspace manifest,
and no shared root `node_modules`. Each code package under `packages/`
carries its own `package.json`, install, test, and version (and a build
step where it has one), so the install pattern is the same for every
local-build package:

```bash
cd packages/<name> && npm install && npm run build
```

`git-batch-cli` is plain JavaScript and has no build step: run `npm install && npm link` in its directory instead.

If you only care about one package, work in its directory; nothing at the
root needs to be set up first.

## Package status

- `orchestrator-workflow`, `okf-kit`, `agent-primitives`, and `friction-log`
  are published to npm from `<package>/v<version>` tags (see
  `.github/workflows/publish-npm.yml`).
- `slop-detector` is deliberately unpublished: the bare `slop-detector` name
  on npm belongs to an unrelated third-party package. It runs from a local
  build (see the root README's Quick start and Usage) and ships an MCP server
  alongside the CLI.
- `agent-dev-kit`, `git-batch-cli`, and `mcp-token-audit` are
  functional CLIs, not yet published to npm.
- `github-api-tool` is marked private in its own `package.json`.
- `agent-engineering-playbook` and `agentic-coding-playbook` are
  documentation packages, not code: they have no `package.json`.

Each code package has its own version and README and its own entry in the
shared CI matrix. APIs may evolve at minor-version bumps; this workshop as a
whole is experimental.

## Playbook site

`site/` is the one directory outside `packages/` with its own `package.json`.
It is private, not a package, and builds a static
[VitePress](https://vitepress.dev) site from the Markdown of
`agent-engineering-playbook` and `agentic-coding-playbook`, which stay where
they are and remain the source. The sidebar is generated from the file tree
with titles from each file's first H1, directory links land on the folder's
README, and the build fails on a relative link whose target does not exist or
resolves outside the repository (Markdown pages, folders, and other files
alike).
For authors: raw HTML in the playbooks renders as literal text, so a
placeholder such as `<version>` shows as written, and HTML comments
(`<!-- ... -->`) are hidden except inside code. A line that starts with `<!--`
hides everything up to the first `-->` after it in the same quote or `:::`
container, blank lines and list items included, but it never cuts a fenced
code block: when that `-->` sits inside a fence opened after the comment's
first line, the opener stays visible as text, while a fence that opens and
closes inside the comment is hidden with it, and a fence in a list item counts
like any other. Lines that hold nothing but comments read as blank lines; an
opener with no `-->` after it stays visible.
A `{...}` block may set only an `id`, a `class` or
the line ranges of a code fence (`js{1,3}`); every other attribute is dropped
without a message, and an `id` that holds anything but letters, digits, `_` and
`-` is dropped too, so the heading keeps the id derived from its text. `{{ }}`
always renders as text and is never evaluated, in prose, headings, tab titles
and the contents list alike; a fenced block shows it as written.
Frontmatter is mostly not trusted as HTML. `description` is escaped in the
meta tag. `dir` is kept only when it is `ltr`, `rtl` or `auto`, and `layout`
only when it is `doc`, `home`, `page` or `false`; any other value is dropped.
The `prev` and `next` link text (as a string or as `{ text, link }`) and the
home layout's `hero` `name`, `text` and `tagline` and `features` `title`,
`details` and a string `icon` are HTML-escaped, so they show as written; an
entity reference such as `&copy;` stays one. `features` must be a list (any
other shape is dropped), and an image given as an object (`hero.image`, an
`icon`, and their `light` and `dark` sides) keeps only `src`, `alt`, `width`,
`height` and `wrap`, so it cannot set an event handler or another attribute on
the image. Two kinds of field stay as typed, and only trusted authors should
write them: `head`, whose entries are written into the page head as VitePress
documents, and the link fields (`link` in `prev`, `next`, `hero.actions` and
`features`, with `target` and `rel`), which the theme writes into `href`,
`target` and `rel` without checking the scheme, so a `javascript:` link works.
JavaScript frontmatter is refused: a page whose frontmatter opens with `---js`
or `---javascript` fails the build, because VitePress would run it as Node code
at build time. Write frontmatter as YAML (or JSON). A YAML date such as
`2024-05-01` in a text field shows as an ISO timestamp. Include directives
(`<!--@include: file.md-->`) are refused anywhere in a page and fail the build,
because VitePress reads the included file's frontmatter without that refusal
and can embed any readable file.

```bash
cd site && npm ci && npm run build   # output in site/.vitepress/dist
cd site && npm test                  # rendering checks for comments and raw HTML
cd site && npm run dev               # local preview with search
```

`.github/workflows/pages.yml` runs `npm test` and then builds the site on pull
requests that touch `site/`, the two playbooks, or the workflow itself, and
deploys it to GitHub Pages on pushes to `master` that touch the same paths, or
on a manual run on `master`.
