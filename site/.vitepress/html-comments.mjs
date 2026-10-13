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
// comment never cuts a fenced code block: when its first "-->" lies inside a
// fence that markdown-it recognises, the opener is not a comment and stays
// visible, whether the fence stands at the top level, in a quote, or in a list
// item at any depth. A whole fence may lie inside a comment. A comment inside
// text that spans lines follows the same rule, whatever grouped those lines
// into a paragraph, such as a hidden comment earlier on the page. Fences are
// found as markdown-it finds them in the page without the comment rules, and
// an indented code block that holds a line starting with three backticks or
// tildes counts as a fence indented too far.

// Within text, what markdown-it reads before a comment can start: backslash
// escapes and code spans (a run of backticks closed by a run of the same
// length), then the comment itself. Used to remove comments from text that
// markdown-it keeps as raw source: the heading text the permalink label is
// built from, link titles, container titles, and comment lines.
const OUTSIDE_CODE = /\\[!-\/:-@[-`{-~]|(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|`+|<!--/g

// A comment runs from its opener to the first "-->" after the opener's four
// characters. The opener is matched on its own and its closer looked up with
// indexOf, so an opener with no closer ends the search at once instead of
// being scanned to the end of the text again for each one that follows.
export function stripComments(text) {
  if (!text.includes('<!--')) return text
  const re = new RegExp(OUTSIDE_CODE.source, 'g')
  let out = ''
  let from = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] !== '<!--') continue
    const close = text.indexOf('-->', m.index + 4)
    if (close === -1) break
    out += text.slice(from, m.index)
    from = re.lastIndex = close + 3
  }
  return out + text.slice(from)
}

export function htmlComments(md) {
  md.block.ruler.before('html_block', 'agent-dx-comment-block', commentBlock, {
    alt: ['paragraph', 'reference', 'blockquote']
  })
  md.inline.ruler.before('html_inline', 'agent-dx-comment', commentInline)
  // Right after the block parse, before any other core rule can change a
  // paragraph's text (see commentLines).
  md.core.ruler.after('block', 'agent-dx-comment-lines', commentLines)
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
  // Off while the page is parsed again to find its fences.
  if (reparsing) return false
  // A line four or more columns in is code, or, after a paragraph or quote
  // line, more text of that paragraph, where the inline rule hides the comment.
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const start = state.bMarks[startLine] + state.tShift[startLine]
  if (!state.src.startsWith('<!--', start)) return false

  let line = startLine
  let close = findClose(state, start + 4)
  for (;;) {
    if (close === -1) return false
    line = lineEndingAfter(state, line, endLine, close)
    if (line === -1) return false
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

// The first line in [from, endLine) that ends at or after `close`, or -1. Line
// ends only grow, so a binary search finds it; walking the lines one by one
// would cost the distance to a far closer for each opener that has one.
function lineEndingAfter(state, from, endLine, close) {
  if (state.eMarks[endLine - 1] < close) return -1
  let lo = from
  let hi = endLine - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (state.eMarks[mid] >= close) hi = mid
    else lo = mid + 1
  }
  return lo
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
// joins as if the comment had never been written. As for a comment that starts
// a line, it is not one when its first "-->" lies in a fence markdown-it finds
// in the page. The fence shows up in the text of a paragraph when a hidden
// comment earlier on the page regroups the lines, and the text then holds the
// opener and the fence lines, with the fence's opening line as a code span. A
// "-->" in an ordinary code span still closes the comment, as it does where
// no fence is involved.
function commentInline(state) {
  if (!state.src.startsWith('<!--', state.pos)) return false
  const close = findClose(state, state.pos + 4)
  if (close === -1 || close + 3 > state.posMax) return false
  if (closesInFenceText(state, close)) return false
  state.pos = close + 3
  return true
}

// The inline rule sees the text of one paragraph, not the page. Right after
// the block parse, before any other rule can change the text, the page, the
// first line of each paragraph, and the number of lines its text has are kept
// under the array that the paragraph's tokens are put into, which is what the
// rule reaches through its state. Later a core rule can cut lines off the
// front of the text without changing the lines the token spans, as VitePress
// does when it takes the "[!NOTE]" line out of a quote's first paragraph. The
// text the inline rule sees is then shorter than the text kept here, and the
// difference is the number of lines to skip, so the lines of the text are the
// lines of the page from the first line plus that difference.
const textStart = new WeakMap()
function commentLines(state) {
  for (const tok of state.tokens) {
    if (tok.type === 'inline' && tok.map) {
      textStart.set(tok.children, { line: tok.map[0], lines: tok.content.split('\n').length, src: state.src })
    }
  }
}

// True when the closer lies on a later line than the opener, in a fence.
function closesInFenceText(state, close) {
  const text = textStart.get(state.tokens)
  if (!text) return false
  const closeLine = lineAt(state, close)
  if (closeLine === lineAt(state, state.pos)) return false
  const cut = text.lines - lineStartsOf(state).length
  return inFence(fenceSpans(state.md, state.env, text.src), text.line + cut + closeLine)
}

// The line of the text that holds position `at`, counted from 0.
function lineAt(state, at) {
  const starts = lineStartsOf(state)
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= at) lo = mid
    else hi = mid - 1
  }
  return lo
}

// The start of each line of the text. They are found once per paragraph, so a
// paragraph with many openers is not searched again for each one.
const lineStarts = new WeakMap()
function lineStartsOf(state) {
  let starts = lineStarts.get(state)
  if (!starts) {
    starts = [0]
    for (let i = state.src.indexOf('\n'); i !== -1; i = state.src.indexOf('\n', i + 1)) starts.push(i + 1)
    lineStarts.set(state, starts)
  }
  return starts
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
// block. The fences are those markdown-it finds in the page when the comment
// rules are switched off, so a fence in a list item, a nested item, or after a
// less indented line is found as markdown-it finds it, whatever its columns. A
// fence holds the closer when the closer's line lies within the lines of its
// token. An indented code block with a line that starts with three backticks or
// tildes counts as a fence indented too far. The page is parsed once, and only
// for a comment that spans lines on a page that has a run of three backticks
// or tildes.
const fences = new WeakMap()
const MISINDENTED_FENCE = /^[ \t]*(```|~~~)/m
let reparsing = false
function fenceSpans(md, env, src) {
  const known = fences.get(env)
  if (known && known.src === src) return known.spans
  const spans = []
  if (src.includes('```') || src.includes('~~~')) {
    const tokens = []
    reparsing = true
    try {
      // Block rules read the page path (a snippet line resolves its file from
      // it) and a reference rule adds the definitions it finds to the env, so
      // the parse gets a copy that keeps the path and starts without
      // definitions, which stay with the real parse.
      md.block.parse(src, md, { ...env, references: undefined }, tokens)
    } finally {
      reparsing = false
    }
    for (const t of tokens) {
      if (t.type === 'fence' || (t.type === 'code_block' && MISINDENTED_FENCE.test(t.content))) spans.push(t.map)
    }
  }
  fences.set(env, { src, spans })
  return spans
}

function closesInFence(state, startLine, closeLine) {
  if (closeLine === startLine) return false
  return inFence(fenceSpans(state.md, state.env, state.src), closeLine)
}

// The spans do not overlap and are in source order.
function inFence(spans, line) {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [from, to] = spans[mid]
    if (line < from) hi = mid - 1
    else if (line >= to) lo = mid + 1
    else return true
  }
  return false
}
