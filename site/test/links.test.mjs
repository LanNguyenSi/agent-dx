// Regression checks for the link mapper, titles and sidebar. The mapper and
// titles run against a fixture tree; the sidebar check runs on the real repo.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMarkdownRenderer, disposeMdItInstance } from 'vitepress'
import { createSite, createTitleReader, escapeLiteral, escapeText, githubBase, markdownBase, refuseIncludes } from '../.vitepress/site-helpers.mjs'

let root
let site
let readTitle
let renderer
const AE = 'packages/agent-engineering-playbook'
const write = (rel, text = '# T\n') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-links-'))
  write(`${AE}/README.md`)
  write(`${AE}/guide.md`)
  write(`${AE}/withreadme/README.md`)
  write(`${AE}/withreadme/page.md`)
  write(`${AE}/noreadme/page.md`)
  write(`${AE}/config.yaml`, 'a: 1\n')
  write(`${AE}/img/pic.svg`, '<svg/>')
  write('docs/pic.png', 'x')
  write('packages/other/README.md')
  write('docs/note.md')
  write('site/index.md')
  // The renderer the site builds its titles with: VitePress's, from the site's
  // own markdown options.
  renderer = await createMarkdownRenderer(root, markdownBase, '/agent-dx/')
  readTitle = createTitleReader(renderer)
  site = createSite(root, readTitle)
})
after(() => {
  disposeMdItInstance()
  fs.rmSync(root, { recursive: true, force: true })
})

const from = `${AE}/guide.md`
const map = (href, f = from) => site.mapLink(href, f)

test('link to a README becomes the index page', () => {
  assert.equal(map('withreadme/README.md'), 'withreadme/index.md')
  assert.equal(map('./README.md'), './index.md')
})

test('directory with a README links to the folder page, without one to GitHub', () => {
  assert.equal(map('withreadme/'), '/agent-engineering-playbook/withreadme/')
  assert.equal(map('noreadme'), `${githubBase}/tree/master/${AE}/noreadme`)
})

test('existing non-markdown target goes to the GitHub blob URL', () => {
  assert.equal(map('config.yaml'), `${githubBase}/blob/master/${AE}/config.yaml`)
})

test('markdown outside the playbooks goes to GitHub, a playbook page stays', () => {
  assert.equal(map('../../docs/note.md'), `${githubBase}/blob/master/docs/note.md`)
  assert.equal(map('../other/README.md'), `${githubBase}/blob/master/packages/other/README.md`)
  assert.equal(map('withreadme/page.md'), 'withreadme/page.md')
})

test('hash and query survive the rewrite', () => {
  assert.equal(map('withreadme/README.md#intro'), 'withreadme/index.md#intro')
  assert.equal(map('config.yaml?plain=1#L3'), `${githubBase}/blob/master/${AE}/config.yaml?plain=1#L3`)
  assert.equal(map('withreadme/#x'), '/agent-engineering-playbook/withreadme/#x')
  assert.equal(map('#local'), '#local')
  assert.equal(map('https://example.com/a.md'), 'https://example.com/a.md')
})

test('query and hash survive on the GitHub tree and blob targets', () => {
  assert.equal(map('../../docs/note.md#sec'), `${githubBase}/blob/master/docs/note.md#sec`)
  assert.equal(map('../../docs/note.md?plain=1#L2'), `${githubBase}/blob/master/docs/note.md?plain=1#L2`)
  assert.equal(map('noreadme#x'), `${githubBase}/tree/master/${AE}/noreadme#x`)
  assert.equal(map('noreadme?tab=files#x'), `${githubBase}/tree/master/${AE}/noreadme?tab=files#x`)
  assert.equal(map('noreadme/?a=1'), `${githubBase}/tree/master/${AE}/noreadme?a=1`)
})

test('images inside a playbook stay bundled, other images go to GitHub', () => {
  assert.equal(map('img/pic.svg'), 'img/pic.svg')
  assert.equal(map('../../docs/pic.png'), `${githubBase}/blob/master/docs/pic.png`)
})

test('dead target fails and names file and href', () => {
  assert.throws(() => map('missing.md'), (e) => e.message.includes(from) && e.message.includes('missing.md'))
})

