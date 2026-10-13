// Author-controlled Markdown must not reach the rendered page as live HTML or
// as a compiled Vue template. Raw HTML is already off (markdownBase.html), and
// VitePress escapes most text itself. These are the places where its default
// renderer writes author text out unescaped, and what this plugin does there:
//
//   - fence info string: the language is written into a class attribute and a
//     visible label as typed, and the title of a code-group tab is cut out of
//     it by VitePress with its own pattern. The whole info string is
//     HTML-escaped before any renderer reads it, so no assumption is made about
//     where VitePress finds the language or the title (a line separator such
//     as U+2028 changes where a pattern stops matching).
//   - code-group tab titles ("```js [title]"): the escaped title is written
//     into the tab label, and a doubled escape in data-title is undone.
//   - GitHub alert titles ("> [!NOTE] title"): the title is written as typed.
//     It is escaped.
//   - explicit ids ("# Head {#id}"): the table of contents writes an id into an
//     href as typed. An id with a character outside letters, digits, "_" and
//     "-" is dropped, and the heading gets the id VitePress derives from its
//     text.
//   - mustache: "{{ ... }}" in prose, headings, inline code, table cells,
//     container titles, the table of contents and indented code is compiled by
//     Vue as an expression. Every "{{" in the rendered page is written as two
//     numeric references, which Vue decodes to text instead of reading as an
//     interpolation. This runs over the whole rendered output, not per place,
//     so a place nobody thought of is covered too. A fenced block is v-pre, so
//     it never evaluated anything; its "{{" now reaches the template as two
//     references and still shows as "{{" to the reader.
//
// The page title needs nothing here: VitePress escapes the <title> element when
// it writes the page, and the client sets document.title as text.
// Attribute names from markdown-it-attrs are limited by markdownBase.attrs
// (see allowedAttributes below), not here. The description of a page is
// escaped by escapeDescriptionMeta, which the site config passes to VitePress
// as transformHtml. The frontmatter fields the theme writes as HTML are handled
// by sanitizeFrontmatter, passed as transformPageData.

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

// An id the table of contents may write into an href as typed.
export const safeId = /^[A-Za-z0-9_-]+$/

// transformHtml for the site config. VitePress writes the description of a
// page into <meta name="description" content="..."> as typed; the same text in
// the page data stays plain, since the client sets it through the DOM. Every
// copy of the tag is replaced, not the first one: a copy written earlier by
// some other field must not use up the replacement and leave the real tag raw.
export function escapeDescriptionMeta(html, _file, { description }) {
  if (!description) return html
  // Frontmatter YAML can give a number, a boolean or a list; VitePress writes
  // its string form, so match and escape that.
  const text = String(description)
  const raw = `<meta name="description" content="${text}">`
  const escaped = `<meta name="description" content="${escapeText(text)}">`
  return html.replaceAll(raw, () => escaped)
}

// Frontmatter fields the default theme writes as HTML (v-html), and what
// transformPageData does to each. `head` is VitePress's documented raw
// injection and is left alone on purpose.
//
//   - dir: written unescaped into <html dir="...">. Only ltr, rtl and auto are
//     kept; any other value is dropped, so the page falls back to the site's
//     direction.
//   - prev and next: the footer link text, as a string or as { text, link }.
//   - hero name, text and tagline; features title, details and icon (a string
//     icon; an icon given as an image object is not HTML).
//
// For the text fields the value is HTML-escaped, so it shows as written (an
// entity reference stays one). A number, a boolean or an empty value cannot
// hold markup and is kept as it is, since `prev: false` hides a link.
export const allowedDirs = new Set(['ltr', 'rtl', 'auto'])

const asText = (value) =>
  value == null || typeof value === 'number' || typeof value === 'boolean' ? value : escapeText(String(value))
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const withText = (value, keys) =>
  isRecord(value) ? { ...value, ...Object.fromEntries(keys.filter((k) => k in value).map((k) => [k, asText(value[k])])) } : value
const pageLink = (value) => (isRecord(value) ? withText(value, ['text']) : asText(value))

export function sanitizeFrontmatter(frontmatter) {
  const safe = { ...frontmatter }
  if (!allowedDirs.has(safe.dir)) delete safe.dir
  for (const key of ['prev', 'next']) if (key in safe) safe[key] = pageLink(safe[key])
  if ('hero' in safe) safe.hero = withText(safe.hero, ['name', 'text', 'tagline'])
  if (Array.isArray(safe.features)) {
    safe.features = safe.features.map((feature) => {
      const item = withText(feature, ['title', 'details'])
      return isRecord(item) && 'icon' in item && !isRecord(item.icon) ? { ...item, icon: asText(item.icon) } : item
    })
  }
  return safe
}

// transformPageData for the site config.
export function transformPageData(pageData) {
  return { frontmatter: sanitizeFrontmatter(pageData.frontmatter) }
}

export function rawOutput(md) {
  // The fence renderer and the code-group renderer read the info string at
  // render time. This rule runs after every block and attribute rule has seen
  // the original text and before any renderer reads it.
  md.core.ruler.push('agent-dx-escape-fence-info', (state) => {
    for (const tok of state.tokens) {
      if (tok.type === 'fence') tok.info = escapeText(tok.info)
    }
  })

  // Runs right after markdown-it-attrs and before the rule that gives every
  // heading its id and the table of contents that reads it.
  md.core.ruler.after('curly_attributes', 'agent-dx-explicit-ids', (state) => {
    const drop = (tok) => {
      if (tok.attrs) tok.attrs = tok.attrs.filter(([name, value]) => name !== 'id' || safeId.test(value))
      tok.children?.forEach(drop)
    }
    state.tokens.forEach(drop)
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
        meta: { ...token.meta, title: escapeText(token.meta.title) }
      })
      return alert([escaped], 0, ...rest)
    }
  }

  const render = md.renderer.render.bind(md.renderer)
  md.renderer.render = (tokens, options, env) => defuseMustache(render(tokens, options, env))
}
