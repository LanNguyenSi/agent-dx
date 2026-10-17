// The pages of the site are the Markdown under the two playbook directories
// plus site/index.md, and nothing else: a page anywhere else would be loaded
// by VitePress, and a dynamic route there would run its paths file at build
// time. This runs VitePress's own page resolution (resolveConfig, which applies
// the srcExclude of the real config with the glob library and options
// VitePress ships) over a tree that holds the allowed pages beside look-alike
// siblings, and compares the page set with the allow-list.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pageExclude } from '../.vitepress/site-helpers.mjs'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AE = 'packages/agent-engineering-playbook'
const AC = 'packages/agentic-coding-playbook'
let work
let scripts = 0

const allowed = [`${AE}/README.md`, `${AE}/a/b.md`, `${AC}/README.md`, `${AC}/c/d.md`, 'site/index.md']

// Pages that must not be pages: names that start like an allowed directory or
// file, other entries beside the allowed ones, and glob characters in names.
const siblings = [
  `${AC}-x/y.md`,
  `${AE}-old/y.md`,
  `${AC}x/y.md`,
  'sitex/y.md',
  'site-x/y.md',
  'packagesX/y.md',
  'packages-x/y.md',
  'site/index.mdx/y.md',
  'site/index.md.d/y.md',
  'site/other.md',
  'site/test/t.md',
  'packages/other/y.md',
  'packages/x.md',
  'docs/z.md',
  'README.md',
  '.hidden/h.md',
  'star*/y.md',
  'q?/y.md',
  '{a,b}/y.md',
  '!bang/y.md',
  '@at/y.md',
  '+plus/y.md',
  '(paren)/y.md',
  'a|b/y.md',
  'sq[x]/y.md',
  `${AC}-[x]/y.md`
]

// A repository of its own under tmp with the real site/.vitepress copied (not
// its cache or output) and site/node_modules linked.
function repoWith(name, files) {
  const repo = path.join(work, name)
  const siteCopy = path.join(repo, 'site')
  fs.cpSync(path.join(site, '.vitepress'), path.join(siteCopy, '.vitepress'), {
    recursive: true,
    filter: (src) => !['cache', 'dist'].includes(path.basename(src))
  })
  fs.copyFileSync(path.join(site, 'package.json'), path.join(siteCopy, 'package.json'))
  fs.symlinkSync(path.join(site, 'node_modules'), path.join(siteCopy, 'node_modules'))
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), '# T\n')
  }
  return { repo, siteCopy }
}

// The pages VitePress resolves for the site copy, sorted.
function resolvedPages(siteCopy) {
  const vitepress = pathToFileURL(path.join(site, 'node_modules/vitepress/dist/node/index.js')).href
  const script = path.join(work, `pages-${scripts++}.mjs`)
  fs.writeFileSync(
    script,
    `import { resolveConfig } from ${JSON.stringify(vitepress)}\n` +
      `const c = await resolveConfig(process.argv[2], 'build', 'production')\n` +
      `console.log(JSON.stringify(c.pages.slice().sort()))\n`
  )
  const r = spawnSync(process.execPath, [script, siteCopy], { cwd: siteCopy, encoding: 'utf8', timeout: 120_000, env: { ...process.env, CI: '1', NO_COLOR: '1' } })
  assert.equal(r.error, undefined, `VitePress did not run: ${r.error}`)
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dx-site-pages-'))
})
after(() => fs.rmSync(work, { recursive: true, force: true }))

test('the pages VitePress resolves are exactly the allowed ones, with look-alike siblings around them', () => {
  const { siteCopy } = repoWith('pages', [...allowed, ...siblings])
  assert.deepEqual(resolvedPages(siteCopy), [...allowed].sort())
})

test('the real tree resolves the same way: only the playbooks and site/index.md', () => {
  const pages = resolvedPages(site)
  assert.ok(pages.includes('site/index.md'))
  assert.ok(pages.length > 1)
  assert.deepEqual(
    pages.filter((p) => !p.startsWith(`${AE}/`) && !p.startsWith(`${AC}/`) && p !== 'site/index.md'),
    []
  )
})

test('pageExclude lists every entry beside an allowed one by its literal name', () => {
  const tree = fs.mkdtempSync(path.join(work, 'tree-'))
  for (const rel of ['packages/agent-engineering-playbook/a.md', 'packages/agentic-coding-playbook/a.md', 'packages/pk[g]/a.md', 'packages/z.md', 'site/index.md', 'site/test/t.md', 'site/a(b).md', 'docs/a.md', 'x.md', 'a b/c.md']) {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true })
    fs.writeFileSync(path.join(tree, rel), '# T\n')
  }
  assert.deepEqual(pageExclude(tree), [
    'a b',
    'a b/**',
    'docs',
    'docs/**',
    'x.md',
    'x.md/**',
    'packages/pk\\[g\\]',
    'packages/pk\\[g\\]/**',
    'packages/z.md',
    'packages/z.md/**',
    'site/a\\(b\\).md',
    'site/a\\(b\\).md/**',
    'site/test',
    'site/test/**'
  ])
})

test('pageExclude of a tree with no entries at all is empty', () => {
  const tree = fs.mkdtempSync(path.join(work, 'bare-'))
  assert.deepEqual(pageExclude(tree), [])
})
