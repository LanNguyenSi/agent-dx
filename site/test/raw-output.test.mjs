// Renders hostile Markdown through the site's real markdown configuration and
// checks that author text never reaches the page as live HTML or as a Vue
// expression: fence info strings, markdown-it-attrs, explicit ids, code-group
// and alert titles, mustache, and the page description.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkdownRenderer, resolveConfig } from 'vitepress'
import { allowedAttributes, allowedDirs, allowedLayouts, allowedRelTokens, allowedTargets, defuseMustache, escapeDescriptionMeta, escapeText, isSafeLink, safeId, safeImage, sanitizeFrontmatter, transformPageData } from '../.vitepress/raw-output.mjs'
import { escapeText as siteEscapeText, markdownBase } from '../.vitepress/site-helpers.mjs'
import { keptRelative, themeOffsite } from './link-cases.mjs'

let md
let cfg
before(async () => {
  cfg = await resolveConfig('.')
  md = await createMarkdownRenderer(cfg.srcDir, cfg.userConfig.markdown, cfg.site.base)
})
const render = (src, env = {}) => md.render(src, { relativePath: 'fixture.md', ...env })

// Fenced code is v-pre, so a mustache inside it is text. Everything else is
// compiled by Vue and must hold no "{{".
const outsideVPre = (html) => html.replace(/<pre[^>]*\bv-pre\b[^>]*>[\s\S]*?<\/pre>/g, '')

