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
import { fileURLToPath, pathToFileURL } from 'node:url'
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
    [
      'dir-breakout',
      'dir-rtl',
      'dir-steer',
      'nav/two',
      'nav/three',
      'home-layout',
      'features-map',
      'image-attrs',
      'layout-tag',
      'layout-svg',
      'layout-page',
      'layout-false',
      'steer-fields',
      'trusted-raw',
      'link-nav-bad',
      'link-nav-ok',
      'link-hero',
      'link-hero-map',
      'link-features'
    ].map((name) => [
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

// The rendered page between the app container and the script VitePress adds
// after it. It holds the whole theme: navigation, content and the footer of a
// doc page (which sits after </main>, so a slice of <main> would miss it).
const app = (page) => {
  const from = page.indexOf('id="app"')
  const to = page.lastIndexOf('<script>window.__VP_HASH_MAP__')
  assert.ok(from > 0 && to > from, `app region not found: ${from} ${to}`)
  return page.slice(from, to)
}

// Every tag the default theme writes on these pages. A tag outside this set
// is something the page author made, not the theme.
const themeTags = new Set(['div', 'span', 'a', 'header', 'button', 'p', 'nav', 'ul', 'main', 'h1', 'footer', 'article', 'h2', 'img', 'code', 'pre', 'input', 'label', 'li', 'aside', 'section'])
const imgAttributes = new Set(['class', 'src', 'alt', 'width', 'height', 'wrap'])
const TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/"'`]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g
const ATTRIBUTE = /([^\s=>/"'`]+)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g
const tagsOf = (region) => {
  const tags = [...region.matchAll(TAG)].map((m) => ({ name: m[1], attributes: [...m[2].matchAll(ATTRIBUTE)].map((a) => a[1]) }))
  // Every "<" that opens a tag was read as one, so no tag is left unchecked.
  assert.equal(region.match(/<[a-zA-Z]/g).length, tags.length, 'a tag was not parsed')
  return tags
}

// The region holds the expected component, only theme tags, no event handler
// and no attribute on an image beyond the ones the site allows.
const assertNoLiveMarkup = (region, components) => {
  assert.ok(region.length > 500, `region too small: ${region.length}`)
  for (const component of components) assert.match(region, new RegExp(`class="[^"]*\\b${component}\\b`), `${component} not rendered`)
  for (const { name, attributes } of tagsOf(region)) {
    assert.ok(themeTags.has(name), `tag <${name}> is not a theme tag`)
    assert.deepEqual(attributes.filter((a) => /^on/i.test(a)), [], `<${name}> has an event handler`)
    if (name === 'img') {
      const extra = attributes.filter((a) => !imgAttributes.has(a) && !a.startsWith('data-v-'))
      assert.deepEqual(extra, [], `<img> has attribute ${extra}`)
    }
  }
}
// The strings an attack would need are not in the whole page, head included.
const assertNoRaw = (page, raw) => {
  for (const text of raw) assert.ok(!page.includes(text), `${text} is in the page`)
}

test('a frontmatter dir with a breakout payload is dropped', () => {
  const page = pages['dir-breakout']
  assert.match(htmlTag(page), /^<html lang="[^"]+" dir="ltr">$/)
  assertNoRaw(page, ['onerror=dirbreakout'])
  assertNoLiveMarkup(app(page), ['VPDoc'])
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

test('no other frontmatter field can steer the description escaping', () => {
  const page = pages['steer-fields']
  const head = page.slice(0, page.indexOf('</head>'))
  assert.match(htmlTag(page), /dir="ltr">$/)
  assert.equal(head.split('<meta name="description"').length, 2, head)
  assert.ok(head.includes('<meta name="description" content="Steer fields &lt;b&gt;y&lt;/b&gt; &amp; more">'), head)
  assertNoRaw(page, ['content="Steer fields <b>', '<meta name="description" content="Steer fields <b>'])
  assertNoLiveMarkup(app(page), ['VPDoc'])
  assert.equal(pageData('steer-fields').frontmatter.layout, undefined)
})

test('previous and next link text from frontmatter renders as text, as a string and as an object', () => {
  const two = pages['nav/two']
  const three = pages['nav/three']
  for (const page of [two, three]) assertNoLiveMarkup(app(page), ['VPDocFooter', 'pager-link'])
  assertNoRaw(two + three, ['<img src=x onerror=prevstring>', '<i>nextstring</i>', '<b>prevobject</b>', '<svg onload=nextobject>'])
  const twoApp = app(two)
  const threeApp = app(three)
  assert.match(twoApp, /<span class="title"[^>]*>&lt;img src=x onerror=prevstring&gt;<\/span>/)
  assert.match(twoApp, /<span class="title"[^>]*>Next &lt;i&gt;nextstring&lt;\/i&gt; &copy; R&amp;D<\/span>/)
  assert.match(threeApp, /<span class="title"[^>]*>&lt;b&gt;prevobject&lt;\/b&gt;<\/span>/)
  assert.match(threeApp, /<span class="title"[^>]*>&lt;svg onload=nextobject&gt;<\/span>/)
  assert.match(threeApp, /href="\/nav\/one(?:\.html)?"/)
})

test('home hero and features from frontmatter render as text', () => {
  const page = pages['home-layout']
  const home = app(page)
  assertNoLiveMarkup(home, ['VPHero', 'VPFeatures', 'VPFeature'])
  assertNoRaw(page, ['<img src=x onerror=heroname>', '<b>herotext</b>', '<svg onload=herotagline>', 'onerror=featuretitle>', '<iframe src=featuredetails>', 'onerror=featureicon>', '<i>kept as text</i>'])
  assert.match(home, /<span class="name clip"[^>]*>&lt;img src=x onerror=heroname&gt;<\/span>/)
  assert.match(home, /<span class="text"[^>]*>&lt;b&gt;herotext&lt;\/b&gt; &copy;<\/span>/)
  assert.match(home, /<p class="tagline"[^>]*>&lt;svg onload=herotagline&gt;<\/p>/)
  assert.match(home, /<h2 class="title"[^>]*>&lt;img src=x onerror=featuretitle&gt;<\/h2>/)
  assert.match(home, /<p class="details"[^>]*>&lt;iframe src=featuredetails&gt;&lt;\/iframe&gt;<\/p>/)
  assert.match(home, /<div class="icon"[^>]*>&lt;img src=x onerror=featureicon&gt;<\/div>/)
  assert.match(home, /<p class="details"[^>]*>R&amp;D &lt;i&gt;kept as text&lt;\/i&gt;<\/p>/)
})

test('features given as a mapping are dropped, not rendered through the theme', () => {
  const page = pages['features-map']
  const home = app(page)
  assertNoLiveMarkup(home, ['VPHome'])
  assert.doesNotMatch(home, /VPFeatures/)
  assertNoRaw(page, ['mapfirst', 'mapsecond'])
  assert.equal(pageData('features-map').frontmatter.features, undefined)
})

test('image objects keep no attribute beyond the allowed ones, in the hero, as an icon and as a themed icon', () => {
  const page = pages['image-attrs']
  const home = app(page)
  assertNoLiveMarkup(home, ['VPHero', 'VPFeatures', 'VPImage'])
  assertNoRaw(page, ['onerror', 'onload', 'heroimage', 'iconobject', 'iconlight', 'icondark', 'iconwrap'])
  const images = tagsOf(home).filter((t) => t.name === 'img')
  assert.equal(images.length, 5, JSON.stringify(images))
  assert.match(home, /<img class="VPImage image-src" src="\/missing-hero\.png" alt="Hero"/)
  assert.match(home, /<img class="VPImage" src="\/missing-icon\.png" height="48" width="48" alt/)
  assert.match(home, /src="\/missing-light\.png"/)
  assert.match(home, /src="\/missing-dark\.png"/)
  assert.match(home, /<div class="icon"[^>]*><!--\[--><img class="VPImage" src="\/missing-wrap\.png" width="24" wrap="true"/)
  const data = pageData('image-attrs').frontmatter
  assert.deepEqual(data.hero.image, { src: '/missing-hero.png', alt: 'Hero' })
  assert.deepEqual(data.features[0].icon, { src: '/missing-icon.png' })
  assert.deepEqual(data.features[1].icon, { light: { src: '/missing-light.png' }, dark: { src: '/missing-dark.png' } })
  assert.deepEqual(data.features[2].icon, { src: '/missing-wrap.png', wrap: true, width: 24 })
})

test('a layout that is not doc, home or page is dropped, so it cannot become a tag name', () => {
  for (const [name, marker] of [['layout-tag', 'layouttag'], ['layout-svg', 'layoutsvg']]) {
    const page = pages[name]
    assertNoRaw(page, [marker, 'onload=', 'onerror='])
    assertNoLiveMarkup(app(page), ['VPDoc', 'VPDocFooter'])
    assert.equal(pageData(name).frontmatter.layout, undefined)
  }
  assert.match(app(pages['layout-page']), /class="VPPage"/)
  assert.equal(pageData('layout-page').frontmatter.layout, 'page')
})

test('a layout of false is kept, so the page is written without the theme layout', () => {
  const page = app(pages['layout-false'])
  assert.doesNotMatch(page, /class="Layout"/)
  assert.match(page, /<h1 id="layout-false"[^>]*>Layout false/)
  assert.equal(pageData('layout-false').frontmatter.layout, false)
})

test('head entries stay as typed, the one raw path the docs name', () => {
  const page = pages['trusted-raw']
  const head = page.slice(0, page.indexOf('</head>'))
  assert.ok(head.includes('<meta name="trusted-head" content="kept">'), head)
  assert.ok(head.includes('<script>window.trustedhead=1;</script>'), head)
  assertNoLiveMarkup(app(page), ['VPHero'])
})

// Every href in a rendered page, as the browser would read it.
const section = (region, className) => {
  const from = region.indexOf(`class="${className}`)
  assert.ok(from > 0, `${className} not found`)
  return region.slice(from)
}
const hrefsOf = (region) => [...region.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1])
const targetsOf = (region) => [...region.matchAll(/\starget="([^"]*)"/g)].map((m) => m[1])
const relsOf = (region) => [...region.matchAll(/\srel="([^"]*)"/g)].map((m) => m[1])
// What is left of a link that carried a script scheme: nothing reads as one.
const assertNoScriptHref = (page, markers) => {
  assertNoRaw(page, markers)
  for (const href of hrefsOf(app(page))) {
    const url = new URL(href.replaceAll('&amp;', '&'), 'https://site.invalid/base/page')
    assert.ok(['https:', 'http:', 'mailto:'].includes(url.protocol), `${href} resolves to ${url.protocol}`)
  }
}

test('a previous or next link with a script scheme is dropped, the text stays', () => {
  const page = pages['link-nav-bad']
  assertNoScriptHref(page, ['prevlink', 'nextlink', 'javascript:', 'JaVaScRiPt'])
  assertNoLiveMarkup(app(page), ['VPDocFooter'])
  const data = pageData('link-nav-bad').frontmatter
  assert.deepEqual(data.prev, { text: 'Previous' })
  assert.deepEqual(data.next, { text: 'Next' })
})

test('previous and next links that are relative or http(s) are kept', () => {
  const page = pages['link-nav-ok']
  const footer = app(page)
  assertNoLiveMarkup(footer, ['VPDocFooter'])
  assert.match(footer, /href="\/nav\/one(?:\.html)?"/)
  assert.match(footer, /href="https:\/\/example\.com\/next\?a=1&amp;b=2"/)
  assert.deepEqual(pageData('link-nav-ok').frontmatter.next, { text: 'Next', link: 'https://example.com/next?a=1&b=2' })
})

test('a hero action link with a script scheme is dropped, a safe action keeps link, target and rel; an odd target and rel are dropped', () => {
  const page = pages['link-hero']
  assertNoScriptHref(page, ['heroaction', 'heroodd', 'herotab', 'javascript:', 'data:text'])
  const home = app(page)
  assertNoLiveMarkup(home, ['VPHero'])
  assert.match(home, /<a class="VPButton medium alt" href="\/nav\/one(?:\.html)?" target="_blank" rel="noopener nofollow"/)
  const actionsHtml = home.slice(home.indexOf('class="actions"'), home.indexOf('class="image"') > 0 ? home.indexOf('class="image"') : undefined)
  assert.equal(actionsHtml.match(/<(?:a|button)\s/g).length, 4)
  assert.deepEqual(targetsOf(actionsHtml), ['_self', '_blank'])
  assert.deepEqual(relsOf(actionsHtml), ['noopener nofollow'])
  assert.equal(hrefsOf(actionsHtml).length, 1)
  const actions = pageData('link-hero').frontmatter.hero.actions
  assert.deepEqual(actions[0], { theme: 'brand', text: 'Script', target: '_self' })
  assert.deepEqual(actions[1], { theme: 'alt', text: 'Kept', link: '/nav/one', target: '_blank', rel: 'noopener nofollow' })
  assert.deepEqual(actions[2], { theme: 'alt', text: 'Odd target' })
  assert.deepEqual(actions[3], { theme: 'alt', text: 'Bypass' })
})

test('hero actions given as a mapping are dropped, not rendered through the theme', () => {
  const page = pages['link-hero-map']
  assertNoRaw(page, ['actionmapfirst', 'javascript:'])
  assert.doesNotMatch(app(page), /class="actions"/)
  assert.equal(pageData('link-hero-map').frontmatter.hero.actions, undefined)
})

test('a feature link with a script scheme, in every spelling a browser might read, is dropped', () => {
  const page = pages['link-features']
  assertNoScriptHref(page, ['featurelink', 'featurevb', 'featuredata', 'featureblob', 'featureupper', 'featurenl', 'featuretab', 'featurespace', 'featurelist', 'featureobject', 'featureschemerel', 'featurebackslash', 'evil.example', 'vbscript', 'javascript:', 'JaVaScRiPt'])
  const home = app(page)
  assertNoLiveMarkup(home, ['VPFeatures', 'VPFeature'])
  const cards = section(home, 'VPFeatures')
  // The percent escape and the entity start no scheme: they are relative paths on this site, written escaped.
  assert.deepEqual(hrefsOf(cards), [
    'https://example.com/kept',
    '/nav/one.html',
    '/javascript&amp;colon;featureentity.html',
    '/%6Aavascript:featurepercent.html'
  ])
  assert.deepEqual(targetsOf(cards), ['_self', '_blank'])
  assert.deepEqual(relsOf(cards), ['noreferrer'])
  const features = pageData('link-features').frontmatter.features
  assert.equal(features.length, 17)
  assert.deepEqual(features[0], { title: 'Script', target: '_self' })
  assert.deepEqual(features[1], { title: 'Kept', link: 'https://example.com/kept', target: '_blank', rel: 'noreferrer' })
  assert.deepEqual(features[2], { title: 'Odd rel', link: '/nav/one' })
  for (const i of [3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16]) assert.equal('link' in features[i], false, JSON.stringify(features[i]))
})

test('the page data the client hydrates from holds the same escaped frontmatter', () => {
  const data = pageData('home-layout')
  assert.equal(data.frontmatter.hero.name, '&lt;img src=x onerror=heroname&gt;')
  assert.equal(data.frontmatter.features[0].icon, '&lt;img src=x onerror=featureicon&gt;')
  assert.equal(pageData('dir-breakout').frontmatter.dir, undefined)
  assert.equal(pageData('nav_three').frontmatter.prev.link, '/nav/one')
})

// A page whose frontmatter opens with a JavaScript block must fail the build
// without running the block; a YAML page in the same kind of site builds. The
// site is written next to the fixture, so that it resolves the same packages.
test('a build refuses JavaScript frontmatter and does not run it, a YAML page builds', async () => {
  const marker = 'agentDxBuildEvaluated'
  delete globalThis[marker]
  const cases = [
    ['js', 'js', false],
    ['javascript', 'javascript', false],
    ['yaml', '', true]
  ]
  for (const [label, lang, ok] of cases) {
    const dir = path.join(root, '..', `js-frontmatter-${label}-${process.pid}`)
    const outDir = path.join(work, `out-${label}`)
    fs.mkdirSync(path.join(dir, '.vitepress'), { recursive: true })
    try {
      fs.writeFileSync(
        path.join(dir, '.vitepress', 'config.mjs'),
        [
          "import { markdownBase } from '../../../../.vitepress/site-helpers.mjs'",
          `export default { title: 'js frontmatter', markdown: markdownBase, lastUpdated: false, cacheDir: ${JSON.stringify(path.join(work, `cache-${label}`))} }`,
          ''
        ].join('\n')
      )
      const block = ok ? 'title: Plain\n' : `{ title: (globalThis.${marker} = '${label}', 'Evaluated') }\n`
      fs.writeFileSync(path.join(dir, 'index.md'), `---${lang}\n${block}---\n\n# Page\n`)
      if (ok) {
        await build(dir, { outDir })
        assert.match(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), /<title>Plain \| js frontmatter<\/title>/)
      } else {
        await assert.rejects(build(dir, { outDir }), /JavaScript frontmatter is not supported/, label)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  assert.equal(globalThis[marker], undefined)
})

// A page that includes a Markdown file whose frontmatter is a JavaScript block
// must fail the build with the page path, and the block must not run. The site
// is a repository-shaped tree built with the real helpers: createSite scans the
// pages, as the real config does. The control tree has no directive and builds.
test('a build refuses an include directive and does not run the included frontmatter', async () => {
  const marker = 'agentDxIncludeEvaluated'
  delete globalThis[marker]
  const helpers = pathToFileURL(path.join(root, '..', '..', '..', '.vitepress', 'site-helpers.mjs')).href
  for (const [label, include] of [['refused', true], ['control', false]]) {
    // Written next to the fixtures, so that the pages resolve the same packages.
    const repo = fs.mkdtempSync(path.join(root, '..', `include-${label}-`))
    const outDir = path.join(work, `out-include-${label}`)
    const pageDir = path.join(repo, 'packages', 'agent-engineering-playbook')
    fs.mkdirSync(path.join(repo, 'site', '.vitepress'), { recursive: true })
    fs.mkdirSync(pageDir, { recursive: true })
    fs.writeFileSync(path.join(repo, 'site', 'index.md'), '# Home\n')
    fs.writeFileSync(path.join(pageDir, 'README.md'), '# Playbook\n')
    fs.writeFileSync(path.join(pageDir, 'payload.md'), `---js\n{ title: (globalThis.${marker} = '${label}', 'Evaluated') }\n---\n\nIncluded body\n`)
    fs.writeFileSync(path.join(pageDir, 'page.md'), `# Page\n\n${include ? '<!--@include: ./payload.md-->' : 'No directive.'}\n`)
    fs.writeFileSync(
      path.join(repo, 'site', '.vitepress', 'config.mjs'),
      [
        `import { createSite, markdownBase } from ${JSON.stringify(helpers)}`,
        "const { rewrites } = createSite(new URL('../..', import.meta.url).pathname, () => '')",
        `export default { title: 'include', srcDir: '..', rewrites, srcExclude: ['**/payload.md'], markdown: markdownBase, lastUpdated: false, cacheDir: ${JSON.stringify(path.join(work, `cache-include-${label}`))} }`,
        ''
      ].join('\n')
    )
    try {
      if (include) {
        await assert.rejects(build(path.join(repo, 'site'), { outDir }), /Include directives are not supported: packages\/agent-engineering-playbook\/page\.md/, label)
      } else {
        await build(path.join(repo, 'site'), { outDir })
        assert.ok(fs.existsSync(path.join(outDir, 'agent-engineering-playbook', 'page.html')))
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  }
  assert.equal(globalThis[marker], undefined)
})
