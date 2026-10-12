// Author-controlled Markdown must not reach the rendered page as live HTML or
// as a compiled Vue template. Raw HTML is already off (markdownBase.html), and
// VitePress escapes most text itself. These are the places where its default
// renderer writes author text out unescaped, and what this plugin does there:
//
//   - fence info string: the language is written into a class attribute and a
//     visible label as typed. The whole info string is HTML-escaped.
//   - code-group tab titles ("```js [title]"): the title is written into the tab
//     label as typed. It is escaped, and a doubled escape in data-title undone.
//   - GitHub alert titles ("> [!NOTE] title"): the title is written as typed.
//     It is escaped.
//   - mustache: "{{ ... }}" in prose, headings, inline code, table cells,
//     container titles and indented code is compiled by Vue as an expression.
//     Every "{{" in that output is written as two numeric references, which
//     Vue decodes to text instead of reading as an interpolation. Fenced code
//     is already v-pre and is not touched.
//   - env.title: the text of the first h1, handed to page data. It is escaped
//     the way the sidebar titles are (escapeText in site-helpers.mjs).
//
// Attribute names from markdown-it-attrs are limited by markdownBase.attrs
// (see allowedAttributes below), not here.

// Attributes a "{...}" block may set. Event handlers and everything else are
// dropped by markdown-it-attrs. The shipped playbooks use none; "{#id}" and
// "{.class}" are kept for future headings and blocks. VitePress reads the line
// ranges of a code fence ("js{1,3}") as an attribute whose name is the range,
// so a name made only of digits, commas and hyphens is kept as well.
export const allowedAttributes = ['id', 'class', /^[\d,-]+$/]

// Escapes & < > " in text; an entity reference written in the source stays as
// written, so an entity is escaped once, never twice.
export const escapeText = (text) =>
  text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/&(?![\w#]+;)/g, '&amp;')

// Vue reads "{{" in a template text as the start of an expression. Two numeric
// references are decoded to the same two characters as text and never start one.
export const defuseMustache = (html) => html.replace(/\{\{/g, '&#123;&#123;')

// "lang {1,3} [title]": the title is the text between the first "[" and the
// last "]", as VitePress reads it. A mustache is defused only in the title,
// since the language and the line ranges are cut at "{" before they are shown.
function escapeInfo(info) {
  const m = /^([^[]*)\[(.*)\](.*)$/.exec(info)
  if (!m) return escapeText(info)
  return `${escapeText(m[1])}[${defuseMustache(escapeText(m[2]))}]${escapeText(m[3])}`
}

export function rawOutput(md) {
  // The fence renderer and the code-group renderer read the info string at
  // render time. This rule runs after every block and attribute rule has seen
  // the original text and before any renderer reads it.
  md.core.ruler.push('agent-dx-escape-fence-info', (state) => {
    for (const tok of state.tokens) {
      if (tok.type === 'fence') tok.info = escapeInfo(tok.info)
    }
  })

  // The tab label gets the escaped title; its data-title attribute is escaped
  // once more by VitePress, so one level is taken off again.
  const codeGroup = md.renderer.rules['container_code-group_open']
  if (codeGroup) {
    md.renderer.rules['container_code-group_open'] = (...args) =>
      codeGroup(...args).replace(/ data-title="([^"]*)"/g, (_, v) => ` data-title="${v.replace(/&amp;(?=[\w#]+;)/g, '&')}"`)
  }

  const alert = md.renderer.rules.github_alert_open
  if (alert) {
    md.renderer.rules.github_alert_open = (tokens, idx, ...rest) => {
      // The original token keeps its title, so a second render starts from it.
      const token = tokens[idx]
      const escaped = Object.assign(Object.create(Object.getPrototypeOf(token)), token, {
        meta: { ...token.meta, title: defuseMustache(escapeText(token.meta.title)) }
      })
      return alert([escaped], 0, ...rest)
    }
  }

  const renderInline = md.renderer.renderInline.bind(md.renderer)
  md.renderer.renderInline = (tokens, options, env) => defuseMustache(renderInline(tokens, options, env))

  // An indented code block is not v-pre, unlike a fenced one.
  const codeBlock = md.renderer.rules.code_block
  md.renderer.rules.code_block = (...args) => defuseMustache(codeBlock(...args))

  const render = md.renderer.render.bind(md.renderer)
  md.renderer.render = (tokens, options, env) => {
    const html = render(tokens, options, env)
    // VitePress sets env.title while it renders; this wrapper runs after it.
    if (typeof env.title === 'string') env.title = escapeText(env.title)
    return html
  }
}
