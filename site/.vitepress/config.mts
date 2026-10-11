import { defineConfig, type DefaultTheme } from 'vitepress'
import type MarkdownIt from 'markdown-it'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { htmlComments } from './html-comments.mjs'

// The site is built from the Markdown in place. srcDir is the repository
// root, and only the two playbooks plus site/index.md are pages.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const playbooks = ['agent-engineering-playbook', 'agentic-coding-playbook']
const githubBase = 'https://github.com/LanNguyenSi/agent-dx'

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  )
}

const pages = playbooks.flatMap((pb) =>
  walk(path.join(repoRoot, 'packages', pb))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.relative(repoRoot, f).split(path.sep).join('/'))
)

// packages/<pb>/<dir>/README.md -> <pb>/<dir>/index.md, so that directory
// links land on the folder's README.
function sitePath(repoRel: string): string {
  return repoRel.replace(/^packages\//, '').replace(/(^|\/)README\.md$/i, '$1index.md')
}

const rewrites: Record<string, string> = { 'site/index.md': 'index.md' }
for (const p of pages) rewrites[p] = sitePath(p)

const isPage = (repoRel: string) => pages.includes(repoRel)

// Resolve a relative link found in `fromRepoRel` to a target the site can
// serve. Targets that exist but are not site pages (yaml, json, folders
// without a README, files outside the playbooks) go to the GitHub view.
// A relative target that does not exist (or has a malformed percent escape)
// fails the build with the file and href, whatever its extension.
function mapLink(href: string, fromRepoRel: string): string {
  if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return href
  const m = /^([^?#]*)([?#].*)?$/.exec(href)!
  let target: string
  try {
    target = decodeURI(m[1])
  } catch {
    throw new Error(`Dead link in ${fromRepoRel}: ${href} (malformed percent escape)`)
  }
  const suffix = m[2] ?? ''
  if (!target) return href
  const abs = path.resolve(repoRoot, path.dirname(fromRepoRel), target)
  const rel = path.relative(repoRoot, abs).split(path.sep).join('/')
  if (rel.startsWith('..')) return href
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

function linkMapper(md: MarkdownIt) {
  md.use(htmlComments)
  md.core.ruler.push('agent-dx-links', (state) => {
    const rel = (state.env.relativePath as string | undefined) ?? ''
    // env.relativePath is the rewritten path; find the source file again.
    const source = Object.keys(rewrites).find((k) => rewrites[k] === rel)
    if (!source || source === 'site/index.md') return
    for (const blk of state.tokens) {
      for (const t of blk.children ?? []) {
        const attr = t.type === 'link_open' ? 'href' : t.type === 'image' ? 'src' : ''
        if (!attr) continue
        const v = t.attrGet(attr)
        if (v) t.attrSet(attr, mapLink(v, source))
      }
    }
  })
}

// Sidebar from the file tree, titles from the first H1. The language is
// visible in the label: *.de.md files and the German file names get "(DE)".
// German-named files without a .de.md suffix must be listed here to get the (DE) label.
const germanFiles = new Set([
  'agentic-coding-playbook/PLAYBOOK.md',
  'agentic-coding-playbook/references/review-stufen-und-qualitaetsstandards.md',
  'agentic-coding-playbook/standards/implementierungs-agent-standard.md'
])
const isGerman = (repoRel: string) => /\.de\.md$/.test(repoRel) || germanFiles.has(repoRel.replace(/^packages\//, ''))

function titleOf(repoRel: string): string {
  const text = fs.readFileSync(path.join(repoRoot, repoRel), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const h = !inFence && /^#\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) return h[1].replace(/[`*_]/g, '')
  }
  return path.basename(repoRel, '.md')
}

function labelOf(repoRel: string): string {
  const title = titleOf(repoRel)
  return isGerman(repoRel) && !/\((DE|Deutsch)\)/i.test(title) ? `${title} (DE)` : title
}

function sidebarFor(pb: string): DefaultTheme.SidebarItem[] {
  const base = `packages/${pb}`
  const build = (dir: string): DefaultTheme.SidebarItem[] => {
    const entries = fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !/^README\.md$/i.test(e.name))
      .map((e) => `${dir}/${e.name}`)
      .sort()
      .map((f) => ({
        text: labelOf(f),
        link: '/' + sitePath(f).replace(/\.md$/, '')
      }))
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
  return [
    { text: titleOf(`${base}/README.md`), link: `/${pb}/` },
    ...build(base)
  ]
}

export default defineConfig({
  title: 'agent-dx playbooks',
  description: 'Agent Engineering Playbook and Agentic Coding Playbook from agent-dx',
  base: '/agent-dx/',
  srcDir: '..',
  // Only the two playbooks and the site home page are pages.
  srcExclude: ['*.md', '!(packages|site)/**', 'packages/!(agent-engineering-playbook|agentic-coding-playbook)/**', 'site/!(index.md)', '.*/**'],
  rewrites,
  cleanUrls: true,
  // The Markdown lives outside site/, so bare imports compiled into those
  // pages (vue, vue/server-renderer) cannot find site/node_modules by walking
  // up from the page file. Resolve them from this config file instead.
  vite: {
    plugins: [
      {
        name: 'agent-dx-resolve-vue-from-site',
        enforce: 'pre',
        async resolveId(id, importer, options) {
          if (!/^vue(\/|$)/.test(id) || !importer?.startsWith(repoRoot + path.sep + 'packages' + path.sep)) return null
          return this.resolve(id, fileURLToPath(import.meta.url), { ...options, skipSelf: true })
        }
      }
    ]
  },
  lastUpdated: false,
  // Raw HTML is parsed so that markdown-it decides what is a comment; the
  // htmlComments renderer rules drop comments and escape any other HTML, so
  // placeholders like <version> still render as text.
  markdown: { html: true, config: linkMapper },
  themeConfig: {
    search: { provider: 'local' },
    nav: [
      { text: 'Agent Engineering', link: '/agent-engineering-playbook/' },
      { text: 'Agentic Coding', link: '/agentic-coding-playbook/' }
    ],
    sidebar: {
      '/agent-engineering-playbook/': sidebarFor('agent-engineering-playbook'),
      '/agentic-coding-playbook/': sidebarFor('agentic-coding-playbook')
    },
    socialLinks: [{ icon: 'github', link: githubBase }]
  }
})
