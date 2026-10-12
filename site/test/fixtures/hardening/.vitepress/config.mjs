import os from 'node:os'
import path from 'node:path'
import { markdownBase } from '../../../../.vitepress/site-helpers.mjs'
import { escapeDescriptionMeta } from '../../../../.vitepress/raw-output.mjs'

// A small site built with the real markdown options, to check the built HTML.
// The test passes its own cache directory so that runs do not share one.
export default {
  title: 'hardening fixture',
  markdown: markdownBase,
  transformHtml: escapeDescriptionMeta,
  lastUpdated: false,
  cacheDir: process.env.AGENT_DX_HARDENING_CACHE ?? path.join(os.tmpdir(), `agent-dx-site-hardening-cache-${process.pid}`)
}
