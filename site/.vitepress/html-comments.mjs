// The site renders Markdown with raw HTML off, so placeholders like <version>
// and any other HTML in the playbooks show as literal text and nothing reaches
// the page as markup. HTML comments are the one exception: they are hidden.
// markdown-it's own tokenizer finds them, through a block rule for lines that
// start with a comment and an inline rule for comments inside text, so a
// comment in a code block, fenced code, a code span, or after a backslash
// escape is never touched.
//
// A comment runs from "<!--" to the first "-->" after it; "--" inside it does
// not end it. An unclosed "<!--" stays visible text. Inside a paragraph a
// comment cannot reach past a blank line. A comment that starts a line closes
// at its first "-->" within the same quote or container, across blank lines
// and less indented lines; it hides whole lines up to the line where it
// closes, and lines that hold nothing but comments act as blank lines. A
// comment never cuts a fenced code block it recognises (fences inside list
// items only approximately): when its first "-->" lies inside a
// fence that opened after the comment's first line, the opener is not a
// comment and stays visible. A whole fence may lie inside a comment. A fence
// is a line that starts with three or more backticks or tildes; a backtick
// fence's info string holds no backtick. Such a line indented four or more
// columns past the container may be no fence or the fence of a nested block
// such as a list item. A fence closes at a line made only of at least as
// many of the same character, followed by nothing but spaces and tabs,
// indented at most three columns past the container column or past the
// opener's own column, and the opener stays visible when its "-->" lies
// inside a fence under any of these readings.

