// Renders hostile Markdown through the site's real markdown configuration and
// checks that author text never reaches the page as live HTML or as a Vue
// expression: fence info strings, markdown-it-attrs, code-group and alert
// titles, mustache, and env.title.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkdownRenderer, resolveConfig } from 'vitepress'
import { allowedAttributes, defuseMustache, escapeText } from '../.vitepress/raw-output.mjs'
import { escapeText as siteEscapeText, markdownBase } from '../.vitepress/site-helpers.mjs'

let md
before(async () => {
  const cfg = await resolveConfig('.')
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
  assert.match(render('para {.keep #mine}\n'), /<p class="keep" id="mine">para<\/p>/)
  assert.match(render('# Head {#custom}\n'), /<h1 id="custom"/)
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

test('a mustache in a fenced block stays as written, inside v-pre', () => {
  const out = render('```js\nconst a = {{ b }}\n```\n')
  assert.match(out, /<pre[^>]*\bv-pre\b/)
  assert.ok(out.includes('{{'), out)
})

test('single braces and a mustache written as references are untouched', () => {
  const out = render('use {a} and &#123;&#123; b }} and {x} tail\n')
  assert.ok(out.includes('{a} and &#123;&#123; b }} and {x} tail'), out)
})

test('defuseMustache turns only a double open brace into references', () => {
  assert.equal(defuseMustache('{{ a }} {b} {{{c'), '&#123;&#123; a }} {b} &#123;&#123;{c')
})

// env.title

test('env.title holds the first h1 as escaped text', () => {
  const env = { relativePath: 'fixture.md' }
  md.render('# <b>hi</b> & "q" `<i>`\n', env)
  assert.equal(env.title, '&lt;b&gt;hi&lt;/b&gt; &amp; &quot;q&quot; &lt;i&gt;')
})

test('env.title is escaped once when the page is rendered twice, and empty without an h1', () => {
  const src = '# a & b\n'
  const a = { relativePath: 'fixture.md' }
  const b = { relativePath: 'fixture.md' }
  md.render(src, a)
  md.render(src, b)
  assert.equal(a.title, 'a &amp; b')
  assert.equal(b.title, 'a &amp; b')
  const c = { relativePath: 'fixture.md' }
  md.render('no heading\n', c)
  assert.equal(c.title, '')
})
