import fs from 'node:fs'
import path from 'node:path'
import { htmlComments } from './html-comments.mjs'
import { allowedAttributes, rawOutput } from './raw-output.mjs'

// Pure helpers behind the site config: link mapping, titles and the sidebar.
// They take the repository root as a parameter so a test can run them against
// a fixture tree without booting VitePress.

export const playbooks = ['agent-engineering-playbook', 'agentic-coding-playbook']
export const githubBase = 'https://github.com/LanNguyenSi/agent-dx'

// German-named files without a .de.md suffix must be listed here to get the (DE) label.
export const germanFiles = new Set([
  'agentic-coding-playbook/PLAYBOOK.md',
  'agentic-coding-playbook/references/review-stufen-und-qualitaetsstandards.md',
  'agentic-coding-playbook/standards/implementierungs-agent-standard.md'
])

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  )
}

// packages/<pb>/<dir>/README.md -> <pb>/<dir>/index.md, so that directory
// links land on the folder's README.
export function sitePath(repoRel) {
  return repoRel.replace(/^packages\//, '').replace(/(^|\/)README\.md$/i, '$1index.md')
}

// VitePress reads frontmatter with a bundled gray-matter, which hands a block
// that opens with `---js` or `---javascript` to eval: Node code, at build time,
// from the first line of a page. The javascript engine is replaced by one that
// refuses. gray-matter reads `js` as an alias of `javascript` when no engine is
// registered under the written name, so this one key covers both spellings
// (checked against the bundled copy: its only default engines are yaml, json
// and javascript, and coffee/cson have none and fail as unregistered).
// This covers the page renderer, which reads the pages and builds the search
// index. Content loaders (createContentLoader) read frontmatter without these
// options; this site has none. An include directive also reads another file's
// frontmatter without them, which is why refuseIncludes below exists.
export const refuseJavaScript = {
  parse() {
    throw new Error('JavaScript frontmatter is not supported')
  }
}

// The site's own markdown options, shared by the page renderer and the title
// reader: raw HTML stays off so that placeholders like <version> render as
// text, and HTML comments are hidden by the htmlComments rules. Everything
// that changes how blocks are parsed lives here, so the sidebar titles and the
// rendered pages cannot disagree about where a heading is.
export const markdownBase = {
  html: false,
  attrs: { allowedAttributes },
  frontmatter: { grayMatterOptions: { engines: { javascript: refuseJavaScript } } },
  config: (md) => {
    md.use(htmlComments)
    md.use(rawOutput)
  }
}

// VitePress expands `<!--@include: file.md-->` before the page is parsed and
// reads the included file's frontmatter without the options above, so that
// file could carry a `---js` block that runs at build time; the directive can
// also embed any readable file into a page. VitePress matches the directive
// anywhere in the source, code fences included, so this refuses it anywhere too.
export const includeDirective = /<!--\s*@include:/

// Fails with the page path when a page source holds an include directive.
// `pages` is the rewrites map (repository-relative page paths as keys).
export function refuseIncludes(repoRoot, pages) {
  for (const page of Object.keys(pages)) {
    if (includeDirective.test(fs.readFileSync(path.join(repoRoot, page), 'utf8'))) {
      throw new Error(`Include directives are not supported: ${page}`)
    }
  }
}

// VitePress runs Node code at build time from files that sit next to the pages:
// a dynamic route's `[name].paths.*` file is imported to list its pages, and a
// script file next to a page can be pulled in by one. Playbook content is
// Markdown, images and YAML or JSON data, so the files below fail the build
// instead: any `*.paths.*` file and anything ending in .js, .mjs, .cjs, .ts,
// .mts or .cts, matched on the file name without regard to case.
//
// A symbolic link is refused whatever it points at. VitePress follows a link to
// a directory when it looks for pages, so a link to a directory holding a
// paths file would run it; the check cannot follow the link to look inside
// (the target may sit anywhere), so it refuses the link itself. This also keeps
// the walk finite when a link points back up the tree.
//
// The check looks at names and entry types only: it never opens or imports an
// offending file or follows a link. `createSite` runs it while the config
// loads, which is before VitePress resolves any page and so before any such
// file could be imported.
const pathsFile = /\.paths\./i
const codeFile = /\.(?:js|mjs|cjs|ts|mts|cts)$/i

// Lists the repository-relative paths (with a flag for symbolic links) under
// `dir` that the check refuses. A link is reported and not entered.
function buildTimeCodeIn(repoRoot, dir) {
  const rel = (full) => path.relative(repoRoot, full).split(path.sep).join('/')
  if (fs.lstatSync(dir).isSymbolicLink()) return [{ path: rel(dir), link: true }]
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isSymbolicLink()) return [{ path: rel(full), link: true }]
    if (e.isDirectory()) return buildTimeCodeIn(repoRoot, full)
    return pathsFile.test(e.name) || codeFile.test(e.name) ? [{ path: rel(full), link: false }] : []
  })
}

