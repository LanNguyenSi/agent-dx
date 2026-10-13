// Builds a small site from hostile Markdown with the site's real markdown
// options and checks the HTML that comes out: nothing the author wrote becomes
// a tag or an event handler, and a mustache is shown as text, not evaluated
// while the page is rendered.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'vitepress'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hardening')
const LS = ' '
const PS = ' '
// The pages that carry a line separator are written here so that the fixture
// file holds no invisible characters.
const separatorsPage = `separators-${process.pid}`
let work
let out
let html
let sep
let pages
before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dx-site-hardening-'))
  out = path.join(work, 'out')
  process.env.AGENT_DX_HARDENING_CACHE = path.join(work, 'cache')
  fs.writeFileSync(
    path.join(root, `${separatorsPage}.md`),
    [
      '# Separators',
      '',
      '```{{ constructor.constructor(\'ls\')() }}' + LS + 'b',
      'x',
      '```',
      '',
      '```{{ constructor.constructor(\'ps\')() }}' + PS + 'b',
      'x',
      '```',
      '',
      '~~~{{ constructor.constructor(\'tilde\')() }}' + LS + 'b',
      'x',
      '~~~',
      '',
      '::: code-group',
      '',
      '```js [{{ constructor.constructor(\'tabls\')() }}]' + LS + ']',
      'x',
      '```',
      '',
      '```js [{{ constructor.constructor(\'tabps\')() }}]' + PS + ']',
      'x',
      '```',
      '',
      '```<img/src=x/onerror=lang>' + LS + 'b',
      'x',
      '```',
      '',
      '```js [<img src=x onerror=tab>]' + PS + ']',
      'x',
      '```',
      '',
      ':::',
      ''
    ].join('\n')
  )
  await build(root, { outDir: out })
  html = fs.readFileSync(path.join(out, 'index.html'), 'utf8')
  sep = fs.readFileSync(path.join(out, `${separatorsPage}.html`), 'utf8')
  pages = Object.fromEntries(
    ['dir-breakout', 'dir-rtl', 'dir-steer', 'nav/two', 'nav/three', 'home-layout'].map((name) => [
      name,
      fs.readFileSync(path.join(out, `${name}.html`), 'utf8')
    ])
  )
})
after(() => {
  fs.rmSync(path.join(root, `${separatorsPage}.md`), { force: true })
  fs.rmSync(work, { recursive: true, force: true })
  delete process.env.AGENT_DX_HARDENING_CACHE
})

