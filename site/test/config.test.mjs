// Checks the loaded site config end to end: the sidebar carries the H1 titles
// of the pages, and the renderer VitePress goes on to build with is its own,
// with the link mapper, not the one the config used to read the titles.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkdownRenderer, resolveConfig } from 'vitepress'
import { githubBase } from '../.vitepress/site-helpers.mjs'

let cfg
before(async () => {
  cfg = await resolveConfig('.')
})

test('sidebar titles come from the first H1 of each page', () => {
  const sidebar = cfg.site.themeConfig.sidebar['/agent-engineering-playbook/']
  assert.deepEqual(sidebar[0], { text: 'Agent Engineering Playbook', link: '/agent-engineering-playbook/' })
  assert.ok(sidebar.some((i) => i.text === 'Contributing' && i.link === '/agent-engineering-playbook/CONTRIBUTING'))
})

test('the build renderer rewrites links after the config was loaded', async () => {
  const md = await createMarkdownRenderer(cfg.srcDir, cfg.userConfig.markdown, cfg.site.base)
  const out = md.render('[root](../../README.md)\n', { relativePath: 'agent-engineering-playbook/index.md' })
  assert.ok(out.includes(`href="${githubBase}/blob/master/README.md"`), out)
})
