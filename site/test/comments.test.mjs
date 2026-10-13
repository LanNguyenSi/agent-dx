// Renders fixtures through the site's real markdown configuration and checks
// that HTML comments are dropped without losing any other content.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMarkdownRenderer, resolveConfig } from 'vitepress'
import { stripComments } from '../.vitepress/html-comments.mjs'

let md
before(async () => {
  const cfg = await resolveConfig('.')
  md = await createMarkdownRenderer(cfg.srcDir, cfg.userConfig.markdown, cfg.site.base)
})
const render = (src, env = {}) => md.render(src, { relativePath: 'fixture.md', ...env })
// The same renderer with the comment rules switched off, which shows every
// opener as text. VitePress hands out one renderer per process, so the rules
// are switched off on that renderer for the duration of the call.
const RULES = [
  [(m) => m.block.ruler, 'agent-dx-comment-block'],
  [(m) => m.inline.ruler, 'agent-dx-comment'],
  [(m) => m.core.ruler, 'agent-dx-comment-text']
]
const renderPlain = (src) => {
  for (const [ruler, name] of RULES) ruler(md).disable(name)
  try {
    return md.render(src, { relativePath: 'fixture.md' })
  } finally {
    for (const [ruler, name] of RULES) ruler(md).enable(name)
  }
}

test('the rule-free renderer shows what the comment rules hide', () => {
  // Without this, a renderPlain that is the same renderer as render would make
  // every comparison between the two pass.
  for (const src of ['a <!-- hidden --> b\n', '<!-- hidden\n\nstill hidden -->\n\ntail\n']) {
    assert.match(renderPlain(src), /hidden/, src)
    assert.ok(!render(src).includes('hidden'), src)
    assert.notEqual(render(src), renderPlain(src), src)
  }
  // The comment rules are back on after a plain render.
  assert.ok(!render('a <!-- hidden --> b\n').includes('hidden'))
})

test('top-of-file multi-line comment is removed', () => {
  const out = render('<!-- line one\nline two -->\n\n# Title\n\nbody\n')
  assert.ok(!out.includes('&lt;!--') && !out.includes('<!--') && !out.includes('line one'))
  assert.match(out, /Title/)
  assert.match(out, /body/)
})