// The page data VitePress writes into the client chunk of a page, as JSON.
const pageData = (page) => {
  const assets = path.join(out, 'assets')
  const chunk = fs.readdirSync(assets).find((f) => f.startsWith(`${page}.md.`) && f.endsWith('.lean.js'))
  assert.ok(chunk, fs.readdirSync(assets).join())
  const literal = /JSON\.parse\((`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/.exec(fs.readFileSync(path.join(assets, chunk), 'utf8'))?.[1]
  assert.ok(literal)
  return JSON.parse(vm.runInNewContext(literal))
}

// The page content, without the head and the script tags VitePress writes.
const content = (page) => page.slice(page.indexOf('<main'), page.indexOf('</main>'))
const body = () => content(html)
const liveTags = (page) => {
  const stripped = content(page).replace(/="[^"]*"/g, '=""')
  return [...stripped.matchAll(/<(?:img|script|svg|iframe|b|i)[\s/>]|<[a-z][^>]*\son\w+=/g)].map((m) => m[0])
}

test('author text becomes no tag and no event handler', () => {
  assert.deepEqual(liveTags(html), [])
  assert.match(body(), /<span class="lang"[^>]*>&lt;img\/src/)
  assert.match(body(), /<p class="custom-block-title">&lt;img src=x onerror=alert&gt;/)
  assert.match(body(), /for="[^"]+">&lt;img src=x onerror=tab&gt;/)
})

test('a curly block keeps its class and drops its event handler', () => {
  assert.match(body(), /<p class="keep">Handler text<\/p>/)
  assert.doesNotMatch(body(), /onclick/)
})

test('a mustache is shown as text in every place, not evaluated', () => {
  for (const marker of ['title', 'prose', 'code', 'indented', 'tab', 'alert', 'toc']) {
    assert.ok(body().includes(`{{ constructor.constructor(&#39;${marker}&#39;)() }}`), `${marker}: ${body()}`)
  }
})

test('a mustache in a fenced block still reads as written', () => {
  const fenced = body().match(/<pre[\s\S]*?<\/pre>/g).find((p) => p.includes('fenced'))
  assert.ok(fenced, body())
  assert.match(fenced.replace(/<[^>]+>/g, '').replaceAll('&#39;', "'"),/const fenced = \{\{ constructor\.constructor\('fenced'\)\(\) \}\}/)
})

test('a line separator in a fence info string or tab title opens nothing', () => {
  assert.deepEqual(liveTags(sep), [])
  for (const marker of ['ls', 'ps', 'tilde', 'tabls', 'tabps']) {
    assert.ok(content(sep).includes(`{{ constructor.constructor(&#39;${marker}&#39;)() }}`), `${marker}: ${content(sep)}`)
  }
  assert.match(content(sep), /<span class="lang"[^>]*>&lt;img\/src/)
  assert.match(content(sep), /for="[^"]+">&lt;img src=x onerror=tab&gt;/)
})

test('an explicit id with markup is dropped, so the contents list holds no tag or handler', () => {
  const toc = /<nav class="table-of-contents">[\s\S]*?<\/nav>/.exec(html)?.[0]
  assert.ok(toc, body())
  assert.doesNotMatch(toc.replace(/="[^"]*"/g, '=""'), /<img|\son\w+=/)
  assert.match(toc, /href="#plain-section"/)
  assert.match(toc, /href="#kept-id_1"/)
  assert.match(toc, /href="#beta"[^>]*>Beta</)
  assert.match(toc, /href="#gamma"[^>]*>Gamma</)
})

test('the page title is escaped in the HTML and plain text in the page data', () => {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]
  assert.ok(title?.startsWith('Title &lt;b&gt;bold&lt;/b&gt; &amp; &quot;q&quot; {{'), title)
  const data = pageData('index')
  assert.ok(data.title.startsWith('Title <b>bold</b> & "q" {{'), data.title)
})

test('a page description is escaped in the meta tag and plain text in the page data', () => {
  assert.ok(html.includes('<meta name="description" content="&quot;&gt;&lt;img src=x onerror=alert(1)&gt; R&amp;D">'), html.slice(0, 900))
  assert.doesNotMatch(html.slice(0, html.indexOf('</head>')), /<img/)
  const data = pageData('index')
  assert.equal(data.description, '"><img src=x onerror=alert(1)> R&D')
})

// Frontmatter fields the default theme writes as HTML

const htmlTag = (page) => /<html [^>]*>/.exec(page)?.[0]
// The rendered page without the head and the script tags VitePress adds.
const app = (page) => {
  const from = page.indexOf('id="app"')
  assert.ok(from > 0)
  return page.slice(from, page.indexOf('<script', from))
}

test('a frontmatter dir with a breakout payload is dropped', () => {
  const page = pages['dir-breakout']
  assert.match(htmlTag(page), /^<html lang="[^"]+" dir="ltr">$/)
  assert.ok(!page.includes('onerror=dirbreakout'), htmlTag(page))
  assert.deepEqual(liveTags(page), [])
})

test('a frontmatter dir of rtl is kept', () => {
  assert.match(htmlTag(pages['dir-rtl']), /^<html lang="[^"]+" dir="rtl">$/)
})

test('a dir carrying the description tag cannot steer the description escaping', () => {
  const page = pages['dir-steer']
  const head = page.slice(0, page.indexOf('</head>'))
  assert.match(htmlTag(page), /dir="ltr">$/)
  assert.ok(head.includes('<meta name="description" content="Steer &lt;b&gt;x&lt;/b&gt; &amp; more">'), head)
  assert.ok(!page.includes('content="Steer <b>'), head)
})

test('previous and next link text from frontmatter renders as text, as a string and as an object', () => {
  const two = app(pages['nav/two'])
  const three = app(pages['nav/three'])
  for (const page of [two, three]) assert.deepEqual(liveTags(page), [], page)
  assert.match(two, /<span class="title"[^>]*>&lt;img src=x onerror=prevstring&gt;<\/span>/)
  assert.match(two, /<span class="title"[^>]*>Next &lt;i&gt;nextstring&lt;\/i&gt; &copy; R&amp;D<\/span>/)
  assert.match(three, /<span class="title"[^>]*>&lt;b&gt;prevobject&lt;\/b&gt;<\/span>/)
  assert.match(three, /<span class="title"[^>]*>&lt;svg onload=nextobject&gt;<\/span>/)
  assert.match(three, /href="\/nav\/one(?:\.html)?"/)
})

test('home hero and features from frontmatter render as text', () => {
  const home = app(pages['home-layout'])
  assert.deepEqual(liveTags(home), [], home)
  assert.doesNotMatch(home, /<script/)
  assert.match(home, /<span class="name clip"[^>]*>&lt;img src=x onerror=heroname&gt;<\/span>/)
  assert.match(home, /<span class="text"[^>]*>&lt;b&gt;herotext&lt;\/b&gt; &copy;<\/span>/)
  assert.match(home, /<p class="tagline"[^>]*>&lt;svg onload=herotagline&gt;<\/p>/)
  assert.match(home, /<h2 class="title"[^>]*>&lt;img src=x onerror=featuretitle&gt;<\/h2>/)
  assert.match(home, /<p class="details"[^>]*>&lt;script&gt;featuredetails&lt;\/script&gt;<\/p>/)
  assert.match(home, /<div class="icon"[^>]*>&lt;img src=x onerror=featureicon&gt;<\/div>/)
  assert.match(home, /<p class="details"[^>]*>R&amp;D &lt;i&gt;kept as text&lt;\/i&gt;<\/p>/)
})

test('the page data the client hydrates from holds the same escaped frontmatter', () => {
  const data = pageData('home-layout')
  assert.equal(data.frontmatter.hero.name, '&lt;img src=x onerror=heroname&gt;')
  assert.equal(data.frontmatter.features[0].icon, '&lt;img src=x onerror=featureicon&gt;')
  assert.equal(pageData('dir-breakout').frontmatter.dir, undefined)
  assert.equal(pageData('nav_three').frontmatter.prev.link, '/nav/one')
})
