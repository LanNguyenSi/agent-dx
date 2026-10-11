// With markdown `html: true`, markdown-it itself decides what is an HTML
// comment (never inside code blocks, code spans, or fences). A core rule then
// works on the tokens, so every later consumer (heading slugs, the table of
// contents, titles, the renderer) only ever sees text: comments are dropped
// and any other raw HTML becomes literal text, so placeholders like <version>
// stay visible and nothing else is lost. No html_block or html_inline token
// from the source survives this rule, at any level.
//
// The rule runs right after inline parsing, so the core rules that follow
// (attributes, linkify, emoji, and VitePress's entity-restoring text_join)
// treat a neutralised HTML line exactly like any other paragraph, and the
// heading-anchor rule generates its permalink tokens afterwards, so they never
// pass through here.
//
// An unclosed "<!--" opens an HTML block that runs to the end of the file; it
// is kept as visible literal text (nothing is dropped silently).
const COMMENT = /<!--[\s\S]*?-->/g
// The same comments, skipped inside inline code spans, for an inline token's
// raw source text.
const COMMENT_OUTSIDE_CODE = /(`+)[^`]*?\1|<!--[\s\S]*?-->/g

export function htmlComments(md) {
  md.core.ruler.after('inline', 'agent-dx-html', (state) => {
    const { Token } = state
    const tokens = state.tokens
    const out = []
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      if (tok.type === 'html_block' || tok.type === 'html_inline') {
        let src = tok.content
        // VitePress's component block rule turns a line that starts with a
        // custom element or component closed on the same line into a
        // top-level html_inline plus an inline token holding the rest of
        // that line. Rejoin the line so it becomes one paragraph.
        const next = tokens[i + 1]
        if (tok.type === 'html_inline' && next?.type === 'inline' && sameLines(tok.map, next.map)) {
          src += next.content
          i++
        }
        const rest = src.replace(COMMENT, '').trim()
        if (rest) out.push(...paragraph(rest, tok, state, md))
      } else {
        if (tok.children) {
          const seen = { comment: false }
          tok.children = textOnly(tok.children, Token, seen)
          // The heading permalink label is built from the raw source text.
          if (seen.comment) tok.content = tok.content.replace(COMMENT_OUTSIDE_CODE, (m, code) => (code ? m : ''))
        }
        out.push(tok)
      }
    }
    state.tokens = out
  })
}

function sameLines(a, b) {
  return Boolean(a && b) && a[0] === b[0] && a[1] === b[1]
}

// A paragraph whose content is the HTML source re-parsed as inline Markdown,
// with every html_inline turned into text.
function paragraph(content, tok, state, md) {
  const { Token } = state
  const open = new Token('paragraph_open', 'p', 1)
  open.block = true
  open.map = tok.map
  open.level = tok.level
  const inline = new Token('inline', '', 0)
  inline.block = true
  inline.map = tok.map
  inline.level = tok.level + 1
  inline.content = content
  inline.children = []
  md.inline.parse(content, md, { references: state.env.references }, inline.children)
  inline.children = textOnly(inline.children, Token, { comment: false })
  const close = new Token('paragraph_close', 'p', -1)
  close.block = true
  close.level = tok.level
  return [open, inline, close]
}

function textOnly(children, Token, seen) {
  const out = []
  for (const t of children) {
    if (t.type === 'html_inline') {
      const text = t.content.replace(COMMENT, '')
      if (text !== t.content) seen.comment = true
      if (!text) continue
      const tt = new Token('text', '', 0)
      tt.content = text
      tt.level = t.level
      out.push(tt)
    } else {
      if (t.children) t.children = textOnly(t.children, Token, seen)
      out.push(t)
    }
  }
  return out
}
