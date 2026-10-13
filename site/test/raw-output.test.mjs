// Renders hostile Markdown through the site's real markdown configuration and
// checks that author text never reaches the page as live HTML or as a Vue
// expression: fence info strings, markdown-it-attrs, explicit ids, code-group
// and alert titles, mustache, and the page description.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkdownRenderer, resolveConfig } from 'vitepress'
import { allowedAttributes, allowedDirs, defuseMustache, escapeDescriptionMeta, escapeText, safeId, sanitizeFrontmatter, transformPageData } from '../.vitepress/raw-output.mjs'
import { escapeText as siteEscapeText, markdownBase } from '../.vitepress/site-helpers.mjs'

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
  assert.equal(out.features[0].icon, icon)
  assert.equal(out.head, input.head, 'head stays the documented raw path')
  assert.deepEqual(sanitizeFrontmatter({}), {})
  assert.deepEqual(sanitizeFrontmatter({ hero: 'text', features: 'text' }), { hero: 'text', features: 'text' })
})

test('sanitising leaves its input alone and transformPageData returns only the frontmatter', () => {
  const frontmatter = { dir: 'x', prev: '<b>', hero: { name: '<b>' } }
  const out = transformPageData({ title: 'T', frontmatter })
  assert.deepEqual(Object.keys(out), ['frontmatter'])
  assert.deepEqual(frontmatter, { dir: 'x', prev: '<b>', hero: { name: '<b>' } })
  assert.equal(out.frontmatter.hero.name, '&lt;b&gt;')
})