test('comment in an indented code block stays as code', () => {
  const out = render('para\n\n    <!-- kept -->\n    code\n')
  assert.match(out, /(&lt;|&#x3C;)!-- kept --/)
})

test('comment inside a four-backtick fence with an inner fence stays as code', () => {
  const out = render('````md\n```js\nx\n```\n<!-- kept -->\n````\n')
  assert.match(out, /(&lt;|&#x3C;)!-- kept --/)
})

test('comment inside a tilde fence containing a backtick line stays as code', () => {
  const out = render('~~~\n```\n<!-- kept -->\n~~~\n')
  assert.match(out, /(&lt;|&#x3C;)!-- kept --/)
})

test('inline code span keeps its comment', () => {
  assert.match(render('use `<!-- x -->` here\n'), /(&lt;|&#x3C;)!-- x --/)
})

test('prose mentioning an opener keeps every paragraph up to a later closer', () => {
  for (const opener of ['\\<!--', '<!--']) {
    const out = render(`first mentions ${opener} here\n\nmiddle paragraph\n\nlast closes --> there\n`)
    assert.match(out, /first mentions/)
    assert.match(out, /middle paragraph/)
    assert.match(out, /last closes/)
  }
})

test('inline comment is dropped from a sentence', () => {
  const out = render('before <!-- hidden --> after\n')
  assert.ok(!out.includes('hidden'))
  assert.match(out, /before\s+after/)
})

test('placeholders render as literal text', () => {
  const out = render('install <version> now\n')
  assert.match(out, /&lt;version&gt;/)
})

test('an HTML block holding a comment and other HTML drops only the comment', () => {
  const out = render('<!-- gone -->\n<version>\n')
  assert.ok(!out.includes('gone'))
  assert.match(out, /&lt;version&gt;/)
})

test('a raw tag in a heading is escaped in the table of contents and the heading', () => {
  const out = render('[[toc]]\n\n## Hi <img src=x onerror=alert(1)>\n')
  assert.ok(!out.includes('<img'))
  assert.match(out, /Hi &lt;img src=x onerror=alert\(1\)&gt;/)
})

test('no source HTML token survives for later consumers', () => {
  const src = '<!-- c --> **x**\n\n## Hi <img src=x> <!-- c --> there\n\n<div>\nbody <b>y</b>\n'
  const flat = (tokens) => tokens.flatMap((t) => [t, ...flat(t.children ?? [])])
  const html = flat(md.parse(src, { relativePath: 'fixture.md' })).filter((t) => /^html_/.test(t.type))
  // Only the generated heading permalink symbol may remain.
  assert.deepEqual(html.map((t) => t.content), ['&ZeroWidthSpace;'])
})

test('a placeholder in a heading keeps its text in the anchor slug', () => {
  const out = render('### Task 1: <title>\n')
  assert.match(out, /<h3 id="task-1-title"/)
  assert.match(out, /href="#task-1-title"/)
})

test('the heading permalink symbol is markup, not escaped text', () => {
  const out = render('## Plain heading\n')
  assert.match(out, /&ZeroWidthSpace;<\/a>/)
  assert.ok(!out.includes('&amp;ZeroWidthSpace;'))
})

test('text after a closing comment on the same line still renders as Markdown', () => {
  const out = render('<!-- note --> **bold** tail\n')
  assert.ok(!out.includes('note'))
  assert.match(out, /<strong>bold<\/strong> tail/)
})

test('an unclosed comment opener stays visible and drops nothing', () => {
  const out = render('before\n\n<!-- never closed\n\nlater text\n')
  assert.match(out, /&lt;!-- never closed/)
  assert.match(out, /later text/)
})

const htmlTokens = (src) => {
  const flat = (tokens) => tokens.flatMap((t) => [t, ...flat(t.children ?? [])])
  return flat(md.parse(src, { relativePath: 'fixture.md' })).filter(
    (t) => /^html_/.test(t.type) && !t.meta?.isPermalinkSymbol
  )
}

test('a line starting with a custom element or component renders as escaped text', () => {
  // With raw HTML on, VitePress would parse these lines as components, which
  // the Vue compiler turns into live elements and props.
  const cases = {
    '<x-a onclick="1">t</x-a>\n': '<p>&lt;x-a onclick=&quot;1&quot;&gt;t&lt;/x-a&gt;</p>\n',
    '<Foo />\n': '<p>&lt;Foo /&gt;</p>\n',
    '<Foo bar="1" /> rest **b**\n': '<p>&lt;Foo bar=&quot;1&quot; /&gt; rest <strong>b</strong></p>\n',
    '<my-el v-html="\'<img src=x>\'"></my-el>\n':
      '<p>&lt;my-el v-html=&quot;\'&lt;img src=x&gt;\'&quot;&gt;&lt;/my-el&gt;</p>\n'
  }
  for (const [src, expected] of Object.entries(cases)) {
    assert.equal(render(src), expected)
    assert.deepEqual(htmlTokens(src), [])
  }
})

test('entities and backslash escapes inside an HTML block render as in a paragraph', () => {
  const out = render('<div>\n\\*x\\* &amp; &copy; &#60;b&#62;\n</div>\n')
  assert.equal(out, '<p>&lt;div&gt;\n*x* &amp; &copy; &#60;b&#62;\n&lt;/div&gt;</p>\n')
})

test('a comment inside image alt text is dropped from the alt attribute', () => {
  const src = '![a <!-- c --> b](x.png)\n'
  assert.match(render(src), /<img src="[^"]*x\.png" alt="a {2}b">/)
  assert.deepEqual(htmlTokens(src), [])
})

test('a comment in a heading is dropped from the permalink label, a code span keeps it', () => {
  assert.match(render('## A <!-- x --> B\n'), /aria-label="Permalink to &quot;A {2}B&quot;"/)
  const code = render('## A <!-- x --> `<!-- y -->` B\n')
  assert.match(code, /aria-label="Permalink to &quot;A {2}`(&lt;|&#x3C;)!-- y --&gt;` B&quot;"/)
})

// Each case is [Markdown, expected HTML]. The expected HTML is the rendering of
// the same Markdown with its comments deleted from the source first, so a
// hidden comment leaves the page exactly as if it had never been written.
const renderAsIfDeleted = (cases) => {
  for (const [src, expected] of cases) {
    assert.equal(render(src), expected, src)
    assert.deepEqual(htmlTokens(src), [], src)
  }
}

test('comments with -- inside, or opened by <!--> or <!--->, stay hidden', () => {
  renderAsIfDeleted([
    ['Run it <!-- TODO: add --dry-run --> now\n', '<p>Run it  now</p>\n'],
    ['Run it <!-- TODO\nuse --dry-run --> now\n', '<p>Run it  now</p>\n'],
    ['a <!--> b --> c\n', '<p>a  c</p>\n'],
    ['a <!---> b --> c\n', '<p>a  c</p>\n']
  ])
})

test('a heading keeps the slug and permalink label it has without the comment', () => {
  renderAsIfDeleted([
    [
      '## Step <!-- note --force --> one\n',
      '<h2 id="step-one" tabindex="-1">Step  one <a class="header-anchor" href="#step-one" aria-label="Permalink to &quot;Step  one&quot;">&ZeroWidthSpace;</a></h2>\n'
    ],
    [
      '## Title <!-- note -->\n',
      '<h2 id="title" tabindex="-1">Title <a class="header-anchor" href="#title" aria-label="Permalink to &quot;Title&quot;">&ZeroWidthSpace;</a></h2>\n'
    ]
  ])
})

test('comments in table cells and in link, image, and container titles are hidden', () => {
  renderAsIfDeleted([
    [
      '| a <!-- c --> | <!-- d --> b |\n|---|---|\n| c | d |\n',
      '<table tabindex="0">\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>c</td>\n<td>d</td>\n</tr>\n</tbody>\n</table>\n'
    ],
    [
      '[x](https://e.example "t <!-- c -->")\n',
      '<p><a href="https://e.example" title="t " target="_blank" rel="noreferrer">x</a></p>\n'
    ],
    [
      '[x](https://e.example "<!-- c -->")\n',
      '<p><a href="https://e.example" target="_blank" rel="noreferrer">x</a></p>\n'
    ],
    [
      '[x][r]\n\n[r]: https://e.example "t <!-- c -->"\n',
      '<p><a href="https://e.example" title="t " target="_blank" rel="noreferrer">x</a></p>\n'
    ],
    ['![a](x.png "t <!-- c -->")\n', '<p><img src="./x.png" alt="a" title="t "></p>\n'],
    [
      '::: details <!-- c -->\nbody\n:::\n',
      '<details class="details custom-block"><summary>Details</summary>\n<p>body</p>\n</details>\n'
    ]
  ])
})

test('a comment inside a code span is kept next to a component, an HTML tag, or a comment', () => {
  renderAsIfDeleted([
    [
      '<Foo /> use `<!-- kept -->` here\n',
      '<p>&lt;Foo /&gt; use <code>&lt;!-- kept --&gt;</code> here</p>\n'
    ],
    ['<div>\n`<!-- kept -->`\n</div>\n', '<p>&lt;div&gt;\n<code>&lt;!-- kept --&gt;</code>\n&lt;/div&gt;</p>\n'],
    ['<!-- a --> `<!-- kept -->` x\n', '<p><code>&lt;!-- kept --&gt;</code> x</p>\n']
  ])
})

test('lines holding only comments render nothing', () => {
  renderAsIfDeleted([
    ['<!-- c -->\n', ''],
    ['<!-- use --force here -->\n', ''],
    ['<!-- use --force here -->\n\ntext\n', '<p>text</p>\n'],
    ['<!-- a\n\nb -->\n', ''],
    ['<!-- a --> <!-- b -->\n', ''],
    ['<!-- a --> <!-- b\nc -->\ntext\n', '<p>text</p>\n'],
    ['a\n<!-- x --> <!-- y\nz -->\nb\n', '<p>a</p>\n<p>b</p>\n'],
    ['> <!-- a\nb -->\n', '<blockquote></blockquote>\n']
  ])
})

test('comments in list items keep the list tight or loose as without them', () => {
  renderAsIfDeleted([
    ['- <!-- c --> text\n- b\n', '<ul>\n<li>text</li>\n<li>b</li>\n</ul>\n'],
    ['- <div>x</div>\n- b\n', '<ul>\n<li>&lt;div&gt;x&lt;/div&gt;</li>\n<li>b</li>\n</ul>\n'],
    ['- <Foo />\n- b\n', '<ul>\n<li>&lt;Foo /&gt;</li>\n<li>b</li>\n</ul>\n'],
    ['- a\n  <!-- c -->\n- b\n', '<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>\n'],
    ['- <!-- c -->\n  a\n- b\n', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n']
  ])
})

test('text after a comment that starts a line stays part of its paragraph', () => {
  renderAsIfDeleted([
    ['a\n<!-- c --> text\n', '<p>a\ntext</p>\n'],
    ['<!-- c --> text\nmore\n', '<p>text\nmore</p>\n'],
    ['<!-- a\n\nb --> tail\n', '<p>tail</p>\n']
  ])
})

test('escaped backticks in a heading do not keep a comment in the permalink label', () => {
  // The backticks are escaped, so they open no code span and the comment
  // between them is hidden in the heading, its slug, and its label alike.
  assert.equal(
    render('## A \\` <!-- x --> \\` B\n'),
    '<h2 id="a-b" tabindex="-1">A `  ` B <a class="header-anchor" href="#a-b" aria-label="Permalink to &quot;A \\`  \\` B&quot;">&ZeroWidthSpace;</a></h2>\n'
  )
})

test('text without a comment is left exactly as written', () => {
  assert.equal(md.renderInline(' x '), ' x ')
})

test('commented-out list items leave one list, as without the comment', () => {
  const loose = (tag, a, b) => `<${tag}>\n<li>\n<p>${a}</p>\n</li>\n<li>\n<p>${b}</p>\n</li>\n</${tag}>\n`
  renderAsIfDeleted([
    ['- a\n<!--\n- b\n-->\n- c\n', loose('ul', 'a', 'c')],
    ['1. a\n<!--\n2. b\n-->\n3. c\n', loose('ol', 'a', 'c')],
    ['- a\n<!-- b -->\n- c\n', loose('ul', 'a', 'c')],
    ['- a\n  - b\n  <!--\n  - c\n  -->\n  - d\n', `<ul>\n<li>a\n${loose('ul', 'b', 'd')}</li>\n</ul>\n`],
    ['> - a\n> <!--\n> - b\n> -->\n> - c\n', `<blockquote>\n${loose('ul', 'a', 'c')}</blockquote>\n`],
    [
      '::: tip\n- a\n<!--\n- b\n-->\n- c\n:::\n',
      `<div class="tip custom-block"><p class="custom-block-title">TIP</p>\n${loose('ul', 'a', 'c')}</div>\n`
    ],
    ['- <!--\n- b\n-->\n- c\n', '<ul>\n<li></li>\n<li>c</li>\n</ul>\n']
  ])
})

test('blank lines inside a comment that starts a line are part of the comment', () => {
  renderAsIfDeleted([
    ['- a\n  <!-- b\n\n  c -->\n- d\n', '<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>d</p>\n</li>\n</ul>\n'],
    ['<!-- a -->\t<!-- b\n\nc -->\ntext\n', '<p>text</p>\n'],
    ['<!-- a --> <!-- b\n\nc -->\ntext\n', '<p>text</p>\n'],
    // The quote is first read up to the comment line after it, then its own
    // lines are parsed; the comment inside still closes at its own "-->".
    ['> <!-- a\n>\n> b -->\n> c\n<!-- d -->\n', '<blockquote>\n<p>c</p>\n</blockquote>\n']
  ])
})

test('a comment line four or more columns in after a quote line stays in the quote', () => {
  // As on GitHub, such a line continues the quote's paragraph, and the inline
  // rule hides its comment; it neither ends the quote nor starts a code block.
  renderAsIfDeleted([['> a\n    <!-- c\n    d --> e\n', '<blockquote>\n<p>a\ne</p>\n</blockquote>\n']])
  assert.equal(render('> a\n    <!-- c -->\nb\n'), '<blockquote>\n<p>a\n\nb</p>\n</blockquote>\n')
})

test('an inline comment that closes past the end of the text being parsed stays text', () => {
  // Link text is parsed with an end before the closing bracket; a comment is
  // hidden only when it closes before that end.
  const src = 'a <!-- b --> c'
  const state = new md.inline.State(src, md, {}, [])
  state.posMax = src.indexOf('-->')
  md.inline.tokenize(state)
  assert.equal(state.tokens.map((t) => t.content).join(''), 'a <!-- b ')
})

test('an unclosed opener in a quote or list item stays visible', () => {
  assert.equal(render('> <!-- never closed\n'), '<blockquote>\n<p>&lt;!-- never closed</p>\n</blockquote>\n')
  assert.equal(render('- <!-- never closed\n- b\n'), '<ul>\n<li>&lt;!-- never closed</li>\n<li>b</li>\n</ul>\n')
})

// Each case is [Markdown, expected HTML], the expected HTML taken from a
// renderer without the comment rules, which shows the opener as text.
const renderAsIfNoRule = (cases) => {
  for (const [src, expected] of cases) assert.equal(render(src), expected, src)
}

test('a comment that starts a line never cuts a fenced code block', () => {
  // The first "-->" after each opener lies inside a fence that opens after the
  // comment's first line, so the opener is not a comment: it stays visible,
  // the fence keeps its content, and later fences keep their pairing. A
  // backtick fence is closed only by at least as many backticks, a tilde
  // fence only by tildes, and a closer indented four or more columns past its
  // opener does not close it.
  renderAsIfNoRule([
    ['- step one\n- <!-- TODO fix the wording\n- step three\n\nMore prose.\n\n```bash\nyes | head --> out\n```\n\nAfter the fence.\n', '<ul>\n<li>step one</li>\n<li>&lt;!-- TODO fix the wording</li>\n<li>step three</li>\n</ul>\n<p>More prose.</p>\n<div class="language-bash vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">yes</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> head</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> --</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">></span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF"> out</span></span></code></pre>\n</div><p>After the fence.</p>\n'],
    ['<!-- TODO fix\n\nKeep this paragraph.\n\n```mermaid\ngraph LR\nA --> B\n```\n\nAfter the fence.\n\n```js\nlet x = 1\n```\n\nTail.\n', '<p>&lt;!-- TODO fix</p>\n<p>Keep this paragraph.</p>\n<div class="language-mermaid vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">mermaid</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">graph LR</span></span>\n<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">A --> B</span></span></code></pre>\n</div><p>After the fence.</p>\n<div class="language-js vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">js</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">let</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> x </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> 1</span></span></code></pre>\n</div><p>Tail.</p>\n'],
    ['- a\n  <!-- typo\n\n  ```\n  x --> y\n  ```\n- b\n', '<ul>\n<li>\n<p>a\n&lt;!-- typo</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>x --> y</span></span></code></pre>\n</div></li>\n<li>\n<p>b</p>\n</li>\n</ul>\n'],
    ['- <!-- typo\n\n```\na --> b\n```\n\nprose one\n\n```\ncode two\n```\n\nprose two\n', '<ul>\n<li>&lt;!-- typo</li>\n</ul>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>a --> b</span></span></code></pre>\n</div><p>prose one</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>code two</span></span></code></pre>\n</div><p>prose two</p>\n'],
    ['<!-- typo\n\n````md\n```js\nA --> B\n```\n````\n\ntail\n', '<p>&lt;!-- typo</p>\n<div class="language-md vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">md</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">```js</span></span>\n<span class="line"><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">A</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> --></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> B</span></span>\n<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">```</span></span></code></pre>\n</div><p>tail</p>\n'],
    ['<!-- typo\n\n~~~\ncode\n```\nx --> y\n~~~\n\ntail\n', '<p>&lt;!-- typo</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>code</span></span>\n<span class="line"><span>```</span></span>\n<span class="line"><span>x --> y</span></span></code></pre>\n</div><p>tail</p>\n'],
    ['<!-- typo\n\n```\ncode\n    ```\nx --> y\n```\n\ntail\n', '<p>&lt;!-- typo</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>code</span></span>\n<span class="line"><span>    ```</span></span>\n<span class="line"><span>x --> y</span></span></code></pre>\n</div><p>tail</p>\n'],
    ['<!-- x\n```\n-->\n```\ntail\n', '<p>&lt;!-- x</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>--></span></span></code></pre>\n</div><p>tail</p>\n'],
    ['- a\n- <!-- TODO reword\n- gamma\n\nProse.\n\n```text\nA --> B\n```\n\nProse between fences.\n\n```bash\necho second\n```\n', '<ul>\n<li>a</li>\n<li>&lt;!-- TODO reword</li>\n<li>gamma</li>\n</ul>\n<p>Prose.</p>\n<div class="language-text vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">text</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>A --> B</span></span></code></pre>\n</div><p>Prose between fences.</p>\n<div class="language-bash vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">echo</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF"> second</span></span></code></pre>\n</div>'],
  ])
})

test('a comment that starts a line may enclose a whole fence', () => {
  renderAsIfDeleted([
    ['<!--\n## Old\n```bash\nold\n```\n-->\n\nKept.\n', '<p>Kept.</p>\n'],
    ['- a\n  <!--\n  ```bash\n  old\n  ```\n  -->\n- b\n', '<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>\n'],
  ])
})

test('a comment opened in a quote stays visible when its closer lies in a fence inside the quote', () => {
  renderAsIfNoRule([
    ['> <!-- typo\n>\n> ```\n> a --> b\n> ```\n> c\n', '<blockquote>\n<p>&lt;!-- typo</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>a --> b</span></span></code></pre>\n</div><p>c</p>\n</blockquote>\n'],
  ])
})

test('the closer search for a comment in a quote ends at the quote', () => {
  // The quote's own lines are parsed with the quote's end as the limit, and a
  // "-->" after that end does not close a comment opened inside it.
  assert.equal(
    render('> <!-- a\n> b\n\nc -->\nd\n'),
    '<blockquote>\n<p>&lt;!-- a\nb</p>\n</blockquote>\n<p>c --&gt;\nd</p>\n'
  )
})

test('an unclosed opener does not end the paragraph or quote before it', () => {
  assert.equal(render('before\n<!-- never closed\nafter\n'), '<p>before\n&lt;!-- never closed\nafter</p>\n')
  assert.equal(
    render('> a\n<!-- never closed\nb\n'),
    '<blockquote>\n<p>a\n&lt;!-- never closed\nb</p>\n</blockquote>\n'
  )
})

test('a comment line after a quote line ends the quote', () => {
  // Without the comment rule among the quote's terminators the line would
  // continue the quote's paragraph, and so would the text after it.
  for (const src of ['> a\n<!-- c -->\nb\n', '> a\n<!-- c\nd -->\nb\n']) {
    assert.equal(render(src), '<blockquote>\n<p>a</p>\n</blockquote>\n<p>b</p>\n', src)
  }
})

test('a page of unclosed openers is searched for a closer once, not once per opener', (t) => {
  // findClose keeps the answer of one search over the page and answers every
  // later opener from it. The inline rule searches each paragraph's own text,
  // which is short whatever the page length, so only searches over the whole
  // page count here.
  const page = (n) => Array.from({ length: n }, (_, i) => `<!-- opener ${i}\ntext ${i}`).join('\n\n') + '\n'
  const src = page(1000)
  const indexOf = t.mock.method(String.prototype, 'indexOf')
  render(src)
  const searches = indexOf.mock.calls.filter((c) => c.arguments[0] === '-->' && String(c.this) === src)
  assert.ok(searches.length <= 2, `the page was searched ${searches.length} times for -->`)
})

test('a long page of unclosed openers renders within a coarse time bound', () => {
  // One search over the page answers every opener; a search that starts over
  // at each opener grows with the square of the page's length. The bound
  // assumes a runner with at least one full core.
  const page = (n) => Array.from({ length: n }, (_, i) => `<!-- opener ${i}\ntext ${i}`).join('\n\n') + '\n'
  const start = performance.now()
  render(page(32000))
  const ms = performance.now() - start
  assert.ok(ms < 3000, `rendering 32000 unclosed openers took ${Math.round(ms)} ms`)
})

// Counts the work the comment rules do instead of timing it, so the checks do
// not depend on how busy the machine is. A block rule placed ahead of the
// comment rule swaps each parser state's line-end array for a proxy that
// counts reads; the comment rule reads that array once per step of its closer
// search.
let countReads = null
let spyAdded = false
const SPY = 'test-line-end-spy'
const spied = new WeakSet()
const spy = (state) => {
  if (countReads && !spied.has(state)) {
    spied.add(state)
    state.eMarks = new Proxy(state.eMarks, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) countReads.n++
        return target[key]
      }
    })
  }
  return false
}
const lineEndReads = (src) => {
  if (!spyAdded) {
    md.block.ruler.before('agent-dx-comment-block', SPY, spy, { alt: ['paragraph', 'reference', 'blockquote'] })
    spyAdded = true
  }
  md.block.ruler.enable(SPY)
  countReads = { n: 0 }
  try {
    render(src)
    return countReads.n
  } finally {
    countReads = null
    md.block.ruler.disable(SPY)
  }
}

test('the line search for a far closer reads a number of line ends that grows with the page length', () => {
  // Every other line is an opener. With the closer far below, inside a fence
  // (each opener is then refused) or absent, the reads per opener must not
  // grow with the page: four times the lines takes about four times the reads
  // (a binary search adds a logarithm), where walking the lines from each
  // opener to the closer takes about sixteen times as many.
  const lines = (n) => 'text line\n<!-- o\n'.repeat(n / 2)
  for (const [name, tail] of [['absent', ''], ['in a fence', '```\n-->\n```\n']]) {
    const small = lineEndReads(lines(4000) + tail)
    const large = lineEndReads(lines(16000) + tail)
    assert.ok(small > 0, 'the spy counts reads')
    assert.ok(large / small < 8, `closer ${name}: 4x the lines took ${(large / small).toFixed(1)}x the line-end reads`)
  }
})

test('the closer search of a paragraph of unclosed openers runs once, not once per opener', (t) => {
  // Counts every search for "-->", in the page and in the text of the paragraph
  // alike. A text scan that keeps going after an opener has no closer would
  // search again for each opener that follows.
  const src = 'text line\n<!-- o\n'.repeat(1000)
  const indexOf = t.mock.method(String.prototype, 'indexOf')
  assert.equal(stripComments(src), src)
  const direct = indexOf.mock.calls.filter((c) => c.arguments[0] === '-->').length
  assert.ok(direct <= 2, `stripComments searched ${direct} times for -->`)
  indexOf.mock.resetCalls()
  render(src)
  const searches = indexOf.mock.calls.filter((c) => c.arguments[0] === '-->').length
  assert.ok(searches <= 10, `the render searched ${searches} times for -->`)
})

test('a comment opened in a quote whose closer lies after the quote stays visible', () => {
  // The closer's line lies past the end of the quote, so the opener closes
  // nowhere within it, and the lines of the quote are not hidden.
  assert.equal(render('> <!-- a\n> b\n\nc -->\n'), '<blockquote>\n<p>&lt;!-- a\nb</p>\n</blockquote>\n<p>c --&gt;</p>\n')
  // After a line of text the opener is no paragraph of its own: the quote keeps
  // one paragraph.
  assert.equal(render('> a\n> <!-- a\n> b\n\nc -->\n'), '<blockquote>\n<p>a\n&lt;!-- a\nb</p>\n</blockquote>\n<p>c --&gt;</p>\n')
})

test('stripComments takes the first closer after each opener and keeps an opener without one', () => {
  assert.equal(stripComments('a <!-- x --> b <!-- y --> c'), 'a  b  c')
  assert.equal(stripComments('a <!-- x --> b <!-- y'), 'a  b <!-- y')
  assert.equal(stripComments('<!--> x -->'), '')
  assert.equal(stripComments('<!---->z'), 'z')
  // "-->" must start after the four characters of the opener.
  assert.equal(stripComments('<!---> x'), '<!---> x')
  assert.equal(stripComments('<!---> x --> y'), ' y')
  assert.equal(stripComments('`<!-- x -->` <!-- y -->'), '`<!-- x -->` ')
  assert.equal(stripComments('\\<!-- x --> y'), '\\<!-- x --> y')
  assert.equal(stripComments('<!-- a <!-- b --> c --> d'), ' c --> d')
  assert.equal(stripComments('`<!-- x` --> <!-- y'), '`<!-- x` --> <!-- y')
})

test('a backtick line indented four columns after a comment line is not a fence', () => {
  // Such a line is a lazy continuation of the comment's paragraph, not a fence
  // opener, so the comment closes at the "-->" after it and its content stays
  // hidden, and the comment lines read as blank lines.
  assert.equal(render('<!-- typo\n    ```\n    x -->\n'), '')
  assert.equal(render('para\n<!-- typo\n    ```\n    x -->\ntail\n'), '<p>para</p>\n<p>tail</p>\n')
})

test('a fence in a nested list item or container after a comment line keeps the opener visible', () => {
  // The fence lines sit four or more columns past the comment's container, as
  // the content of a nested list item does, and the first "-->" after each
  // opener lies inside that fence: the opener stays visible, the list keeps
  // its items, and the fence keeps its content.
  renderAsIfNoRule([
    ['<!-- TODO reword\n\n- Step one\n  - Run this:\n    ```mermaid\n    graph LR\n    A --> B\n    ```\n- Step two\n\nAfter.\n', '<p>&lt;!-- TODO reword</p>\n<ul>\n<li>Step one\n<ul>\n<li>Run this:<div class="language-mermaid vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">mermaid</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">graph LR</span></span>\n<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">A --> B</span></span></code></pre>\n</div></li>\n</ul>\n</li>\n<li>Step two</li>\n</ul>\n<p>After.</p>\n'],
    ['<!-- TODO reword\n\n10. Run this:\n    ```bash\n    yes | head --> out\n    ```\n11. Next\n\nAfter.\n', '<p>&lt;!-- TODO reword</p>\n<ol start="10">\n<li>Run this:<div class="language-bash vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">yes</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> head</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> --</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">></span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF"> out</span></span></code></pre>\n</div></li>\n<li>Next</li>\n</ol>\n<p>After.</p>\n'],
    ['- <!-- TODO reword\n- Step\n  - Sub\n    - Subsub\n      ```\n      a --> b\n      ```\n- Last\n', '<ul>\n<li>&lt;!-- TODO reword</li>\n<li>Step\n<ul>\n<li>Sub\n<ul>\n<li>Subsub<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>a --> b</span></span></code></pre>\n</div></li>\n</ul>\n</li>\n</ul>\n</li>\n<li>Last</li>\n</ul>\n'],
    ['::: tip\n<!-- typo\n\n- a\n  - b\n    ```\n    x --> y\n    ```\n:::\n', '<div class="tip custom-block"><p class="custom-block-title">TIP</p>\n<p>&lt;!-- typo</p>\n<ul>\n<li>a\n<ul>\n<li>b<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>x --> y</span></span></code></pre>\n</div></li>\n</ul>\n</li>\n</ul>\n</div>\n'],
  ])
})

test('a fence closes only at a line of enough of its character, at the container column, followed by spaces or tabs alone', () => {
  // A line indented four columns past the container does not close a fence
  // opened two columns in, a closer followed by a no-break space is not a
  // closer, three backticks do not close a four-backtick fence, and a backtick
  // line with an info string closes nothing. In each case the first "-->"
  // after the opener still lies inside the fence, so the opener stays visible.
  renderAsIfNoRule([
    ['<!-- typo\n\n  ```\n  code\n    ```\n  x --> y\n  ```\n\ntail\n', '<p>&lt;!-- typo</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>code</span></span>\n<span class="line"><span>  ```</span></span>\n<span class="line"><span>x --> y</span></span></code></pre>\n</div><p>tail</p>\n'],
    ['<!-- typo\n\n```\ncode\n``` \nx --> y\n```\n\ntail\n', '<p>&lt;!-- typo</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>code</span></span>\n<span class="line"><span>``` </span></span>\n<span class="line"><span>x --> y</span></span></code></pre>\n</div><p>tail</p>\n'],
    ['<!-- typo\n\n````md\n```js\ncode\n```\nA --> B\n````\n\ntail\n', '<p>&lt;!-- typo</p>\n<div class="language-md vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">md</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">```js</span></span>\n<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">code</span></span>\n<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">```</span></span>\n<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">A --> B</span></span></code></pre>\n</div><p>tail</p>\n'],
    ['<!-- typo\n\n```\ncode\n```js\nx --> y\n```\n\ntail\n', '<p>&lt;!-- typo</p>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>code</span></span>\n<span class="line"><span>```js</span></span>\n<span class="line"><span>x --> y</span></span></code></pre>\n</div><p>tail</p>\n'],
  ])
})

test('a backtick line in an indented code block before a fence leaves that fence intact', () => {
  // markdown-it reads the indented lines as code, so the unindented fence line
  // after them opens a real fence that holds the "-->". The opener stays
  // visible and the code is kept.
  renderAsIfNoRule([
    ['<!-- typo\n\n    ```\n    code\n```\nx --> y\n```\n\ntail\n', '<p>&lt;!-- typo</p>\n<pre><code>```\ncode\n</code></pre>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>x --> y</span></span></code></pre>\n</div><p>tail</p>\n'],
    ['<!-- typo\n\n    ~~~\n    code\n~~~\nx --> y\n~~~\n\ntail\n', '<p>&lt;!-- typo</p>\n<pre><code>~~~\ncode\n</code></pre>\n<div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span>x --> y</span></span></code></pre>\n</div><p>tail</p>\n'],
  ])
})

test('a backtick line whose info string holds a backtick opens no fence', () => {
  // The comment that starts a line closes at the "-->" on the line after that
  // line, across the blank line between them, so all of it is hidden. Only
  // the block rule reaches past a blank line: were that line a fence, the
  // opener would stay visible and the lines after the blank line would show.
  renderAsIfDeleted([['<!-- typo\n\n``` a`b\nx -->\ntail\n', '<p>tail</p>\n']])
})

test('a fence in a list item closed two or three columns past the item keeps a later fence whole', () => {
  // The list item's fence closes at its own column, so the "-->" inside the
  // later fence lies in a fence and the opener stays visible.
  renderAsIfNoRule([
    ['<!-- typo\n- a\n  ```\n  code\n    ```\n- b\n\n```\nx --> y\n```\n\ntail\n', '<p>&lt;!-- typo</p>\n<ul>\n<li>a<div class=\"language- vp-adaptive-theme\"><button title=\"Copy Code\" class=\"copy\"></button><span class=\"lang\"></span><pre class=\"shiki shiki-themes github-light github-dark vp-code\" tabindex=\"0\" v-pre=\"\"><code><span class=\"line\"><span>code</span></span></code></pre>\n</div></li>\n<li>b</li>\n</ul>\n<div class=\"language- vp-adaptive-theme\"><button title=\"Copy Code\" class=\"copy\"></button><span class=\"lang\"></span><pre class=\"shiki shiki-themes github-light github-dark vp-code\" tabindex=\"0\" v-pre=\"\"><code><span class=\"line\"><span>x --> y</span></span></code></pre>\n</div><p>tail</p>\n'],
    ['<!-- typo\n- a\n  ```\n  code\n\t```\n\n```\nx --> y\n```\n', '<p>&lt;!-- typo</p>\n<ul>\n<li>a<div class=\"language- vp-adaptive-theme\"><button title=\"Copy Code\" class=\"copy\"></button><span class=\"lang\"></span><pre class=\"shiki shiki-themes github-light github-dark vp-code\" tabindex=\"0\" v-pre=\"\"><code><span class=\"line\"><span>code</span></span></code></pre>\n</div></li>\n</ul>\n<div class=\"language- vp-adaptive-theme\"><button title=\"Copy Code\" class=\"copy\"></button><span class=\"lang\"></span><pre class=\"shiki shiki-themes github-light github-dark vp-code\" tabindex=\"0\" v-pre=\"\"><code><span class=\"line\"><span>x --> y</span></span></code></pre>\n</div>'],
  ])
})

test('a fence is found as markdown-it finds it, not by its indentation alone', () => {
  const x1 = render('<!-- typo\n\n    ```\n    code\n   ```\nx --> y\n   ```\n\ntail\n')
  assert.match(x1, /&lt;!-- typo/)
  assert.match(x1, /x --&gt; y|x --> y/)
  const x2 = render('- <!-- typo\n```\ncode\n    ```\nx --> y\n```\n')
  assert.match(x2, /&lt;!-- typo/)
  assert.match(x2, /code/)
  assert.equal(render('<!--\n- a\n  - b\n    ```\n    x\n    ```\n-->\n\nKept.\n'), '<p>Kept.</p>\n')
  const x4 = render('<!-- typo\n\n```\ncode\n   ```\n\n```\nx --> y\n```\n')
  assert.match(x4, /&lt;!-- typo/)
  assert.match(x4, /code/)
})

test('a fence closes where markdown-it closes it, whatever stands inside its container', () => {
  // A closed comment in a list item hides a fence less indented than the
  // item, even when a line five columns in looks like a closer.
  assert.equal(render('- a\n  <!--\n```\n     ```\n```\n-->\n\nKept.\n'), '<ul>\n<li>a</li>\n</ul>\n<p>Kept.</p>\n')
  // A fence opened two columns in is not closed five columns in, so the
  // "-->" lies inside it and the opener stays visible.
  const out = render('<!-- typo\n    ```\n  ```js\n     ```\nx --> y\n')
  assert.match(out, /&lt;!-- typo/)
  assert.match(out, /x --> y|x --&gt; y/)
})

test('a comment whose closer lies in a fence inside a list item keeps the opener visible', () => {
  // Each source renders as it does without the comment rules: the opener is
  // text, the list keeps its items, and the fence keeps its content. The
  // fence ends with its item, or holds a line two or three columns past its
  // opener, or sits in a nested item, a quote, or a list item whose own
  // content is the comment.
  const cases = [
    '<!-- typo\n- a\n  ```\n  code\n```\nx --> y\n```\n\ntail\n',
    '<!-- typo\n- a\n  ```\n  code\n- b\n\n```\nx --> y\n```\n\ntail\n',
    '<!-- typo\n- a\n  - b\n      ```\n      code\n        ```\n      x --> y\n      ```\n- c\n',
    '<!-- typo\n- a\n  - b\n      ```\n      code\n         ```\n      x --> y\n      ```\n- c\n',
    '- <!-- typo\n  - b\n    ```\n    code\n  ```\n  x --> y\n  ```\n',
    '> <!-- typo\n> - a\n>   ```\n>   code\n> ```\n> x --> y\n> ```\n'
  ]
  for (const src of cases) {
    const out = render(src)
    assert.match(out, /&lt;!-- typo/, src)
    assert.equal(out, renderPlain(src), src)
  }
})

test('a comment whose closer lies in an indented code block that holds a fence line keeps the opener visible', () => {
  // Such a block is a fence indented too far. One without a fence line is
  // code that the comment hides, and a closer after the block hides it too.
  const cases = [
    '<!-- typo\n- a\n\n      ```js\n      x --> y\n',
    '<!-- typo\n\n    ~~~\n    x --> y\n',
    '<!-- typo\n\n    code\n    ```\n    x --> y\n',
    '<!-- typo\n\n    code\n      ~~~\n    x --> y\n'
  ]
  for (const src of cases) {
    const out = render(src)
    assert.match(out, /&lt;!-- typo/, src)
    assert.equal(out, renderPlain(src), src)
  }
  assert.equal(render('<!-- typo\n\n    code --> x\n\n```\nf\n```\n').includes('typo'), false)
  assert.equal(render('<!-- note\n\n    ```\n    old\n\n-->\n\nKept.\n'), '<p>Kept.</p>\n')
  // Only a line that starts with the run makes a block a misindented fence.
  assert.equal(render('<!-- typo\n\n    echo ``` x --> y\n\ntail\n'), '<p>y</p>\n<p>tail</p>\n')
})

test('the second parse of a page leaves its reference definitions alone', () => {
  // A definition inside a comment is hidden, so a link that uses it stays
  // text, even though the second parse sees the definition.
  const out = render('<!-- a\n\n[x]: https://example.com/x\n\nb -->\n\n```\nf\n```\n\nsee [x]\n')
  assert.ok(!out.includes('<a '), out)
  assert.match(out, /see \[x\]/)
  // Also when the page already has definitions before the comment.
  const after = render('[y]: https://example.com/y\n\n<!-- a\n\n[x]: https://example.com/x\n\nb -->\n\n```\nf\n```\n\nsee [x] and [y]\n')
  assert.ok(!after.includes('example.com/x'), after)
  assert.match(after, /see \[x\] and <a href="https:\/\/example.com\/y"/)
})

test('the second parse of a page keeps the page path, so a snippet line next to a comment and a fence renders', () => {
  // The snippet rule resolves its file from the page path in the env while
  // the page is parsed, the second parse included.
  const dir = mkdtempSync(join(tmpdir(), 'comments-snippet-'))
  try {
    writeFileSync(join(dir, 'snippet.js'), 'const fromSnippet = 1\n')
    const env = { path: join(dir, 'page.md'), realPath: join(dir, 'page.md') }
    const src = '<!-- a\nb -->\n\n```\nf\n```\n\n<<< ./snippet.js\n\ntail\n'
    const out = render(src, env)
    assert.match(out, /fromSnippet/)
    assert.match(out, /tail/)
    assert.ok(!out.includes('<!--') && !out.includes('&lt;!--'), out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the closer is looked up among all the fences of a page', () => {
  // Four fences with prose between them. A closer in any fence keeps the
  // opener visible; a closer in the prose before the first fence, between two
  // fences, or after the last one hides the comment up to it.
  const page = (closeIn) => {
    const lines = ['<!-- typo', '']
    for (let k = 1; k <= 4; k++) lines.push('```', 'fence' + k + (k === closeIn ? ' -->' : ''), '```', '', 'between' + k, '')
    lines.push('after', '')
    return lines
  }
  for (const k of [1, 2, 3, 4]) {
    const src = page(k).join('\n')
    const out = render(src)
    assert.match(out, /&lt;!-- typo/, src)
    assert.equal(out, renderPlain(src), src)
  }
  for (const [at, hidden, shown] of [[1, 'typo', 'fence1'], [6, 'fence1', 'fence2'], [12, 'fence2', 'fence3'], [18, 'fence3', 'fence4'], [24, 'fence4', 'after']]) {
    const lines = page(0)
    lines[at] += ' -->'
    const out = render(lines.join('\n'))
    assert.ok(!out.includes(hidden), `closer on line ${at} leaves ${hidden} shown`)
    assert.ok(out.includes(shown), `closer on line ${at} hides ${shown}`)
  }
  // A closer on the line a fence opens on stays inside that fence.
  const info = '<!-- typo\n\n~~~ x --> y\ncode\n~~~\n\ntail\n'
  assert.match(render(info), /&lt;!-- typo/)
  assert.equal(render(info), renderPlain(info))
})

test('a page is parsed again for its fences only when a comment spans lines on a page with a fence line', (t) => {
  const parse = t.mock.method(md.block, 'parse')
  const parses = (src) => {
    parse.mock.resetCalls()
    render(src)
    return parse.mock.callCount()
  }
  // The render itself is one parse.
  assert.equal(parses('<!-- one line -->\n\n```\ncode\n```\n'), 1)
  assert.equal(parses('<!-- two\nlines -->\n\ntext\n'), 1)
  assert.equal(parses('<!-- two\nlines -->\n\n~~~\ncode\n~~~\n'), 2)
  assert.equal(parses('<!-- two\nlines -->\n\n```\ncode\n```\n'), 2)
  // Once for the page, however many comments it holds.
  assert.equal(parses('<!-- a\nb -->\n\n```\nx\n```\n\n<!-- c\nd -->\n\n<!-- e\nf -->\n'), 2)
  // Inside text it is the same: a comment on one line looks up no fence, even
  // when it starts its line, and one that spans lines looks one up once for
  // the page, even when its closer starts a line.
  assert.equal(parses('a <!-- one --> b\n\n```\ncode\n```\n'), 1)
  assert.equal(parses('a\n<!-- one --> b\n\n```\ncode\n```\n'), 1)
  assert.equal(parses('a <!-- two\nlines --> b\n\n```\ncode\n```\n'), 2)
  assert.equal(parses('a <!-- two\n--> b\n\n```\ncode\n```\n'), 2)
  assert.equal(parses('a <!-- two\nlines --> b <!-- c\nd --> e\n\n```\ncode\n```\n\nf <!-- g\nh --> i\n'), 2)
})

// The words a page shows, with entities decoded and markup dropped.
const words = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(lt|#x3C);/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split(/\s+/)
    .filter(Boolean)

// Without the comment rules every word of the page is shown. With them, only
// the words of the comments that are hidden are gone, and nothing else.
const assertOnlyHiddenLost = (src, hidden) => {
  const left = words(render(src))
  const lost = []
  for (const w of words(renderPlain(src))) {
    const at = left.indexOf(w)
    if (at !== -1) left.splice(at, 1)
    else lost.push(w)
  }
  assert.deepEqual(lost.sort(), [...hidden].sort(), src)
}

test('an earlier hidden comment that regroups the lines does not let a later opener hide a fence', () => {
  // The first comment closes inside its list item and hides two lines, which
  // ends the item. The lines after it then form one paragraph that holds the
  // opener and the lines of a fence that markdown-it finds without the comment
  // rules. The "-->" in that fence does not close the opener: the opener stays
  // visible and no word of the fence is lost.
  const hidden = ['<!--', 'a', 'b', '-->']
  const cases = [
    '1. <!-- a\nb --> z\n<!-- typo\n10. item\n    ```\n    x --> y\n    ```\n',
    '1. <!-- a\nb --> z\n<!-- typo\n10. item\n    ~~~\n    x --> y\n    ~~~\n',
    '1. <!-- a\nb --> z\n<!-- typo\n10. item\n    ```\n    x --> y\n',
    '> 1. <!-- a\n> b --> z\n> <!-- typo\n> 10. item\n>     ```\n>     x --> y\n>     ```\n'
  ]
  for (const src of cases) {
    assert.match(render(src), /&lt;!-- typo/, src)
    assert.match(render(src), /x --&gt; y/, src)
    assertOnlyHiddenLost(src, hidden)
  }
  // With the closer after the fence, the comment closes there and is hidden
  // together with the fence lines it spans.
  const closed = '1. <!-- a\nb --> z\n<!-- typo\n10. item\n    ```\n    x\n    ```\n    --> y\n'
  assert.ok(!render(closed).includes('typo'))
  assert.ok(!render(closed).includes('item'))
})

test('a hidden comment that ends a list item does not let a later opener hide a nested fence', () => {
  // The comment at the start of the first line runs over the item's second
  // line, so the lines below it are no longer part of the list. The opener
  // there and the lines of the fence in a nested item form one paragraph.
  const hidden = ['<!--', 'one', 'k', '-->']
  for (const src of [
    '<!--\n  1) one\nk --> z\n  <!-- typo\n       - sub\n         ````\n         x --> y\n',
    '<!--\n  1) one\nk --> z\n  <!-- typo\n       - sub\n         ````\n         x --> y\n         ````\n'
  ]) {
    assert.match(render(src), /&lt;!-- typo/, src)
    assert.match(render(src), /x --&gt; y/, src)
    assertOnlyHiddenLost(src, hidden)
  }
})

test('a comment in a paragraph that no fence holds the closer of is hidden', () => {
  assert.equal(render('a <!-- x\ny --> b\n\n```\nf\n```\n').startsWith('<p>a  b</p>\n'), true)
  assert.equal(render('1. <!-- a\nb --> z\n<!-- c\nd --> e\n'), '<ol>\n<li>z</li>\n</ol>\n<p>e</p>\n')
})

test('a table cell with a comment is not given a paragraph line', () => {
  // Cell text has no source lines of its own to look up.
  const out = render('| a | b |\n|---|---|\n| c <!-- x --> | d |\n\n```\nf\n```\n')
  assert.ok(!out.includes('x -->') && !out.includes('x --&gt;'), out)
  assert.match(out, /<td>c\s*<\/td>/)
})

test('an env used for another page does not hand over the fences of the first page', () => {
  // The first page has a fence on lines 2 to 4. The second page has none there,
  // and its "-->" is on line 3, so the comment closes there.
  const env = { relativePath: 'fixture.md' }
  const first = '<!-- typo\n\n```\nx --> y\n```\n'
  const second = '<!-- typo\n\nbetween\nx --> y\n\n```\nf\n```\n'
  assert.match(md.render(first, env), /&lt;!-- typo/)
  assert.ok(!md.render(second, env).includes('typo'))
})

test('text that is not a paragraph of the page has no fence to look up', () => {
  // A plugin can parse text of its own into a token array of its own, which
  // the page's paragraphs do not use.
  const tokens = []
  md.inline.parse('a <!-- x\ny --> b', md, {}, tokens)
  assert.deepEqual(tokens.map((t) => t.content), ['a  b'])
})

test('a closer on the line a fence opens on is found among many lines', () => {
  // The info string of the fence holds the "-->". The paragraph has enough
  // lines for the search for the closer's line to take several steps.
  const src = '1. <!-- a\nb --> z\n<!-- typo\n10. item\n    more\n    ``` x --> y\n    code\n    code\n    code\n    ```\n'
  // The page shows the info string as text, so only the first comment's
  // words are missing from it.
  assert.match(render(src), /&lt;!-- typo/)
  assertOnlyHiddenLost(src, ['<!--', 'a', 'b'])
})

test('a closer on the last line of a paragraph is found on that line', () => {
  // The fence opens on the paragraph's second and last line and runs to the
  // end of the page, so the line after the paragraph is not in it.
  const src = '1. <!-- a\nb --> z\n<!-- typo\n    ``` x --> y\n'
  assert.match(render(src), /&lt;!-- typo/)
  assertOnlyHiddenLost(src, ['<!--', 'a', 'b'])
})

test('the fences of a page are looked up once however many openers it holds', () => {
  // An opener on each of 3000 lines, none of them closed before a fence.
  const src = '1. <!-- a\nb --> z\n' + '<!-- typo\n'.repeat(3000) + '10. item\n    ```\n    x --> y\n    ```\n'
  const out = render(src)
  assert.equal(out.split('&lt;!-- typo').length - 1, 3000)
  assert.match(out, /x --&gt; y/)
})

test('the lines of a paragraph are found once, not once per opener', (t) => {
  // Each of the 400 openers is refused because its closer lies in the fence
  // below. The line starts of the paragraph come from one pass over its text
  // however many openers ask; a pass for each opener would make about 400
  // times as many searches for a newline.
  const lines = 400
  const src = '1. <!-- a\nb --> z\n' + '<!-- typo\n'.repeat(lines) + '10. item\n    ```\n    x --> y\n    ```\n'
  const indexOf = t.mock.method(String.prototype, 'indexOf')
  const out = render(src)
  const searches = indexOf.mock.calls.filter((c) => c.arguments[0] === '\n' && String(c.this).startsWith('<!-- typo\n<!-- typo'))
  assert.equal(out.split('&lt;!-- typo').length - 1, lines)
  assert.ok(searches.length < 3 * lines, `${searches.length} searches for a newline`)
  assert.ok(searches.length > 0)
})

test('a quote that becomes an alert does not shift the lines of its first paragraph', () => {
  // VitePress takes the "[!NOTE]" line out of the first paragraph of a quote
  // without changing the lines that paragraph spans. The paragraph below holds
  // a list item with an opener and a fence, after a hidden comment that ends
  // the first item. The alert must treat the opener as the plain quote does.
  const shown = (marker, tail) =>
    `> 1. <!-- a\n> b -->\n> ${marker}\n> 10. item <!-- typo\n${tail}`
  const fenceInfo = '>     ``` x --> y\n>     code\n>     ```\n'
  for (const marker of ['[!NOTE]', '[!WARNING] Heads up', 'plain']) {
    const src = shown(marker, fenceInfo)
    assert.match(render(src), /&lt;!-- typo/, src)
    assert.match(render(src), /x --&gt; y/, src)
    // The fence's info string is shown by the page and dropped by the plain
    // renderer, so only the first comment and the alert marker are missing.
    assertOnlyHiddenLost(src, ['<!--', 'a', 'b', ...(marker === 'plain' ? [] : [marker.split(' ')[0]])])
  }
  // The alert and the plain quote show the same paragraph.
  const para = (src) => render(src).match(/<p>(?:plain\n)?10\. item[\s\S]*?<\/p>/)[0].replace('<p>plain\n', '<p>')
  assert.equal(para(shown('[!NOTE]', fenceInfo)), para(shown('plain', fenceInfo)))
})

test('a quote that becomes an alert still hides a comment that closes after a fence', () => {
  // The closer lies on the line after the fence, so the comment closes there
  // and is hidden, in the alert as in the plain quote.
  const after = '>     ```\n>     code\n>     ```\n>     --> y\n'
  for (const marker of ['[!NOTE]', '[!CAUTION] Careful', 'plain']) {
    const src = `> 1. <!-- a\n> b -->\n> ${marker}\n> 10. item <!-- typo\n${after}`
    const out = render(src)
    assert.ok(!out.includes('typo') && !out.includes('code'), src)
    assert.match(out, /10\. item {2}y/, src)
  }
})

test('text rendered inline with blank lines finds the line of a closer relative to its fences', () => {
  // Inline rendering takes the whole text as one paragraph, so it can hold a
  // blank line. The closer is on the line a fence opens on.
  const text = 'a <!-- x\n\nb\n``` y --> z\nc\n```'
  const out = md.renderInline(text, { relativePath: 'fixture.md' })
  assert.match(out, /&lt;!-- x/)
  assert.match(out, /y --&gt; z/)
  // A blank line after the closer's line, which lies just before a fence: the
  // fence starts on the line after the closer, so a miscount of the lines
  // that follow would put the closer in it.
  const closed = md.renderInline('a <!-- x\nb --> y\n```\nc\n\nd\n```', { relativePath: 'fixture.md' })
  assert.ok(!closed.includes('x') && !closed.includes('&lt;!--'), closed)
})
