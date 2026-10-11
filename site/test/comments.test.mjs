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
  const out = render('first mentions \\<!-- here\n\nmiddle paragraph\n\nlast closes --> there\n')
  assert.match(out, /first mentions/)
  assert.match(out, /middle paragraph/)
  assert.match(out, /last closes/)
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
  return flat(md.parse(src, { relativePath: 'fixture.md' })).filter((t) => /^html_/.test(t.type))
}

test('a line starting with a custom element or component renders as escaped text', () => {
  // VitePress parses these lines as components, which the Vue compiler
  // would turn into live elements and props.
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
