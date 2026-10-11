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