// Fails with the repository-relative path of the first offending entry, in
// sorted order, when a playbook directory holds a build-time code file or a
// symbolic link.
export function refuseBuildTimeCode(repoRoot) {
  const offending = playbooks
    .flatMap((pb) => {
      const dir = path.join(repoRoot, 'packages', pb)
      return fs.existsSync(dir) || isLink(dir) ? buildTimeCodeIn(repoRoot, dir) : []
    })
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  if (offending.length > 0) {
    const { path: rel, link } = offending[0]
    throw new Error(`Build-time code is not supported in playbook content: ${rel}${link ? ' (symbolic link)' : ''}`)
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// A leading byte order mark and front matter are stripped before the body is
// parsed, as VitePress does.
const FRONT_MATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

// The default theme renders sidebar labels and the previous/next footer with
// v-html, so every string that becomes a sidebar `text` must be HTML-escaped.
//
// escapeLiteral escapes a string that is plain text (a file or folder name, or
// an inline code span): & < > and ".
export const escapeLiteral = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// escapeText escapes a markdown-it text token exactly as the page renderer
// does (VitePress's restoreEntities text rule): entity references written in
// the source stay as written, because VitePress keeps them raw in the token, so
// the label reads like the heading on the page and an entity is escaped once,
// never twice. Everything else is escaped as in escapeLiteral; what survives
// unescaped is only `&` followed by word characters or `#` and a `;`.
export const escapeText = (text) =>
  text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/&(?![\w#]+;)/g, '&amp;')

// Reads the title of a Markdown source with the given markdown-it instance
// (VitePress's own renderer built from markdownBase): the text of the first
// H1 token, whatever block structure produced it, as HTML-escaped text the way
// the page body escapes it (see escapeText and escapeLiteral). Returns '' when
// there is none or it is empty.
export function createTitleReader(md) {
  return (source) => {
    const tokens = md.parse(source.replace(/^\uFEFF/, '').replace(FRONT_MATTER, ''), {})
    const at = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1')
    if (at < 0) return ''
    const text = (tokens[at + 1].children ?? [])
      .map((c) =>
        c.type === 'text'
          ? escapeText(c.content)
          : c.type === 'code_inline'
            ? escapeLiteral(c.content)
            : c.type === 'emoji'
              ? c.content
              : c.type === 'softbreak' || c.type === 'hardbreak'
                ? ' '
                : ''
      )
      .join('')
    return text.replace(/\s+/g, ' ').trim()
  }
}

// readTitle(source) returns the first H1 of a Markdown source, or '' (see
// createTitleReader). It is a parameter so these helpers load without VitePress.
export function createSite(repoRoot, readTitle) {
  if (typeof readTitle !== 'function') throw new TypeError('createSite needs a readTitle function')
  const pages = playbooks.flatMap((pb) => {
    const dir = path.join(repoRoot, 'packages', pb)
    return fs.existsSync(dir)
      ? walk(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => path.relative(repoRoot, f).split(path.sep).join('/'))
      : []
  })
  const rewrites = { 'site/index.md': 'index.md' }
  for (const p of pages) rewrites[p] = sitePath(p)
  refuseBuildTimeCode(repoRoot)
  refuseIncludes(repoRoot, rewrites)
  const isPage = (repoRel) => pages.includes(repoRel)

  // Resolve a relative link found in `fromRepoRel` to a target the site can
  // serve. Targets that exist but are not site pages (yaml, json, folders
  // without a README, files outside the playbooks) go to the GitHub view.
  // A relative target that does not exist, resolves outside the repository,
  // or has a malformed percent escape fails the build with the file and href.
  function mapLink(href, fromRepoRel) {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return href
    const m = /^([^?#]*)([?#].*)?$/.exec(href)
    let target
    try {
      target = decodeURI(m[1])
    } catch {
      throw new Error(`Dead link in ${fromRepoRel}: ${href} (malformed percent escape)`)
    }
    const suffix = m[2] ?? ''
    if (!target) return href
    const abs = path.resolve(repoRoot, path.dirname(fromRepoRel), target)
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/')
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      throw new Error(`Dead link in ${fromRepoRel}: ${href} (target is outside the repository)`)
    }
    if (!fs.existsSync(abs)) throw new Error(`Dead link in ${fromRepoRel}: ${href} (target does not exist)`)
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      const readme = fs.readdirSync(abs).find((n) => /^README\.md$/i.test(n))
      if (readme && isPage(`${rel}/${readme}`)) return `/${rel.replace(/^packages\//, '')}/${suffix}`
      return `${githubBase}/tree/master/${rel}${suffix}`
    }
    if (rel.endsWith('.md')) {
      if (isPage(rel)) {
        // A README page is served as index.md; point at it explicitly.
        return /(^|\/)README\.md$/i.test(rel) ? target.replace(/README\.md$/i, 'index.md') + suffix : href
      }
      return `${githubBase}/blob/master/${rel}${suffix}`
    }
    // Images next to the pages are bundled by VitePress; other files go to GitHub.
    if (/\.(svg|png|jpe?g|gif|webp)$/i.test(rel) && playbooks.some((pb) => rel.startsWith(`packages/${pb}/`))) return href
    return `${githubBase}/blob/master/${rel}${suffix}`
  }

  const isGerman = (repoRel) => /\.de\.md$/.test(repoRel) || germanFiles.has(repoRel.replace(/^packages\//, ''))
  // Sidebar titles come from the first H1 (already HTML-escaped by the reader);
  // an empty or missing one falls back to the file name, escaped the same way.
  const titleOf = (repoRel) =>
    readTitle(fs.readFileSync(path.join(repoRoot, repoRel), 'utf8')) || escapeLiteral(path.basename(repoRel, '.md'))
  // The language is visible in the label: *.de.md files and the German file
  // names get "(DE)".
  function labelOf(repoRel) {
    const title = titleOf(repoRel)
    return isGerman(repoRel) && !/\((DE|Deutsch)\)/i.test(title) ? `${title} (DE)` : title
  }

  function sidebarFor(pb) {
    const base = `packages/${pb}`
    const build = (dir) => {
      const entries = fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.md') && !/^README\.md$/i.test(e.name))
        .map((e) => `${dir}/${e.name}`)
        .sort()
        .map((f) => ({ text: labelOf(f), link: '/' + sitePath(f).replace(/\.md$/, '') }))
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => {
          const sub = `${dir}/${e.name}`
          const readme = fs.readdirSync(path.join(repoRoot, sub)).find((n) => /^README\.md$/i.test(n))
          return { name: e.name, sub, readme, items: build(sub) }
        })
        // A folder is listed when it has pages or a README (README-only folders too).
        .filter((d) => d.items.length > 0 || d.readme)
        .map((d) => ({
          text: escapeLiteral(d.name),
          ...(d.readme ? { link: '/' + sitePath(`${d.sub}/${d.readme}`).replace(/\.md$/, '').replace(/index$/, '') } : {}),
          collapsed: true,
          items: d.items
        }))
      return [...files, ...dirs]
    }
    return [{ text: titleOf(`${base}/README.md`), link: `/${pb}/` }, ...build(base)]
  }

  return { pages, rewrites, mapLink, titleOf, sidebarFor }
}
