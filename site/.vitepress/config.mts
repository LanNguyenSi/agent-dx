import { defineConfig } from 'vitepress'
import type MarkdownIt from 'markdown-it'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { htmlComments } from './html-comments.mjs'
import { createSite, githubBase } from './site-helpers.mjs'

// The site is built from the Markdown in place. srcDir is the repository
// root, and only the two playbooks plus site/index.md are pages.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const { rewrites, mapLink, sidebarFor } = createSite(repoRoot)

function linkMapper(md: MarkdownIt) {
  md.use(htmlComments)
  md.core.ruler.push('agent-dx-links', (state) => {
    const rel = (state.env.relativePath as string | undefined) ?? ''
    // env.relativePath is the rewritten path; find the source file again.
    const source = Object.keys(rewrites).find((k) => rewrites[k] === rel)
    if (!source || source === 'site/index.md') return
    for (const blk of state.tokens) {
      for (const t of blk.children ?? []) {
        const attr = t.type === 'link_open' ? 'href' : t.type === 'image' ? 'src' : ''
        if (!attr) continue
        const v = t.attrGet(attr)
        if (v) t.attrSet(attr, mapLink(v, source))
      }
    }
  })
}

export default defineConfig({
  title: 'agent-dx playbooks',
  description: 'Agent Engineering Playbook and Agentic Coding Playbook from agent-dx',
  base: '/agent-dx/',
  srcDir: '..',
  // Only the two playbooks and the site home page are pages.
  srcExclude: ['*.md', '!(packages|site)/**', 'packages/!(agent-engineering-playbook|agentic-coding-playbook)/**', 'site/!(index.md)', '.*/**'],
  rewrites,
  cleanUrls: true,
  // The Markdown lives outside site/, so bare imports compiled into those
  // pages (vue, vue/server-renderer) cannot find site/node_modules by walking
  // up from the page file. Resolve them from this config file instead.
  vite: {
    plugins: [
      {
        name: 'agent-dx-resolve-vue-from-site',
        enforce: 'pre',
        async resolveId(id, importer, options) {
          if (!/^vue(\/|$)/.test(id) || !importer?.startsWith(repoRoot + path.sep + 'packages' + path.sep)) return null
          return this.resolve(id, fileURLToPath(import.meta.url), { ...options, skipSelf: true })
        }
      }
    ]
  },
  lastUpdated: false,
  // Raw HTML stays off so that placeholders like <version> render as text; HTML
  // comments in the playbooks are hidden by the htmlComments rules above.
  markdown: { html: false, config: linkMapper },
  themeConfig: {
    search: { provider: 'local' },
    nav: [
      { text: 'Agent Engineering', link: '/agent-engineering-playbook/' },
      { text: 'Agentic Coding', link: '/agentic-coding-playbook/' }
    ],
    sidebar: {
      '/agent-engineering-playbook/': sidebarFor('agent-engineering-playbook'),
      '/agentic-coding-playbook/': sidebarFor('agentic-coding-playbook')
    },
    socialLinks: [{ icon: 'github', link: githubBase }]
  }
})
