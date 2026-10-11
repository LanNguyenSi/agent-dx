// With markdown `html: true`, markdown-it itself decides what is an HTML
// comment (never inside code blocks, code spans, or fences). A core rule then
// works on the tokens, so every later consumer (heading slugs, the table of
// contents, titles, the renderer) only ever sees text: comments are dropped
// and any other raw HTML becomes literal text, so placeholders like <version>
// stay visible and nothing else is lost.
//
// The rule runs before the heading-anchor rule, so the anchor's own permalink
// tokens are generated afterwards and never pass through here.
//
// An unclosed "<!--" opens an HTML block that runs to the end of the file; it
// is kept as visible literal text (nothing is dropped silently).
const COMMENT = /<!--[\s\S]*?-->/g

export function htmlComments(md) {
  md.core.ruler.after('text_join', 'agent-dx-html', (state) => {
    const { Token } = state
    const out = []
    for (const tok of state.tokens) {
      if (tok.type === 'html_block') {
        const rest = tok.content.replace(COMMENT, '').trim()
        if (!rest) continue
        const open = new Token('paragraph_open', 'p', 1)
        open.block = true
        open.map = tok.map
        open.level = tok.level
        const inline = new Token('inline', '', 0)
        inline.block = true
        inline.map = tok.map
        inline.level = tok.level + 1
        inline.content = rest
        inline.children = []
        md.inline.parse(rest, md, { references: state.env.references }, inline.children)
        inline.children = textOnly(inline.children, Token)
        const close = new Token('paragraph_close', 'p', -1)
        close.block = true
        close.level = tok.level
        out.push(open, inline, close)
      } else {
        if (tok.children) tok.children = textOnly(tok.children, Token)
        out.push(tok)
      }
    }
    state.tokens = out
  })
}

function textOnly(children, Token) {
  const out = []
  for (const t of children) {
    if (t.type === 'html_inline') {
      const text = t.content.replace(COMMENT, '')
      if (!text) continue
      const tt = new Token('text', '', 0)
      tt.content = text
      tt.level = t.level
      out.push(tt)
    } else {
      if (t.children) t.children = textOnly(t.children, Token)
      out.push(t)
    }
  }
  return out
}
