// With markdown `html: true`, markdown-it itself decides what is an HTML
// comment (never inside code blocks, code spans, or fences). These renderer
// rules drop comments and render any other raw HTML as escaped text, so
// placeholders like <version> stay literal text and nothing else is lost.
const COMMENT = /<!--[\s\S]*?-->/g

export function htmlComments(md) {
  // Raw HTML from the source always starts with "<"; other html_inline
  // tokens (the heading anchor entity) are generated markup and pass through.
  md.renderer.rules.html_inline = (tokens, idx) => {
    const { content } = tokens[idx]
    return content.startsWith('<') ? md.utils.escapeHtml(content.replace(COMMENT, '')) : content
  }
  md.renderer.rules.html_block = (tokens, idx) => {
    const rest = tokens[idx].content.replace(COMMENT, '').trim()
    return rest ? `<p>${md.utils.escapeHtml(rest)}</p>\n` : ''
  }
}
