// VitePress turns every page into a Vue single-file component and writes the
// page data (frontmatter, title, description, headings) into its <script>
// block as a JSON string literal. A "</script" in any of that text, in any
// letter case and with or without a closing ">", ends the block early, and the
// build fails with parser errors that do not name the page. A "<!--" or a
// "<script" in the same text is not safe either. The data must reach the page
// as written, so it is not escaped with entities; the "<" of the string
// literal is written as the JavaScript escape < instead, which reads back
// as the same character.
//
// transformPageData cannot do this: it sees the data before VitePress
// serialises it, and any text it changes would show up changed on the page.
// The serialised literal is only visible in the generated component, and that
// is produced by the "vitepress" plugin itself, one step before the Vue
// plugin parses it. No plugin ordering puts a site plugin between the two, so
// the site wraps the transform of the "vitepress" plugin. If the plugin or its
// transform is not found (a VitePress upgrade moved it), the build fails with
// a message instead of going on without the guard.

// A JavaScript string literal as JSON.stringify writes it: every quote and
// backslash inside is escaped, so the first unescaped quote ends it.
const literal = '"(?:[^"\\\\]|\\\\.)*"'

// The two places VitePress writes page text into the component script: the
// page data, and the component name taken from the page path.
const pageDataLiteral = new RegExp(`(export const __pageData = JSON\\.parse\\()(${literal})`)
const nameLiteral = new RegExp(`(export default \\{name:)(${literal})`)

const escapeAngle = (stringLiteral) => stringLiteral.replace(/</g, '\\u003c')

// Rewrites the generated component source. Returns the source unchanged when
// it holds neither literal (a page that is not a Markdown page).
export function escapeScriptLiterals(code) {
  return code
    .replace(pageDataLiteral, (_, head, text) => head + escapeAngle(text))
    .replace(nameLiteral, (_, head, text) => head + escapeAngle(text))
}

const pluginName = 'vitepress'

// A Vite plugin for the site config. It wraps the transform of the VitePress
// page plugin once the plugin list is known.
export function scriptSafePageData() {
  return {
    name: 'agent-dx-script-safe-page-data',
    configResolved(config) {
      const target = config.plugins.find((p) => p.name === pluginName)
      const hook = target?.transform
      const handler = typeof hook === 'function' ? hook : hook?.handler
      if (typeof handler !== 'function') {
        throw new Error(`agent-dx site: the "${pluginName}" Vite plugin has no transform to guard; page data would not be made safe for the generated <script> block`)
      }
      const guarded = async function (...args) {
        const result = await handler.apply(this, args)
        if (typeof result === 'string') return escapeScriptLiterals(result)
        if (result && typeof result.code === 'string') return { ...result, code: escapeScriptLiterals(result.code) }
        return result
      }
      if (typeof hook === 'function') target.transform = guarded
      else hook.handler = guarded
    }
  }
}
