import os from 'node:os'
import path from 'node:path'
import { markdownBase } from '../../../../.vitepress/site-helpers.mjs'

// A one-page site built with the real markdown options, to check the built HTML.
export default {
  title: 'hardening fixture',
  markdown: markdownBase,
  lastUpdated: false,
  cacheDir: path.join(os.tmpdir(), 'agent-dx-site-hardening-cache')
}
