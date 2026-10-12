import fs from 'node:fs'
import path from 'node:path'

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

// Title of a Markdown file: the first ATX or setext H1 outside a code fence.
// A fence closes only on a fence of the same character that is at least as
// long as the opener and carries no info string (CommonMark).
export function titleFromText(source, fallback) {
  const lines = source.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
  let fence = null
  let prev = null
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === '') fence = null
      prev = null
      continue
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = { ch: f[1][0], len: f[1].length }
      prev = null
      continue
    }
    const h = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) return h[1].replace(/[`*_]/g, '')
    if (prev !== null && /^ {0,3}=+\s*$/.test(line)) return prev.replace(/[`*_]/g, '')
    prev = /^ {0,3}\S/.test(line) && !/^ {0,3}(#|>|[-*+]\s|\d+[.)]\s)/.test(line) ? line.trim() : null
  }
  return fallback
}

export function createSite(repoRoot) {
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
  const titleOf = (repoRel) => titleFromText(fs.readFileSync(path.join(repoRoot, repoRel), 'utf8'), path.basename(repoRel, '.md'))
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
