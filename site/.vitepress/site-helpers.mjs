import fs from 'node:fs'
import path from 'node:path'
import { htmlComments } from './html-comments.mjs'

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

// The site's own markdown options, shared by the page renderer and the title
// reader: raw HTML stays off so that placeholders like <version> render as
// text, and HTML comments are hidden by the htmlComments rules. Everything
// that changes how blocks are parsed lives here, so the sidebar titles and the
// rendered pages cannot disagree about where a heading is.
export const markdownBase = { html: false, config: (md) => md.use(htmlComments) }

// Front matter is stripped before the body is parsed, as VitePress does.
const FRONT_MATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

// Reads the title of a Markdown source with the given markdown-it instance
// (VitePress's own renderer built from markdownBase): the text of the first
// H1 token, whatever block structure produced it. Returns '' when there is
// none or it is empty.
export function createTitleReader(md) {
  return (source) => {
    const tokens = md.parse(source.replace(FRONT_MATTER, ''), {})
    const at = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1')
    if (at < 0) return ''
    const text = (tokens[at + 1].children ?? [])
      .map((c) => (c.type === 'text' || c.type === 'code_inline' ? c.content : c.type === 'softbreak' || c.type === 'hardbreak' ? ' ' : ''))
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
  // Sidebar titles come from the first H1; an empty or missing one falls back
  // to the file name.
  const titleOf = (repoRel) =>
    readTitle(fs.readFileSync(path.join(repoRoot, repoRel), 'utf8')) || path.basename(repoRel, '.md')
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
          text: d.name,
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