// Within text, what markdown-it reads before a comment can start: backslash
// escapes and code spans (a run of backticks closed by a run of the same
// length), then the comment itself. Used to remove comments from text that
// markdown-it keeps as raw source: the heading text the permalink label is
// built from, link titles, container titles, and comment lines.
const COMMENT_OUTSIDE_CODE = /\\[!-\/:-@[-`{-~]|(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|`+|<!--[\s\S]*?-->/g

export function stripComments(text) {
  return text.replace(COMMENT_OUTSIDE_CODE, (m) => (m.startsWith('<!--') ? '' : m))
}

export function htmlComments(md) {
  md.block.ruler.before('html_block', 'agent-dx-comment-block', commentBlock, {
    alt: ['paragraph', 'reference', 'blockquote']
  })
  md.inline.ruler.before('html_inline', 'agent-dx-comment', commentInline)
  md.core.ruler.after('inline', 'agent-dx-comment-text', commentText)
}

// A line that starts with a comment, or with several in a row, up to the line
// where the last of them closes. Each comment closes at its first "-->" within
// the same quote or container, so a comment opened in a list item or quote
// also hides blank lines and less indented lines up to that "-->", and a list
// whose items are commented out stays one list. A comment never cuts a fenced
// code block: when that "-->" lies inside a fence that opened after the
// comment's first line, the opener is not a comment and stays visible, while
// a whole fence may lie inside a comment. Lines holding nothing but comments
// become blank lines, so paragraphs, lists, and quotes around them behave
// exactly as if the comment had never been written. A single line with text
// after its comment is left to the other rules, and the inline rule hides the
// comment. A comment over several lines with text after it on its closing
// line hides those lines and keeps the text as a paragraph.
function commentBlock(state, startLine, endLine, silent) {
  // A line four or more columns in is code, or, after a paragraph or quote
  // line, more text of that paragraph, where the inline rule hides the comment.
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const start = state.bMarks[startLine] + state.tShift[startLine]
  if (!state.src.startsWith('<!--', start)) return false

  let line = startLine
  let close = findClose(state, start + 4)
  for (;;) {
    if (close === -1) return false
    while (state.eMarks[line] < close) {
      line++
      if (line >= endLine) return false
    }
    // A comment that follows on the same line continues the run.
    let next = close + 3
    while (next < state.eMarks[line] && (state.src[next] === ' ' || state.src[next] === '\t')) next++
    if (!state.src.startsWith('<!--', next)) break
    close = findClose(state, next + 4)
  }
  if (closesInFence(state, startLine, line)) return false
  const nextLine = line + 1

  const rest = stripComments(state.getLines(startLine, nextLine, state.blkIndent, false)).trim()
  if (rest && nextLine === startLine + 1) return false
  // Blank lines at the start of a document, quote, or list item do not
  // count as blank lines between blocks, so comment lines there stay as they
  // are; everywhere else they become blank lines.
  const last = state.tokens[state.tokens.length - 1]
  if (!rest && (silent || (last && last.nesting !== 1))) {
    for (let l = startLine; l < nextLine; l++) state.eMarks[l] = state.bMarks[l] + state.tShift[l]
  }
  if (silent) return true

  state.line = nextLine
  if (rest) {
    const open = state.push('paragraph_open', 'p', 1)
    open.map = [startLine, nextLine]
    const inline = state.push('inline', '', 0)
    inline.content = rest
    inline.map = [startLine, nextLine]
    inline.children = []
    state.push('paragraph_close', 'p', -1)
  }
  return true
}

// The first "-->" at or after `from`, or -1. A page with many openers and no
// "-->" after them would search the rest of the page for each one, so the last
// answer is kept per parser state and reused for any later start up to it.
const lastClose = new WeakMap()
function findClose(state, from) {
  const known = lastClose.get(state)
  if (known && from >= known.from && (known.at === -1 || from <= known.at)) return known.at
  const at = state.src.indexOf('-->', from)
  lastClose.set(state, { from, at })
  return at
}

// A comment inside text is skipped without a token, so the text around it
// joins as if the comment had never been written.
function commentInline(state) {
  if (!state.src.startsWith('<!--', state.pos)) return false
  const close = findClose(state, state.pos + 4)
  if (close === -1 || close + 3 > state.posMax) return false
  state.pos = close + 3
  return true
}

// After inline parsing. Comments in link, image, and container titles are
// removed. Where text held a comment, the whitespace the comment leaves at the
// start or end of the text or of a line is trimmed as for any other text, and
// the raw text the heading permalink label is built from loses the comment.
// No paragraph is left empty here: the block rule leaves a paragraph that
// starts with a comment to the inline rule only when text follows the comment
// on its line, the comment does not close inside its quote or container, or
// its closer lies inside a fence.
function commentText(state) {
  for (const tok of state.tokens) {
    if (/^container_.+_open$/.test(tok.type)) tok.info = stripComments(tok.info)
    if (tok.type !== 'inline' || !tok.children) continue
    for (const child of tok.children) {
      if (child.type === 'link_open' || child.type === 'image') stripTitle(child)
    }
    const content = stripComments(tok.content)
    if (content === tok.content) continue
    tok.content = content.trim()
    tok.children = trimText(tok.children)
  }
}

function trimText(children) {
  const blank = (t) => /^(soft|hard)break$/.test(t.type) || (t.type === 'text' && !t.content.trim())
  let start = 0
  let end = children.length
  while (start < end && blank(children[start])) start++
  while (end > start && blank(children[end - 1])) end--
  const out = []
  for (let i = start; i < end; i++) {
    const t = children[i]
    if (t.type === 'text') {
      if (i === start) t.content = t.content.trimStart()
      else if (/^(soft|hard)break$/.test(children[i - 1].type)) t.content = t.content.replace(/^[ \t]+/, '')
      if (i === end - 1) t.content = t.content.trimEnd()
      if (!t.content) continue
    }
    out.push(t)
  }
  return out
}

function stripTitle(token) {
  const title = token.attrGet('title')
  if (!title) return
  const text = stripComments(title)
  if (text) token.attrSet('title', text)
  else token.attrs = token.attrs.filter(([name]) => name !== 'title')
}

// True when the line holding the comment's closer sits inside a fenced code
// block that opened after the comment's first line. A fence is a line that
// starts with three or more backticks or tildes, and a backtick fence's info
// string holds no backtick. A backtick or tilde line indented four or more
// columns past the container is read both ways, as no fence and as the fence
// of a nested block such as a list item, and the closer counts as inside a
// fence under either reading. A fence closes at a line made only of at least
// as many of the same character, with nothing but spaces and tabs after them,
// indented at most three columns past the container column or past the
// opener's own column, and the closer counts as inside a fence under any of
// these readings. Fences inside list items are recognised only as far as
// this line view of their columns allows.
function closesInFence(state, startLine, closeLine) {
  return (
    inFence(state, startLine, closeLine, true) ||
    inFence(state, startLine, closeLine, false) ||
    inFence(state, startLine, closeLine, true, true)
  )
}

// One reading of the lines after the comment's first line: bounded takes a
// backtick or tilde line indented four or more columns past the container as
// no fence, unbounded takes it as a fence whose closer is measured against
// its own column. With own set, every closer is measured against its
// opener's own column, which matches a fence inside a list item.
function inFence(state, startLine, closeLine, bounded, own = false) {
  let fence = null
  let indent = 0
  for (let l = startLine + 1; l <= closeLine; l++) {
    const text = state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l])
    if (!fence) {
      const m = /^(`{3,}|~{3,})/.exec(text)
      if (m && (!bounded || state.sCount[l] - state.blkIndent < 4) && !(m[1][0] === '`' && text.slice(m[1].length).includes('`'))) {
        fence = m[1]
        indent = !own && state.sCount[l] - state.blkIndent < 4 ? Math.min(state.blkIndent, state.sCount[l]) : state.sCount[l]
      }
    } else if (state.sCount[l] - indent <= 3 && new RegExp('^' + fence[0].replace(/[`~]/, (c) => '\\' + c) + '{' + fence.length + ',}[ \\t]*$').test(text)) fence = null
  }
  return fence !== null
}
