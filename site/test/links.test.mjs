// Regression checks for the link mapper, titles and sidebar. The mapper and
// titles run against a fixture tree; the sidebar check runs on the real repo.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSite, titleFromText, githubBase } from '../.vitepress/site-helpers.mjs'

let root
let site
const AE = 'packages/agent-engineering-playbook'
const write = (rel, text = '# T\n') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-links-'))
  write(`${AE}/README.md`)
  write(`${AE}/guide.md`)
  write(`${AE}/withreadme/README.md`)
  write(`${AE}/withreadme/page.md`)
  write(`${AE}/noreadme/page.md`)
  write(`${AE}/config.yaml`, 'a: 1\n')
  write('packages/other/README.md')
  write('docs/note.md')
  site = createSite(root)
})
after(() => fs.rmSync(root, { recursive: true, force: true }))

const from = `${AE}/guide.md`
const map = (href, f = from) => site.mapLink(href, f)

test('link to a README becomes the index page', () => {
  assert.equal(map('withreadme/README.md'), 'withreadme/index.md')
  assert.equal(map('./README.md'), './index.md')
})

test('directory with a README links to the folder page, without one to GitHub', () => {
  assert.equal(map('withreadme/'), '/agent-engineering-playbook/withreadme/')
  assert.equal(map('noreadme'), `${githubBase}/tree/master/${AE}/noreadme`)
})

test('existing non-markdown target goes to the GitHub blob URL', () => {
  assert.equal(map('config.yaml'), `${githubBase}/blob/master/${AE}/config.yaml`)
})

test('markdown outside the playbooks goes to GitHub, a playbook page stays', () => {
  assert.equal(map('../../docs/note.md'), `${githubBase}/blob/master/docs/note.md`)
  assert.equal(map('../other/README.md'), `${githubBase}/blob/master/packages/other/README.md`)
  assert.equal(map('withreadme/page.md'), 'withreadme/page.md')
})

test('hash and query survive the rewrite', () => {
  assert.equal(map('withreadme/README.md#intro'), 'withreadme/index.md#intro')
  assert.equal(map('config.yaml?plain=1#L3'), `${githubBase}/blob/master/${AE}/config.yaml?plain=1#L3`)
  assert.equal(map('withreadme/#x'), '/agent-engineering-playbook/withreadme/#x')
  assert.equal(map('#local'), '#local')
  assert.equal(map('https://example.com/a.md'), 'https://example.com/a.md')
})

test('dead target fails and names file and href', () => {
  assert.throws(() => map('missing.md'), (e) => e.message.includes(from) && e.message.includes('missing.md'))
})

test('link escaping the repository fails and names file and href', () => {
  const href = '../../../../outside.ts'
  assert.throws(() => map(href), (e) => e.message.includes(from) && e.message.includes(href))
  assert.throws(() => map('../../..'), /outside the repository/)
})

test('titleOf: an inner shorter fence does not close an outer fence', () => {
  const src = '````md\n```js\n# not a title\n```\n# still code\n````\n\n# Real\n'
  assert.equal(titleFromText(src, 'fb'), 'Real')
})

test('titleOf: closing fence must use the same character', () => {
  assert.equal(titleFromText('~~~\n```\n# code\n~~~\n# Real\n', 'fb'), 'Real')
  assert.equal(titleFromText('```\n~~~\n# code\n```\n# Real\n', 'fb'), 'Real')
})

test('titleOf: setext H1 is recognised, ATX and fallback still work', () => {
  assert.equal(titleFromText('Setext *Title*\n==========\n\ntext\n', 'fb'), 'Setext Title')
  assert.equal(titleFromText('---\nx: 1\n---\n# Atx Title #\n', 'fb'), 'Atx Title')
  assert.equal(titleFromText('no heading\n', 'fb'), 'fb')
  assert.equal(titleFromText('```\nCode\n====\n```\n', 'fb'), 'fb')
})

test('sidebar links every playbook page exactly once', () => {
  const real = createSite(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
  const links = []
  const collect = (items) => {
    for (const i of items) {
      if (i.link) links.push(i.link)
      if (i.items) collect(i.items)
    }
  }
  for (const pb of ['agent-engineering-playbook', 'agentic-coding-playbook']) collect(real.sidebarFor(pb))
  const expected = real.pages.map((p) => {
    const s = real.rewrites[p].replace(/\.md$/, '')
    return '/' + (/(^|\/)index$/.test(s) ? s.replace(/index$/, '') : s)
  })
  assert.ok(expected.length > 0)
  assert.deepEqual([...links].sort(), [...expected].sort())
  assert.equal(new Set(links).size, links.length)
})
