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
Text such as `</script>`, `</SCRIPT >`, `<!--` or `<script` in a title, a
description, a heading or any other frontmatter text builds and shows as
written.
Frontmatter is mostly not trusted as HTML. `description` is escaped in the
meta tag. `dir` is kept only when it is `ltr`, `rtl` or `auto`, and `layout`
only when it is `doc`, `home`, `page` or `false`; any other value is dropped.
The `prev` and `next` link text (as a string or as `{ text, link }`) and the
home layout's `hero` `name`, `text` and `tagline` and `features` `title`,
`details` and a string `icon` are HTML-escaped, so they show as written; an
entity reference such as `&copy;` stays one. A feature `icon` that is neither a
string nor an object (`null`, a number, a boolean, a list) is dropped, so the
feature shows without an icon. `features` must be a list (any
other shape is dropped), and an image given as an object (`hero.image`, an
`icon`, and their `light` and `dark` sides) keeps only `src`, `alt`, `width`,
`height` and `wrap`, so it cannot set an event handler or another attribute on
the image. `head` stays as typed, and only trusted authors should write it: its
entries are written into the page head as VitePress documents. The link fields
(`link` in `prev`, `next`, `hero.actions` and `features`) are no longer a raw
path: a link is kept only when it is `http:`, `https:` or `mailto:` (the scheme
in any letter case), or relative to the site: a path (`a/b`, `./a`, `../a`),
a root path (`/a`), `#fragment` or `?query`. Anything else is dropped, so the
button, card or footer link renders without it (a footer link then falls back
to the neighbour the sidebar gives). That covers other schemes (`javascript:`,
`data:`, `vbscript:`, `blob:`, `file:`, `tel:`), a value that is not a string,
a scheme-relative `//host` (write `https://host` to link elsewhere), a
backslash (browsers read it as a slash), and any space or control character
(percent-encode a space as `%20`; a leading space, tab or newline would hide a
scheme from this check but not from the browser). A path whose first segment
holds a colon needs a leading `./` (`./a:b`). The theme does not write a
relative link as typed: it parses the value and writes the parsed path back,
so a relative value that comes out of that as `//host/...` is dropped too,
for example `/.//host/x`, `/a/..//host/x` (dot segments before a double
slash) and `/$1/host/x` (a `$` pattern in the path). Without this the link
would point at another site and carry none of the markers the theme gives an
external link. A `//` inside a path (`/a//b`) and leading dots (`..//a`) stay
on the site and are kept. A relative value with a backtick is dropped as well
(write `%60`): `$` followed by a backtick is a replacement pattern that
inserts the text before the match, so ``/$`/host/x`` would be written as
`//host/x` by an engine that leaves the backtick in the path. The URL
standard percent-encodes it there, and the check does not rely on that. The
check repeats the theme's own computation (`normalizeLink` and `withBase` in
the VitePress default theme). The site tests (`site/test/theme-href.test.mjs`)
run the installed theme's functions over a generated corpus and compare them
with that copy, so a VitePress upgrade that changes the rewrite fails the
suite; after an upgrade read both functions again as well. `target` on a hero
action or a feature is kept only as `_blank`, `_self`, `_parent` or `_top`,
and `rel` only when every space-separated token is one of `noopener`,
`noreferrer`, `nofollow`, `external`, `sponsored`, `ugc`, `me`, `author`,
`help`, `license`, `bookmark`, `tag`, `prev`, `next`, `alternate` or
`search`; otherwise the theme's own default applies. An author-set `rel`
replaces the theme's default `noreferrer` for an external link, so list
`noreferrer` too when the link should have it; `opener` is not on the list, so
a link to a new window never gives that window access to the page.
`hero.actions` must be a list, like `features`.
JavaScript frontmatter is refused: a page whose frontmatter opens with `---js`
or `---javascript` fails the build, because VitePress would run it as Node code
at build time. Write frontmatter as YAML (or JSON). A YAML date such as
`2024-05-01` in a text field shows as an ISO timestamp. Include directives
(`<!--@include: file.md-->`) are refused anywhere in a page and fail the build,
because VitePress reads the included file's frontmatter without that refusal
and can embed any readable file. The check runs when the site config
loads (build and dev-server start); a running dev server does not re-check
pages edited later, so do not point one at untrusted content.

Playbook content under `packages/agent-engineering-playbook` and
`packages/agentic-coding-playbook` is Markdown with YAML or JSON frontmatter,
images, and YAML or JSON data files. Anything that would run Node code during
the build fails it, naming the file: a `*.paths.*` file (VitePress imports it
to list the pages of a dynamic route such as `[name].md`) and any file ending
in `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts`, matched without regard to
case and at any depth. A symbolic link anywhere under those directories also
fails the build, whatever it points at, because VitePress follows a link to a
directory when it looks for pages. The check looks at file names and entry
types only, never opens or follows anything, and runs when the site config
loads before VitePress reads any page. Like the checks above it runs at
dev-server start and not again for files added while the server runs, so a
running dev server still must not be pointed at untrusted content.

```bash
cd site && npm ci && npm run build   # output in site/.vitepress/dist
cd site && npm test                  # rendering checks for comments and raw HTML
cd site && npm run dev               # local preview with search
```

`.github/workflows/pages.yml` runs `npm test` and then builds the site on pull
requests that touch `site/`, the two playbooks, or the workflow itself, and
deploys it to GitHub Pages on pushes to `master` that touch the same paths, or
on a manual run on `master`.
