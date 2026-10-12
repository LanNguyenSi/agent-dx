// Renders fixtures through the site's real markdown configuration and checks
// that HTML comments are dropped without losing any other content.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkdownRenderer, resolveConfig } from 'vitepress'

let md
before(async () => {
  const cfg = await resolveConfig('.')
  md = await createMarkdownRenderer(cfg.srcDir, cfg.userConfig.markdown, cfg.site.base)
})
const render = (src) => md.render(src, { relativePath: 'fixture.md' })

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