test('link escaping the repository fails and names file and href', () => {
  const href = '../../../../outside.ts'
  assert.throws(() => map(href), (e) => e.message.includes(from) && e.message.includes(href))
  assert.throws(() => map('../../..'), /outside the repository/)
})

// Titles come from VitePress's own renderer built from the site's markdown
// options, so each case pins what that parser decides, not a re-implementation.
const titleCases = {
  'ATX heading with closing hashes': ['# Atx Title #\n', 'Atx Title'],
  'setext heading, inline markup is dropped': ['Setext *Title*\n==========\n\ntext\n', 'Setext Title'],
  'multi-line setext paragraph': ['Line one\n  Line   two\n===\n', 'Line one Line two'],
  'front matter is stripped': ['---\nx: 1\n---\n# Atx Title\n', 'Atx Title'],
  'front matter holding a comment line that looks like a heading': ['---\n# a yaml comment\n---\n# Page\n', 'Page'],
  'CRLF front matter and setext': ['---\r\nx: 1\r\n---\r\nTitle\r\n===\r\n', 'Title'],
  'CRLF front matter holding a heading-like comment': ['---\r\n# a yaml comment\r\n---\r\n# Page\r\n', 'Page'],
  'front matter at the end of the file without a newline': ['---\n# c\n---', ''],
  'emoji in a heading': ['# Hi :tada:\n', 'Hi \u{1F389}'],
  'leading byte order mark': ['\uFEFF# Title\n', 'Title'],
  'placeholder line before an ATX heading is no title': ['<one focused task>\n# Goal\n', 'Goal'],
  'placeholder as setext heading text': ['<Project name>\n===\n', '&lt;Project name&gt;'],
  // The reader's output ends up in v-html sinks (sidebar, previous/next
  // footer), so it is HTML-escaped text.
  'a placeholder tag is escaped text': ['# Install <version> now\n', 'Install &lt;version&gt; now'],
  'an event-handler tag is escaped text': ['# Hi <img src=x onerror=alert(1)> there\n', 'Hi &lt;img src=x onerror=alert(1)&gt; there'],
  'a script tag is escaped text': ['# <script>alert(1)</script>\n', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  'an ampersand is escaped': ['# Q&A and R&D\n', 'Q&amp;A and R&amp;D'],
  'a code span with markup is escaped': ['# Use `<b>x</b>` here\n', 'Use &lt;b&gt;x&lt;/b&gt; here'],
  // Entities stay as written, as in the page body: escaped once, never twice.
  'an entity is kept as written': ['# a &lt;b&gt; c\n', 'a &lt;b&gt; c'],
  'an escaped entity stays one level deep': ['# a &amp;lt; b\n', 'a &amp;lt; b'],
  'a numeric entity is kept as written': ['# a &#60;b&#62; c\n', 'a &#60;b&#62; c'],
  'a backslash-escaped angle bracket is escaped': ['# a \\<b\\> c\n', 'a &lt;b&gt; c'],
  'a backslash-escaped ampersand is escaped once': ['# a \\& b\n', 'a &amp; b'],
  'a code span keeps entities literal': ['# Use `&lt;` here\n', 'Use &amp;lt; here'],
  'an ampersand that only looks like an entity start is escaped': ['# R&D and more\n', 'R&amp;D and more'],
  'quotes are escaped as in the page body': ['# It\'s a "quote"\n', 'It\'s a &quot;quote&quot;'],
  'link reference definition before a setext heading': ['[a]: /url\nFoo\n===\n', 'Foo'],
  'text inside a ::: tip container': ['::: tip\n# Inside\n:::\n# Real\n', 'Inside'],
  'setext heading inside a ::: tip container': ['::: tip Note\nText\n===\n:::\n', 'Text'],
  'tab after a list marker': ['-\tItem\n\t===\n# Real\n', 'Item'],
  'code span keeps its underscores': ['# Use `snake_case` now\n', 'Use snake_case now'],
  'underscores inside a word': ['# snake_case_name\n', 'snake_case_name'],
  'emphasis and links keep their text': ['# A *b* _c_ [the docs](x.md)\n', 'A b c the docs'],
  'html comment inside a heading': ['# Ti<!-- c -->tle\n', 'Title'],
  'html comment line before a setext heading': ['<!-- c -->\nTitle\n===\n', 'Title'],
  'html comment block hides a heading': ['<!--\n# hidden\n-->\n# Real\n', 'Real'],
  'a fenced heading is code': ['```\n# code\n```\n# Real\n', 'Real'],
  'an inner shorter fence does not close an outer fence': ['````md\n```js\n# not a title\n```\n# still code\n````\n\n# Real\n', 'Real'],
  'closing fence must use the same character': ['~~~\n```\n# code\n~~~\n# Real\n', 'Real'],
  'indented code is code': ['    # code\n# Real\n', 'Real'],
  'a list item before === is no setext title': ['- item\n===\n# Real\n', 'Real'],
  'a table row before === is no setext title': ['| a | b |\n|---|---|\n| c | d |\n===\n# Real\n', 'Real'],
  'a block quote line before === is no setext title': ['> quote\n===\n# Real\n', 'Real'],
  'setext inside a block quote': ['> Quoted\n> ===\n\n# Real\n', 'Quoted'],
  'a second-level heading is skipped': ['## Sub\n# Real\n', 'Real'],
  'no heading': ['no heading\n', ''],
  'only a fenced heading': ['```\nCode\n====\n```\n', ''],
  'empty ATX heading': ['#\n', '']
}
for (const [name, [source, expected]] of Object.entries(titleCases)) {
  test(`title reader: ${name}`, () => {
    assert.equal(readTitle(source), expected)
  })
}

test('an empty or missing H1 falls back to the file name in the sidebar', () => {
  write(`${AE}/emptyh1.md`, '#\n')
  write(`${AE}/noh1.md`, 'just text\n')
  write(`${AE}/placeholder.md`, '<Project name>\n===\n')
  const s = createSite(root, readTitle)
  assert.equal(s.titleOf(`${AE}/emptyh1.md`), 'emptyh1')
  assert.equal(s.titleOf(`${AE}/noh1.md`), 'noh1')
  assert.equal(s.titleOf(`${AE}/placeholder.md`), '&lt;Project name&gt;')
})

test('a file name used as the fallback title and a folder name are escaped', () => {
  write(`${AE}/a&b<i>.md`, 'just text\n')
  write(`${AE}/dir&<u>/page.md`)
  const s = createSite(root, readTitle)
  assert.equal(s.titleOf(`${AE}/a&b<i>.md`), 'a&amp;b&lt;i&gt;')
  const items = s.sidebarFor('agent-engineering-playbook')
  assert.ok(items.some((i) => i.text === 'a&amp;b&lt;i&gt;'))
  assert.ok(items.some((i) => i.text === 'dir&amp;&lt;u&gt;'))
  assert.ok(!items.some((i) => /[<>]|&(?!amp;|lt;|gt;)/.test(i.text)))
})

test('a file or folder name with entity-like text is shown literally, not decoded', () => {
  // escapeLiteral, not the page-text rule: a name is not markdown, so `&amp;`
  // in a name must render as the five characters it is.
  write(`${AE}/x&amp;y.md`, 'just text\n')
  write(`${AE}/d&lt;e/page.md`)
  const s = createSite(root, readTitle)
  assert.equal(s.titleOf(`${AE}/x&amp;y.md`), 'x&amp;amp;y')
  const items = s.sidebarFor('agent-engineering-playbook')
  assert.ok(items.some((i) => i.text === 'x&amp;amp;y'))
  assert.ok(items.some((i) => i.text === 'd&amp;lt;e'))
})

test('the sidebar label for a markup title is escaped and keeps the language suffix', () => {
  write(`${AE}/markup.de.md`, '# Install <version> now\n')
  const s = createSite(root, readTitle)
  const item = s.sidebarFor('agent-engineering-playbook').find((i) => i.link?.endsWith('/markup.de'))
  assert.equal(item.text, 'Install &lt;version&gt; now (DE)')
})

// The page body is rendered by the same markdown-it with raw HTML off. The
// sidebar label is the HTML that the body renders for the heading text, so the
// two read the same in the browser.
const parityHeadings = [
  'Install <version> now',
  'a &lt;b&gt; c',
  'a &amp;lt; b',
  'a &#60;b&#62; c',
  'Q&A <i>x</i>',
  'R&D and more',
  'a \\& b \\<c\\>',
  'It\'s a "quote"',
  'Use `<b>` and `&lt;` here',
  '<img src=x onerror=alert(1)>',
  'Hi :tada:'
]
for (const heading of parityHeadings) {
  test(`the sidebar label matches the heading text in the rendered page: ${heading}`, () => {
    const html = renderer.render(`# ${heading}\n`, { relativePath: 'x.md' })
    const inner = /^<h1[^>]*>([\s\S]*?)<a class="header-anchor"/.exec(html)?.[1].replace(/<\/?code>/g, '')
    assert.ok(inner, html)
    assert.equal(readTitle(`# ${heading}\n`), inner.trim())
  })
}

test('escapeText keeps entities and escapes everything else, escapeLiteral escapes all', () => {
  assert.equal(escapeText(`<a href="x">&amp; &#60; &copy; R&D</a>`), `&lt;a href=&quot;x&quot;&gt;&amp; &#60; &copy; R&amp;D&lt;/a&gt;`)
  assert.equal(escapeLiteral(`<a href="x">&amp;</a>`), `&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;`)
})

test('createSite refuses to run without a title reader', () => {
  assert.throws(() => createSite(root), /readTitle/)
})

test('a page with an include directive is refused with its path, in any spelling and place', () => {
  const variants = {
    plain: '<!--@include: ../docs/note.md-->',
    spaced: '<!--   @include:   ../docs/note.md   -->',
    newline: '<!--\n@include: ../docs/note.md-->',
    fenced: '```md\n<!--@include: ../docs/note.md-->\n```',
    indented: '    <!--@include: ../docs/note.md-->'
  }
  for (const [name, directive] of Object.entries(variants)) {
    const rel = `${AE}/inc-${name}.md`
    write(rel, `# T\n\n${directive}\n`)
    try {
      assert.throws(() => createSite(root, readTitle), new RegExp(`Include directives are not supported: ${rel.replaceAll('/', '\\/')}`), name)
    } finally {
      fs.rmSync(path.join(root, rel))
    }
  }
  assert.doesNotThrow(() => createSite(root, readTitle))
})

test('an include directive in site/index.md is refused too', () => {
  const index = path.join(root, 'site/index.md')
  const clean = fs.readFileSync(index, 'utf8')
  fs.writeFileSync(index, `${clean}\r\n<!--\t@include: ../docs/note.md-->\r\n`)
  try {
    assert.throws(() => createSite(root, readTitle), /Include directives are not supported: site\/index\.md/)
  } finally {
    fs.writeFileSync(index, clean)
  }
  assert.doesNotThrow(() => createSite(root, readTitle))
})

test('refuseIncludes passes a page that mentions includes without the directive', () => {
  write(`${AE}/inc-text.md`, '# T\n\nThe @include: syntax and <!-- a comment --> are fine.\n')
  try {
    assert.doesNotThrow(() => refuseIncludes(root, { [`${AE}/inc-text.md`]: 'x.md' }))
  } finally {
    fs.rmSync(path.join(root, `${AE}/inc-text.md`))
  }
})

test('sidebar links every playbook page exactly once', () => {
  const real = createSite(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), readTitle)
  const links = []
  const collect = (items) => {
    for (const i of items) {
      if (i.link) links.push(i.link)
      if (i.items) collect(i.items)
    }
  }
  for (const pb of ['agent-engineering-playbook', 'agentic-coding-playbook']) collect(real.sidebarFor(pb))
  const expected = real.pages.map((p) => {
    const s = real.rewrites[p].replace(/\.md$/, '')
    return '/' + (/(^|\/)index$/.test(s) ? s.replace(/index$/, '') : s)
  })
  assert.ok(expected.length > 0)
  assert.deepEqual([...links].sort(), [...expected].sort())
  assert.equal(new Set(links).size, links.length)
})
