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

// Block-level scan for the first H1 of a Markdown source, following the
// CommonMark/markdown-it block structure for the shapes that matter for a
// title: fenced code, indented code, HTML blocks, tables, block quotes and
// list items (each scanned recursively, with lazy continuation lines kept out
// of setext underlines), ATX headings and multi-line setext paragraphs.
const expandTabs = (line) => {
  const m = /^[ \t]*/.exec(line)[0]
  let col = 0
  for (const c of m) col = c === '\t' ? col + 4 - (col % 4) : col + 1
  return ' '.repeat(col) + line.slice(m.length)
}
const indentOf = (line) => /^ */.exec(line)[0].length
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX = /^ {0,3}#(?:[ \t]+(.*?))?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'
const HTML_END = [
  [/^ {0,3}<(script|pre|style|textarea)(\s|>|$)/i, /<\/(script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/]
]
const HTML6 = new RegExp(`^ {0,3}</?(${BLOCK_TAGS})(\\s|/?>|$)`, 'i')
const HTML7 = /^ {0,3}(<[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/
const splitCells = (row) => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/)
const isDelimiter = (row) => /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(row)
const startsBlock = (line) =>
  FENCE.test(line) || ATX.test(line) || QUOTE.test(line) || HR.test(line) || ITEM.test(line) || HTML6.test(line) || HTML_END.some(([start]) => start.test(line))
// Prefix on a lazy continuation line, so that it can never be a setext underline.
const LAZY = '\u0001'
const plain = (text) => text.replaceAll(LAZY, '').replace(/[`*_]/g, '')

function h1Of(rawLines) {
  const lines = rawLines.map(expandTabs)
  let fence = null
  let para = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === '') fence = null
      continue
    }
    if (line.trim() === '') {
      para = null
      continue
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = { ch: f[1][0], len: f[1].length }
      para = null
      continue
    }
    const h = ATX.exec(line)
    if (h) return plain((h[1] ?? '').replace(/(^|[ \t])#+$/, '').trim())
    if (para && /^ {0,3}=+[ \t]*$/.test(line)) return plain(para.join(' ').replace(/\s+/g, ' ').trim())
    if (para && /^ {0,3}-+[ \t]*$/.test(line)) {
      para = null
      continue
    }
    if (HR.test(line)) {
      para = null
      continue
    }
    if (QUOTE.test(line)) {
      const inner = []
      let j = i
      for (; j < lines.length; j++) {
        if (QUOTE.test(lines[j])) inner.push(lines[j].replace(QUOTE, ''))
        else if (lines[j].trim() !== '' && inner.at(-1)?.trim() && !startsBlock(lines[j])) inner.push(LAZY + lines[j])
        else break
      }
      const t = h1Of(inner)
      if (t !== null) return t
      i = j - 1
      para = null
      continue
    }
    const it = ITEM.exec(line)
    if (it && (para === null || it[4].trim() !== '')) {
      const gap = it[3].length
      const offset = it[1].length + it[2].length + (it[4].trim() === '' || gap > 4 ? 1 : gap)
      const inner = [(gap > 4 ? ' '.repeat(gap - 1) : '') + it[4]]
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === '') inner.push('')
        else if (indentOf(l) >= offset) inner.push(l.slice(offset))
        else if (inner.at(-1).trim() && !startsBlock(l)) inner.push(LAZY + l)
        else break
      }
      const t = h1Of(inner)
      if (t !== null) return t
      i = j - 1
      para = null
      continue
    }
    const html = HTML_END.find(([start]) => start.test(line))
    if (html || HTML6.test(line) || (para === null && HTML7.test(line))) {
      const end = html?.[1]
      let j = i
      if (end) while (j < lines.length - 1 && !end.test(lines[j])) j++
      else while (j + 1 < lines.length && lines[j + 1].trim() !== '') j++
      i = j
      para = null
      continue
    }
    if (para && isDelimiter(line) && splitCells(para.at(-1)).length === splitCells(line).length && para.at(-1).includes('|')) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== '' && !startsBlock(lines[j])) j++
      i = j - 1
      para = null
      continue
    }
    if (para === null && indentOf(line) >= 4) continue
    if (para === null) para = []
    para.push(line.trim())
  }
  return null
}

// Title of a Markdown file: the first H1 (ATX or setext) outside code, or the
// fallback. Matches markdown-it's block structure, not a line-by-line regex.
export function titleFromText(source, fallback) {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  return h1Of(body.split(/\r?\n/)) ?? fallback
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
  // Sidebar titles come from the first H1; an empty or missing one falls back
  // to the file name.
  const titleOf = (repoRel) =>
    titleFromText(fs.readFileSync(path.join(repoRoot, repoRel), 'utf8'), '') || path.basename(repoRel, '.md')
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
