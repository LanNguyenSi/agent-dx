import os from 'node:os'
import path from 'node:path'
import { markdownBase } from '../../../../.vitepress/site-helpers.mjs'
import { escapeDescriptionMeta, transformPageData } from '../../../../.vitepress/raw-output.mjs'

// A small site built with the real markdown options, to check the built HTML.
// The test passes its own cache directory so that runs do not share one.
export default {
  title: 'hardening fixture',
  markdown: markdownBase,
  transformHtml: escapeDescriptionMeta,
  transformPageData,
  lastUpdated: false,
  // Pages under /nav/ get a previous/next footer from this sidebar.
  themeConfig: {
    sidebar: {
      '/nav/': [
        { text: 'One', link: '/nav/one' },
        { text: 'Two', link: '/nav/two' },
        { text: 'Three', link: '/nav/three' }
      ]
    }
  },
  cacheDir: process.env.AGENT_DX_HARDENING_CACHE ?? path.join(os.tmpdir(), `agent-dx-site-hardening-cache-${process.pid}`)
}