// A tag opened by author text: an element name that none of the renderer's own
// markup uses.
const liveTags = (html) => [...html.replace(/="[^"]*"/g, '=""').matchAll(/<(?:img|script|svg|iframe|b|i)[\s/>]|<[a-z][^>]*\son\w+=/g)].map((m) => m[0])

test('the escape helpers agree with the sidebar title escaping', () => {
  for (const s of ['a & b', '<b>x</b>', 'say "hi"', '&amp; stays', 'R&D; kept?']) {
    assert.equal(escapeText(s), siteEscapeText(s))
  }
})

// Fence info strings

test('a fence info string with a tag renders escaped', () => {
  const out = render('```<img/src=x/onerror=alert(1)>\nbody\n```\n')
  assert.deepEqual(liveTags(out), [])
  assert.ok(!out.includes('<img'), out)
  assert.match(out, /<span class="lang">&lt;img/)
  assert.match(out, /class="language-&lt;img/)
})

test('a fence info string cannot close the class attribute', () => {
  const out = render('```a"onmouseover="alert(1)\nbody\n```\n')
  assert.ok(!out.includes('"onmouseover'), out)
  assert.ok(!/<div class="language-a"/.test(out), out)
  assert.match(out, /class="language-a&quot;onmouseover/)
})

test('a tag in the language next to a code-group title renders escaped', () => {
  const group = (info) => render(`::: code-group\n\n\`\`\`${info}\nx\n\`\`\`\n\n:::\n`)
  for (const info of ['<img/src=x/onerror=1> [title]', '[title]<img/src=x/onerror=2>']) {
    const out = group(info)
    assert.deepEqual(liveTags(out), [], out)
    assert.ok(!out.includes('<img'), out)
    assert.match(out, /<span class="lang">&lt;img\//, out)
  }
})

test('an ordinary fence keeps its language label, class and highlighted lines', () => {
  const out = render('```js{2}\nx\ny\nz\n```\n')
  assert.match(out, /<div class="language-js vp-adaptive-theme">/)
  assert.match(out, /<span class="lang">js<\/span>/)
  assert.equal(out.match(/class="line highlighted"/g)?.length, 1, out)
  assert.equal(render('```js {1,3}\nx\ny\nz\n```\n').match(/class="line highlighted"/g)?.length, 2)
  assert.equal(render('```js{1-3}\nx\ny\nz\n```\n').match(/class="line highlighted"/g)?.length, 3)
  assert.equal(render('```js {2-3}\nx\ny\nz\n```\n').match(/class="line highlighted"/g)?.length, 2)
})

test('a line separator in a fence info string cannot hide a tag or a mustache', () => {
  for (const sep of ['\u2028', '\u2029']) {
    for (const fence of ['```', '~~~']) {
      const out = render(`${fence}<img/src=x/onerror=1>${sep}{{ 7*7 }}\nbody\n${fence}\n`)
      assert.deepEqual(liveTags(out), [], JSON.stringify(out))
      assert.ok(!out.includes('<img'), JSON.stringify(out))
      assert.match(out, /<span class="lang">&lt;img\/src/)
      assert.ok(!out.includes('{{'), JSON.stringify(out))
    }
  }
})

test('a line separator after a code-group title cannot hide a tag or a mustache', () => {
  for (const sep of ['\u2028', '\u2029']) {
    const out = render(`::: code-group\n\n\`\`\`js [{{ 7*7 }}]${sep}]\nx\n\`\`\`\n\n\`\`\`js [<img src=x onerror=1>]${sep}]\ny\n\`\`\`\n\n:::\n`)
    assert.deepEqual(liveTags(out), [], JSON.stringify(out))
    assert.ok(!out.includes('{{'), JSON.stringify(out))
    assert.match(out, /<label data-title="&#123;&#123; 7\*7 \}\}" for="[^"]+">&#123;&#123; 7\*7 \}\}<\/label>/)
    assert.match(out, /<label data-title="&lt;img src=x onerror=1&gt;" for="[^"]+">&lt;img src=x onerror=1&gt;<\/label>/)
  }
})

// markdown-it-attrs

test('event handler attributes from a curly block are dropped', () => {
  for (const src of [
    'para {onclick=alert(1)}\n',
    '[l](/x){onmouseover=y}\n',
    '*em*{onfocus=y}\n',
    '# Head {onload=y}\n',
    '```js {onclick=y}\nx\n```\n',
    '| a |\n|---|\n| b |\n\n{onclick=y}\n'
  ]) {
    assert.deepEqual(liveTags(render(src)), [], src)
    assert.doesNotMatch(render(src).replace(/="[^"]*"/g, '=""'), /\bon[a-z]+=/i, src)
  }
})

test('other attributes outside the allowlist are dropped too', () => {
  const out = render('para {style="background:red" href=javascript:x data-x=1 css-module=m}\n')
  assert.doesNotMatch(out, /style=|href=|data-x|css-module/)
})

test('id and class from a curly block are kept', () => {
  assert.match(render('para {.one .two-b #mine_1}\n'), /<p class="one two-b" id="mine_1">para<\/p>/)
  assert.match(render('para {.keep #mine}\n'), /<p class="keep" id="mine">para<\/p>/)
  assert.match(render('# Head {#custom}\n'), /<h1 id="custom"/)
})

test('an explicit id with a character outside letters, digits, underscore and hyphen is dropped', () => {
  for (const id of ['b"onmouseover="alert(1)', "q'x", 'x><img/src=x/onerror=1>', 'ü', 'a.b', 'a:b', 'a&b']) {
    const out = render(`[[toc]]\n\n## Head {#${id}}\n`)
    assert.deepEqual(liveTags(out), [], out)
    const nav = /<nav class="table-of-contents">.*?<\/nav>/.exec(out)?.[0]
    assert.match(nav, /<li><a href="#head">Head<\/a><\/li>/, out)
    assert.match(out, /<h2 id="head"/, out)
  }
  assert.ok(safeId.test('kept-id_1') && !safeId.test('') && !safeId.test('a b') && !safeId.test('a\n'))
})

test('an explicit id made of letters, digits, underscore and hyphen is kept in the heading and the contents list', () => {
  const out = render('[[toc]]\n\n## Head {#My-id_2}\n')
  assert.match(out, /<h2 id="My-id_2"/)
  assert.match(out, /<a href="#My-id_2">Head<\/a>/)
})

test('an id on a nested token is checked too', () => {
  const out = render('para *em*{#a"b} and\n\n- item {#c"d}\n')
  assert.doesNotMatch(out, /id="[^"]*"[^>]*"/)
  assert.doesNotMatch(out, /id=/)
})

test('the contents list holds no live mustache and no tag from heading text', () => {
  const out = render("[[toc]]\n\n## A {{ constructor.constructor('x')() }} <img src=x onerror=1>\n")
  assert.ok(!out.includes('{{'), out)
  assert.deepEqual(liveTags(out), [], out)
})

test('the site passes the allowlist to markdown-it-attrs', () => {
  assert.deepEqual(markdownBase.attrs.allowedAttributes, allowedAttributes)
  assert.deepEqual(allowedAttributes.slice(0, 2), ['id', 'class'])
})

// Code-group and alert titles

test('a code-group tab title with a tag renders escaped', () => {
  const out = render('::: code-group\n\n```js [<img src=x onerror=tab>]\nx\n```\n\n:::\n')
  assert.deepEqual(liveTags(out), [])
  assert.match(out, /<label data-title="&lt;img src=x onerror=tab&gt;" for="[^"]+">&lt;img src=x onerror=tab&gt;<\/label>/)
})

test('an ordinary code-group title keeps its text and a single-escaped data-title', () => {
  const out = render("::: code-group\n\n```js [Bob's & co]\nx\n```\n\n```sh [b &copy;]\ny\n```\n\n:::\n")
  assert.match(out, /<label data-title="Bob's &amp; co" for="[^"]+">Bob's &amp; co<\/label>/)
  assert.match(out, /<label data-title="b &copy;" for="[^"]+">b &copy;<\/label>/)
})

test('a github alert title with a tag renders escaped', () => {
  const out = render('> [!NOTE] <img src=x onerror=alert>\n> body\n')
  assert.deepEqual(liveTags(out), [])
  assert.match(out, /<p class="custom-block-title">&lt;img src=x onerror=alert&gt;<\/p>/)
})

test('an alert keeps its default label without a title, and its tokens are left as parsed', () => {
  const src = '> [!WARNING]\n> body\n\n> [!TIP] a & <b>\n> body\n'
  const out = render(src)
  assert.match(out, /<p class="custom-block-title">WARNING<\/p>/)
  assert.match(out, /<p class="custom-block-title">a &amp; &lt;b&gt;<\/p>/)
  const tokens = md.parse(src, {})
  const alerts = tokens.filter((t) => t.type === 'github_alert_open')
  md.renderer.render(tokens, md.options, { relativePath: 'fixture.md' })
  assert.deepEqual(alerts.map((t) => t.meta.title), ['WARNING', 'a & <b>'])
})

// Mustache

const MUSTACHE = "{{ constructor.constructor('x')() }}"

test('a mustache in prose is not left for Vue to compile', () => {
  const out = render(`text ${MUSTACHE} end\n`)
  assert.ok(!outsideVPre(out).includes('{{'), out)
  assert.ok(out.includes('&#123;&#123; constructor.constructor('), out)
})

test('a mustache is defused in every place Vue compiles text', () => {
  const sources = {
    'inline code': `\`${MUSTACHE}\`\n`,
    heading: `# ${MUSTACHE}\n`,
    'table cell': `| a |\n|---|\n| ${MUSTACHE} |\n`,
    'link text': `[${MUSTACHE}](/x)\n`,
    emphasis: `*${MUSTACHE}*\n`,
    'list item': `- ${MUSTACHE}\n`,
    'quote': `> ${MUSTACHE}\n`,
    'container title': `::: tip ${MUSTACHE}\nbody\n:::\n`,
    'alert title': `> [!NOTE] ${MUSTACHE}\n> body\n`,
    'code-group title': `::: code-group\n\n\`\`\`js [${MUSTACHE}]\nx\n\`\`\`\n\n:::\n`,
    'indented code': `para\n\n    ${MUSTACHE}\n`,
    'escaped brace': `\\{{ constructor.constructor('x')() }}\n`
  }
  for (const [name, src] of Object.entries(sources)) {
    assert.ok(!outsideVPre(render(src)).includes('{{'), `${name}: ${render(src)}`)
  }
})

test('a mustache in a fenced block is written as references inside v-pre, which read as the same text', () => {
  const out = render('```js\nconst a = {{ b }}\n```\n')
  assert.match(out, /<pre[^>]*\bv-pre\b/)
  assert.ok(!out.includes('{{'), out)
  assert.ok(out.replace(/<[^>]+>/g, '').replaceAll('&#123;', '{').includes('const a = {{ b }}'), out)
})

test('single braces and a mustache written as references are untouched', () => {
  const out = render('use {a} and &#123;&#123; b }} and {x} tail\n')
  assert.ok(out.includes('{a} and &#123;&#123; b }} and {x} tail'), out)
})

test('defuseMustache turns only a double open brace into references', () => {
  assert.equal(defuseMustache('{{ a }} {b} {{{c'), '&#123;&#123; a }} {b} &#123;&#123;{c')
})

// Page title and description

test('the page title is left as typed in the page data, since VitePress escapes it where it writes the title', () => {
  const env = { relativePath: 'fixture.md' }
  md.render('# <b>hi</b> & "q" `<i>`\n', env)
  assert.equal(env.title, '<b>hi</b> & "q" <i>')
})

const meta = (description) => `<head><meta name="description" content="${description}"></head>`

test('the site config escapes the description of every page it writes', () => {
  const description = '"><img src=x onerror=alert(1)>'
  assert.equal(cfg.userConfig.transformHtml(meta(description), 'index.html', { description }), meta('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'))
})

test('a hostile description is escaped in the meta tag', () => {
  const description = '"><img src=x onerror=alert(1)> R&D'
  const out = escapeDescriptionMeta(meta(description), 'index.html', { description })
  assert.equal(out, meta('&quot;&gt;&lt;img src=x onerror=alert(1)&gt; R&amp;D'))
})

test('a page without a description is left as it is', () => {
  assert.equal(escapeDescriptionMeta('<head></head>', 'index.html', {}), '<head></head>')
})

test('an ordinary description is left as it is', () => {
  for (const description of ['Agent Engineering Playbook and Agentic Coding Playbook from agent-dx', "It's fine: a, b; c (d) 1/2 &copy; x", '']) {
    assert.equal(escapeDescriptionMeta(meta(description), 'index.html', { description }), meta(description))
  }
})

test('a description that YAML reads as a number, a boolean or a list is escaped in its string form', () => {
  for (const description of [123, true, ['a', '<b>']]) {
    const text = String(description)
    assert.equal(escapeDescriptionMeta(meta(text), 'index.html', { description }), meta(escapeText(text)))
  }
})

test('a description with replacement patterns is written as is', () => {
  const description = '$& $1 $$ <'
  assert.equal(escapeDescriptionMeta(meta(description), 'index.html', { description }), meta('$&amp; $1 $$ &lt;'))
})

test('a copy of the description tag written earlier does not use up the replacement', () => {
  const description = 'a <b>'
  const tag = `<meta name="description" content="${description}">`
  const html = `<html dir="x">${tag}<head><title>t</title>${tag}</head>`
  const out = escapeDescriptionMeta(html, 'index.html', { description })
  assert.equal(out.split(tag).length, 1, out)
  assert.equal(out.split('<meta name="description" content="a &lt;b&gt;">').length, 3, out)
})

// Frontmatter the default theme writes as HTML

test('the site config passes the frontmatter sanitiser to VitePress', () => {
  const out = cfg.userConfig.transformPageData({ frontmatter: { dir: 'x', hero: { name: '<b>' } } })
  assert.deepEqual(out, { frontmatter: { hero: { name: '&lt;b&gt;' } } })
})

test('dir is limited to ltr, rtl and auto', () => {
  assert.deepEqual([...allowedDirs].sort(), ['auto', 'ltr', 'rtl'])
  for (const dir of ['ltr', 'rtl', 'auto']) assert.equal(sanitizeFrontmatter({ dir }).dir, dir)
  for (const dir of ['RTL', ' rtl', 'rtl ', '"><img src=x onerror=1>', '', 0, null, true, ['rtl'], { toString: () => 'rtl' }]) {
    assert.equal('dir' in sanitizeFrontmatter({ dir }), false, JSON.stringify(dir))
  }
})

test('previous and next text is escaped in every form, the link is kept', () => {
  const out = sanitizeFrontmatter({
    prev: '<img src=x onerror=1> & "q"',
    next: { text: '<b>x</b>', link: '/a?b=<c>' }
  })
  assert.equal(out.prev, '&lt;img src=x onerror=1&gt; &amp; &quot;q&quot;')
  assert.deepEqual(out.next, { text: '&lt;b&gt;x&lt;/b&gt;', link: '/a?b=<c>' })
  assert.deepEqual(sanitizeFrontmatter({ prev: { link: '/a' } }).prev, { link: '/a' })
  assert.equal(sanitizeFrontmatter({ next: ['<b>'] }).next, '&lt;b&gt;')
  assert.equal(sanitizeFrontmatter({ prev: { text: ['<b>x</b>'] } }).prev.text, '&lt;b&gt;x&lt;/b&gt;')
})

test('hero and feature text is escaped, an entity written in the source stays one', () => {
  const out = sanitizeFrontmatter({
    hero: { name: '<b>n</b>', text: 'R&D &copy;', tagline: '<i>t</i>', actions: [{ text: '<b>a</b>', link: '/x' }] },
    features: [{ title: '<b>t</b>', details: '<i>d</i>', icon: '<u>i</u>', link: '/y' }]
  })
  assert.deepEqual(out.hero, { name: '&lt;b&gt;n&lt;/b&gt;', text: 'R&amp;D &copy;', tagline: '&lt;i&gt;t&lt;/i&gt;', actions: [{ text: '<b>a</b>', link: '/x' }] })
  assert.deepEqual(out.features, [{ title: '&lt;b&gt;t&lt;/b&gt;', details: '&lt;i&gt;d&lt;/i&gt;', icon: '&lt;u&gt;i&lt;/u&gt;', link: '/y' }])
})

test('values that cannot hold markup are kept as they are', () => {
  const icon = { src: '/i.svg', alt: 'a' }
  const input = {
    layout: 'home',
    head: [['script', {}, 'raw()']],
    prev: false,
    next: 5,
    hero: { name: 7, text: false, tagline: null, extra: undefined },
    features: [{ title: 1, details: true, icon }, { title: 'no icon', details: undefined }, 'plain', null]
  }
  const out = sanitizeFrontmatter(input)
  assert.deepEqual(out, input)
  assert.deepEqual(out.features[0].icon, icon)
  assert.equal(out.head, input.head, 'head stays the documented raw path')
  assert.deepEqual(sanitizeFrontmatter({}), {})
  assert.deepEqual(sanitizeFrontmatter({ hero: 'text' }), { hero: 'text' })
})

test('layout is limited to doc, home and page, and false', () => {
  assert.deepEqual([...allowedLayouts].sort(), ['doc', 'home', 'page'])
  for (const layout of ['doc', 'home', 'page', false]) assert.equal(sanitizeFrontmatter({ layout }).layout, layout)
  for (const layout of ['svg onload=1//', 'img src=x onerror=1//', 'Content', 'VPHero', 'Home', ' home', '', 0, null, true, ['home'], { toString: () => 'home' }]) {
    assert.equal('layout' in sanitizeFrontmatter({ layout }), false, JSON.stringify(layout))
  }
  assert.deepEqual(sanitizeFrontmatter({}), {})
})

test('features are kept as an array and dropped in any other shape', () => {
  const item = { title: '<b>t</b>', details: '<i>d</i>', icon: '<u>i</u>' }
  const escaped = { title: '&lt;b&gt;t&lt;/b&gt;', details: '&lt;i&gt;d&lt;/i&gt;', icon: '&lt;u&gt;i&lt;/u&gt;' }
  assert.deepEqual(sanitizeFrontmatter({ features: [item] }).features, [escaped])
  for (const features of [{ first: item }, { 0: item }, 'text', 5, true, null]) {
    assert.equal('features' in sanitizeFrontmatter({ features }), false, JSON.stringify(features))
  }
})

test('an image object keeps only the allowed keys with plain values', () => {
  const image = safeImage({ src: '/a.png', alt: 'A', width: 10, height: '20', wrap: true, onerror: 'x()', style: 'x', class: 'c', is: 'script' })
  assert.deepEqual(image, { src: '/a.png', alt: 'A', width: 10, height: '20', wrap: true })
  assert.equal(safeImage({ wrap: 'yes' }).wrap, 'yes')
  assert.equal(safeImage({ wrap: 1 }).wrap, 1)
  assert.equal('wrap' in safeImage({ wrap: {} }), false)
  assert.deepEqual(safeImage({ src: { toString: () => 'x' }, alt: ['a'], width: null, height: true, wrap: {} }), {})
  assert.equal(safeImage('/a.png?x=1&y=2'), '/a.png?x=1&y=2', 'a source is an attribute value, it is not escaped twice')
  for (const bad of [undefined, null, 5, true, ['/a.png'], () => 1]) assert.equal(safeImage(bad), undefined, String(bad))
})

test('a themed image keeps light and dark with the same rule, and nothing else', () => {
  const themed = safeImage({ alt: 'A', light: { src: '/l.png', onerror: 'x()' }, dark: '/d.png', onload: 'x()', extra: { src: '/e.png' } })
  assert.deepEqual(themed, { alt: 'A', light: { src: '/l.png' }, dark: '/d.png' })
  const nested = safeImage({ light: { light: { src: '/n.png', onerror: 'x()' }, dark: 5 }, dark: [] })
  assert.deepEqual(nested, { light: { light: { src: '/n.png' } } })
  // The theme spreads an object with a src onto the image; light and dark would become attributes.
  assert.deepEqual(safeImage({ src: '/a.png', light: '/l.png', dark: { src: '/d.png' } }), { src: '/a.png' })
})

test('an icon that is neither text nor an image object is dropped, the other keys stay', () => {
  for (const icon of [null, 5, 0, true, false, ['a'], [], () => 1, Symbol('s')]) {
    const out = sanitizeFrontmatter({ features: [{ title: 'T', details: 'D', icon, link: '/y' }] })
    assert.deepEqual(out.features, [{ title: 'T', details: 'D', link: '/y' }], String(icon))
    assert.equal('icon' in out.features[0], false)
  }
  // Text, a date and an image object are still icons.
  assert.equal(sanitizeFrontmatter({ features: [{ icon: '<u>' }] }).features[0].icon, '&lt;u&gt;')
  assert.deepEqual(sanitizeFrontmatter({ features: [{ icon: { src: '/i.png' } }] }).features[0].icon, { src: '/i.png' })
})

test('hero.image and an icon object are limited, other hero and feature keys stay', () => {
  const out = sanitizeFrontmatter({
    hero: { name: 'N', image: { src: '/h.png', onerror: 'x()' }, actions: [{ text: 'a', link: '/x', target: '_self' }] },
    features: [
      { title: 'T', icon: { src: '/i.png', onerror: 'x()' }, link: '/y', linkText: 'more' },
      { title: 'U', icon: { light: { src: '/l.png', onload: 'x()' }, dark: '/d.png', alt: 'u' } },
      { title: 'V', icon: { onerror: 'x()' } },
      { title: 'W', icon: ['<b>'] }
    ]
  })
  assert.deepEqual(out.hero, { name: 'N', image: { src: '/h.png' }, actions: [{ text: 'a', link: '/x', target: '_self' }] })
  assert.deepEqual(out.features[0], { title: 'T', icon: { src: '/i.png' }, link: '/y', linkText: 'more' })
  assert.deepEqual(out.features[1], { title: 'U', icon: { alt: 'u', light: { src: '/l.png' }, dark: '/d.png' } })
  assert.deepEqual(out.features[2], { title: 'V', icon: {} })
  assert.deepEqual(out.features[3], { title: 'W' })
  assert.deepEqual(sanitizeFrontmatter({ hero: { image: 5 } }).hero, {})
  assert.deepEqual(sanitizeFrontmatter({ hero: { image: '/h.png?a=1&b=2' } }).hero, { image: '/h.png?a=1&b=2' })
})

test('sanitising leaves its input alone and transformPageData returns only the frontmatter', () => {
  const frontmatter = { dir: 'x', prev: '<b>', hero: { name: '<b>' } }
  const out = transformPageData({ title: 'T', frontmatter })
  assert.deepEqual(Object.keys(out), ['frontmatter'])
  assert.deepEqual(frontmatter, { dir: 'x', prev: '<b>', hero: { name: '<b>' } })
  assert.equal(out.frontmatter.hero.name, '&lt;b&gt;')
})

test('a date written in YAML is an ISO string in text fields and is not a record', () => {
  const day = new Date('2024-05-01')
  const out = sanitizeFrontmatter({
    hero: { name: day, text: new Date('2024-05-01T10:20:30Z') },
    prev: day,
    next: { text: day, link: '/n' },
    features: [{ title: day, details: day, icon: day }]
  })
  assert.equal(out.hero.name, '2024-05-01T00:00:00.000Z')
  assert.equal(out.hero.text, '2024-05-01T10:20:30.000Z')
  assert.equal(out.prev, '2024-05-01T00:00:00.000Z')
  assert.deepEqual(out.next, { text: '2024-05-01T00:00:00.000Z', link: '/n' })
  assert.deepEqual(out.features, [{ title: '2024-05-01T00:00:00.000Z', details: '2024-05-01T00:00:00.000Z', icon: '2024-05-01T00:00:00.000Z' }])
  assert.equal(sanitizeFrontmatter({ prev: new Date(NaN) }).prev, 'Invalid Date')
  // The text does not depend on the time zone of the machine that builds.
  const saved = process.env.TZ
  try {
    for (const tz of ['Pacific/Auckland', 'America/Los_Angeles']) {
      process.env.TZ = tz
      assert.equal(sanitizeFrontmatter({ prev: day }).prev, '2024-05-01T00:00:00.000Z', tz)
    }
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
})

// Frontmatter engines

test('the site config hands the frontmatter engine options of markdownBase to VitePress', () => {
  assert.deepEqual(Object.keys(markdownBase.frontmatter.grayMatterOptions.engines), ['javascript'])
  // The config is loaded as its own module copy, so compare what the engines do.
  assert.throws(() => cfg.userConfig.markdown.frontmatter.grayMatterOptions.engines.javascript.parse('{}'), /not supported/)
})

test('frontmatter that opens with a JavaScript block is refused and never evaluated', () => {
  delete globalThis.agentDxEvaluated
  for (const name of ['js', 'javascript', 'JS', 'JavaScript']) {
    const src = `---${name}\n{ title: (globalThis.agentDxEvaluated = '${name}') }\n---\n# T\n`
    assert.throws(() => render(src), /JavaScript frontmatter is not supported/, name)
  }
  assert.equal(globalThis.agentDxEvaluated, undefined)
})

test('the other engine names gray-matter knows run no code either', () => {
  delete globalThis.agentDxEvaluated
  for (const name of ['coffee', 'coffeescript', 'cson']) {
    assert.throws(() => render(`---${name}\n{ title: 1 }\n---\n# T\n`), /not registered/, name)
  }
  assert.equal(globalThis.agentDxEvaluated, undefined)
})

test('YAML and JSON frontmatter are read as before', () => {
  for (const [open, body] of [['---', 'title: Home\ndir: rtl'], ['---yaml', 'title: Home\ndir: rtl'], ['---yml', 'title: Home\ndir: rtl'], ['---json', '{"title":"Home","dir":"rtl"}']]) {
    const env = { relativePath: 'fixture.md' }
    md.render(`${open}\n${body}\n---\n# T\n`, env)
    assert.deepEqual(env.frontmatter, { title: 'Home', dir: 'rtl' }, open)
  }
})

// Link fields

test('a link is kept when it is http(s), mailto or a path that stays on the site', () => {
  for (const link of ['https://example.com/a?b=1#c', 'http://example.com', 'HTTPS://EXAMPLE.COM', 'mailto:a@example.com', '/a/b', 'a/b', './a', '../a', '#frag', '?q=1', '', './a:b', '/a:b', '%6Aavascript:x', 'javascript&colon;x', 'javascript&#58;x']) {
    assert.equal(isSafeLink(link), true, JSON.stringify(link))
  }
})

test('a link with any other scheme is refused, whatever the spelling', () => {
  const refused = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:msgbox(1)',
    'blob:https://example.com/id',
    'file:///etc/passwd',
    'tel:+4912345',
    'ftp://example.com/x',
    'a:b',
    'x-unknown:y',
    // The URL parser drops leading and trailing control characters and spaces, and removes tab and newline anywhere.
    ' javascript:x',
    'javascript:x ',
    '\tjavascript:x',
    '\njavascript:x',
    '\r\njavascript:x',
    'java\nscript:x',
    'java\tscript:x',
    'java\rscript:x',
    '\u0000javascript:x',
    '\u001fjavascript:x',
    '\u007fjavascript:x',
    '\u00a0javascript:x',
    '\u2028javascript:x',
    '\ufeffjavascript:x',
    // Network-path references and backslashes, which the URL parser reads as slashes.
    '//evil.example/x',
    '///evil.example',
    '/\\evil.example',
    '\\/evil.example',
    '\\\\evil.example',
    'a\\b',
    // A space inside a path is not worth a second rule: it is refused too.
    '/a b',
    // Not a string, or a scheme the parser cannot complete.
    'http:',
    'https:',
    'http://',
    5,
    0,
    true,
    null,
    undefined,
    ['javascript:x'],
    ['/a'],
    { href: 'javascript:x' },
    { toString: () => '/a' }
  ]
  for (const link of refused) assert.equal(isSafeLink(link), false, JSON.stringify(link))
})

test('every kept link resolves to http(s), mailto or the site, as the URL parser reads it', () => {
  const base = new URL('https://site.invalid/base/page')
  const kept = ['https://example.com/a', 'mailto:a@example.com', '/a/b', 'a/b', './a', '../a', '#frag', '?q=1', '', './a:b', '/a:b', '%6Aavascript:x', 'javascript&colon;x', 'javascript&#58;x']
  for (const link of kept) {
    assert.equal(isSafeLink(link), true, link)
    const url = new URL(link, base)
    assert.ok((url.protocol === 'https:' && (url.origin === base.origin || link.startsWith('https://'))) || url.protocol === 'mailto:', `${link} resolves to ${url.href}`)
  }
})

test('what a browser resolves from a refused link is never an http(s), mailto or same-site URL', () => {
  // Cross-check of the rule against the URL parser for the bypasses a browser would read as a script scheme.
  const base = new URL('https://site.invalid/base/page')
  for (const link of ['java\nscript:x', '\tjavascript:x', ' javascript:x', 'JaVaScRiPt:x', 'data:text/html,x', '/\\evil.example']) {
    const url = new URL(link, base)
    assert.equal(isSafeLink(link), false, link)
    assert.ok(!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.origin !== base.origin, `${link} resolves to ${url.href}`)
  }
  // The kept look-alikes resolve on the site.
  for (const link of ['%6Aavascript:x', 'javascript&colon;x']) assert.equal(new URL(link, base).origin, base.origin, link)
})

test('a relative link the theme would write as another site is refused, whatever the spelling', () => {
  // None of these has a scheme or starts with "//", yet the theme writes each as "//evil.example/...".
  for (const link of themeOffsite) assert.equal(isSafeLink(link), false, link)
  // The same through every field that reaches an href.
  for (const link of themeOffsite) {
    assert.equal('link' in sanitizeFrontmatter({ prev: { text: 'P', link } }).prev, false, link)
    assert.equal('link' in sanitizeFrontmatter({ next: { text: 'N', link } }).next, false, link)
    assert.equal('link' in sanitizeFrontmatter({ hero: { actions: [{ text: 'a', link }] } }).hero.actions[0], false, link)
    assert.equal('link' in sanitizeFrontmatter({ features: [{ title: 'f', link }] }).features[0], false, link)
  }
})

test('a relative value the URL parser cannot read is refused', () => {
  for (const link of ['//', '///', '//[x', '//:', '//%']) assert.equal(isSafeLink(link), false, link)
})

test('relative links that stay on the site are kept, including look-alikes of the refused ones', () => {
  for (const link of keptRelative) {
    assert.equal(isSafeLink(link), true, link)
    assert.equal(sanitizeFrontmatter({ prev: { link } }).prev.link, link)
    assert.equal(sanitizeFrontmatter({ hero: { actions: [{ link }] } }).hero.actions[0].link, link)
    assert.equal(sanitizeFrontmatter({ features: [{ link }] }).features[0].link, link)
  }
})

test('a refused relative link is a network path once the dot segments are resolved or the $ pattern is expanded', () => {
  // Cross-check of the rule against the two operations the theme applies: the URL parser resolves the dot segments, and String.replace expands "$" patterns.
  const resolved = (link) => new URL(link, 'http://a.invalid/').pathname
  for (const link of ['/.//evil.example/x', '/%2e//evil.example/x', '/a/..//evil.example/x', 'a/..//evil.example/x', '%2e%2e//evil.example/x', 'x/../..//evil.example/deep']) {
    assert.ok(resolved(link).startsWith('//'), `${link} resolves to ${resolved(link)}`)
    assert.equal(isSafeLink(link), false, link)
  }
  assert.equal('/$1/evil.example/x'.replace(/(?:(^\.+)\/)?.*$/, `$1${resolved('/$1/evil.example/x')}`), '//evil.example/x')
  // A double slash inside the path stays on the site. After leading dots the theme keeps the dots, so the written link is still a path.
  assert.ok(!resolved('/a//b').startsWith('//'))
  for (const link of ['.//e/x', '..//e/x']) assert.ok(resolved(link).startsWith('//') && isSafeLink(link), link)
})

test('a previous or next link with a refused value is dropped, its text and a good link stay', () => {
  const out = sanitizeFrontmatter({
    prev: { text: 'P', link: 'javascript:prev' },
    next: { text: 'N', link: 'JaVaScRiPt:next' }
  })
  assert.deepEqual(out.prev, { text: 'P' })
  assert.deepEqual(out.next, { text: 'N' })
  assert.deepEqual(sanitizeFrontmatter({ prev: { link: ['/a'] } }).prev, {})
  assert.deepEqual(sanitizeFrontmatter({ next: { text: 'N', link: 'https://example.com/n' } }).next, { text: 'N', link: 'https://example.com/n' })
  assert.deepEqual(sanitizeFrontmatter({ prev: { text: 'P' } }).prev, { text: 'P' })
  assert.equal(sanitizeFrontmatter({ prev: false }).prev, false)
})

test('a hero action link with a refused value is dropped', () => {
  const actions = [
    { text: 'a', link: 'javascript:a' },
    { text: 'b', link: '/ok' },
    { text: 'c', link: 5 },
    { text: 'd', link: '//evil.example' },
    { text: 'e' }
  ]
  assert.deepEqual(sanitizeFrontmatter({ hero: { actions } }).hero.actions, [{ text: 'a' }, { text: 'b', link: '/ok' }, { text: 'c' }, { text: 'd' }, { text: 'e' }])
})

test('hero actions are kept as a list and dropped in any other shape', () => {
  assert.deepEqual(sanitizeFrontmatter({ hero: { name: 'N', actions: { first: { link: 'javascript:a' } } } }).hero, { name: 'N' })
  assert.deepEqual(sanitizeFrontmatter({ hero: { actions: 'javascript:a' } }).hero, {})
  assert.deepEqual(sanitizeFrontmatter({ hero: { actions: ['x', 5, null] } }).hero.actions, ['x', 5, null])
})

test('a feature link with a refused value is dropped', () => {
  const features = [{ title: 'a', link: 'javascript:a' }, { title: 'b', link: 'mailto:x@example.com' }, { title: 'c', link: ['/a'] }, { title: 'd', link: 'data:text/html,x' }]
  assert.deepEqual(sanitizeFrontmatter({ features }).features, [{ title: 'a' }, { title: 'b', link: 'mailto:x@example.com' }, { title: 'c' }, { title: 'd' }])
})

test('target is limited to the four browsing-context keywords', () => {
  assert.deepEqual([...allowedTargets].sort(), ['_blank', '_parent', '_self', '_top'])
  for (const target of allowedTargets) {
    assert.equal(sanitizeFrontmatter({ hero: { actions: [{ target }] } }).hero.actions[0].target, target)
    assert.equal(sanitizeFrontmatter({ features: [{ target }] }).features[0].target, target)
  }
  for (const target of ['frame', '_SELF', '_Blank', ' _self', '_self ', '_new', '', 0, null, true, ['_self'], { toString: () => '_self' }]) {
    assert.equal('target' in sanitizeFrontmatter({ hero: { actions: [{ target }] } }).hero.actions[0], false, JSON.stringify(target))
    assert.equal('target' in sanitizeFrontmatter({ features: [{ target }] }).features[0], false, JSON.stringify(target))
  }
})

test('rel is kept only when every token is on the allow-list', () => {
  assert.equal(allowedRelTokens.has('opener'), false)
  for (const rel of ['noopener', 'noreferrer', 'noopener nofollow', 'nofollow ugc sponsored', 'me']) {
    assert.equal(sanitizeFrontmatter({ hero: { actions: [{ rel }] } }).hero.actions[0].rel, rel)
    assert.equal(sanitizeFrontmatter({ features: [{ rel }] }).features[0].rel, rel)
  }
  for (const rel of ['opener', 'noopener opener', 'trustedrel', 'noopener  nofollow', ' noopener', 'noopener ', 'NoOpener', 'noopener\nnofollow', '', 5, null, ['noopener'], { toString: () => 'noopener' }]) {
    assert.equal('rel' in sanitizeFrontmatter({ hero: { actions: [{ rel }] } }).hero.actions[0], false, JSON.stringify(rel))
    assert.equal('rel' in sanitizeFrontmatter({ features: [{ rel }] }).features[0], false, JSON.stringify(rel))
  }
})

test('sanitising a link leaves its input alone', () => {
  const input = { prev: { text: 'P', link: 'javascript:x' }, hero: { actions: [{ link: 'javascript:y', target: 'frame' }] }, features: [{ link: 'javascript:z' }] }
  const copy = JSON.parse(JSON.stringify(input))
  sanitizeFrontmatter(input)
  assert.deepEqual(input, copy)
})
