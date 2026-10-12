// Builds a one-page site from hostile Markdown with the site's real markdown
// options and checks the HTML that comes out: nothing the author wrote becomes
// a tag or an event handler, and a mustache is shown as text, not evaluated
// while the page is rendered.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vitepress'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hardening')
let out
let html
before(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dx-site-hardening-'))
  await build(root, { outDir: out })
  html = fs.readFileSync(path.join(out, 'index.html'), 'utf8')
})
after(() => fs.rmSync(out, { recursive: true, force: true }))

// The page content, without the head and the script tags VitePress writes.
const body = () => html.slice(html.indexOf('<main'), html.indexOf('</main>'))

test('author text becomes no tag and no event handler', () => {
  const stripped = body().replace(/="[^"]*"/g, '=""')
  assert.doesNotMatch(stripped, /<img|<b>|<b |<script/)
  assert.doesNotMatch(stripped, /<[a-z][^>]*\son\w+=/)
  assert.match(body(), /<span class="lang">&lt;img\/src/)
  assert.match(body(), /<p class="custom-block-title">&lt;img src=x onerror=alert&gt;/)
  assert.match(body(), /for="[^"]+">&lt;img src=x onerror=tab&gt;/)
})

test('a curly block keeps its class and drops its event handler', () => {
  assert.match(body(), /<p class="keep">Handler text<\/p>/)
  assert.doesNotMatch(body(), /onclick/)
})

test('a mustache is shown as text in every place, not evaluated', () => {
  for (const marker of ['title', 'prose', 'code', 'indented', 'tab', 'alert']) {
    assert.ok(body().includes(`{{ constructor.constructor(&#39;${marker}&#39;)() }}`), `${marker}: ${body()}`)
  }
})

test('the page title is escaped text', () => {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]
  assert.ok(title?.startsWith('Title &lt;b&gt;bold&lt;/b&gt; &amp; &quot;q&quot; {{'), title)
})
