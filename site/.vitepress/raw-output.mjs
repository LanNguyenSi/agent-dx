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
// as transformHtml. The frontmatter fields the theme turns into markup (HTML,
// an attribute, a tag name) are handled by sanitizeFrontmatter, passed as
// transformPageData.

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

// Frontmatter the default theme turns into markup, and what transformPageData
// does to each field. Every frontmatter field the installed theme and page
// renderer read was checked. These are written as escaped text, in a class
// binding or as an on/off switch, and need nothing here: title and
// titleTemplate, pageClass, the text and theme of a hero action, linkText,
// outline, aside, sidebar, editLink, footer, navbar, markdownStyles,
// lastUpdated and search. The theme version is pinned; after a VitePress
// upgrade, read the sinks again. How the frontmatter
// block is read is set in markdownBase (site-helpers.mjs): a JavaScript block
// is refused there, because the bundled reader would run it as Node code.
//
//   - dir: written unescaped into <html dir="...">. Only ltr, rtl and auto are
//     kept; any other value is dropped, so the page falls back to the site's
//     direction.
//   - layout: VitePress renders any other value than doc, home and page as a
//     component whose name is the value, and the server renderer writes an
//     unknown name as a tag name as typed. Only those three and false (no
//     layout) are kept; any other value is dropped, so the page is a doc.
//   - prev and next: the footer link text, as a string or as { text, link },
//     written with v-html.
//   - hero name, text and tagline; features title, details and a string icon,
//     all written with v-html.
//   - features: an array. Any other shape (a YAML mapping, which Vue also
//     iterates) is dropped, so a field cannot skip the item checks.
//   - hero.image and an icon given as an object: the theme spreads the whole
//     object onto an <img>, so every key becomes an attribute, an event
//     handler included. Only src, alt, width, height and wrap with plain values
//     are kept, and light and dark (themed images) with the same rule.
//
// For the text fields the value is HTML-escaped, so it shows as written (an
// entity reference stays one). A number, a boolean or an empty value cannot
// hold markup and is kept as it is, since `prev: false` hides a link.
//
// What stays as typed: `head` (VitePress's documented way to add tags) and
// the link fields (prev and next link, hero action and feature link, target
// and rel), which the theme writes into href, target and rel attributes
// without checking the scheme. These are author-trusted, like head.
export const allowedDirs = new Set(['ltr', 'rtl', 'auto'])
export const allowedLayouts = new Set(['doc', 'home', 'page'])

// YAML reads `2024-05-01` as a date. It is written as an ISO string, which does
// not depend on the time zone of the build machine, and is not a record.
const isDate = (value) => Object.prototype.toString.call(value) === '[object Date]'
const dateText = (date) => (Number.isNaN(date.getTime()) ? 'Invalid Date' : date.toISOString())
const asText = (value) =>
  isDate(value)
    ? dateText(value)
    : value == null || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : escapeText(String(value))
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !isDate(value)
const isPlain = (value) => typeof value === 'string' || typeof value === 'number'
const withText = (value, keys) =>
  isRecord(value) ? { ...value, ...Object.fromEntries(keys.filter((k) => k in value).map((k) => [k, asText(value[k])])) } : value
const pageLink = (value) => (isRecord(value) ? withText(value, ['text']) : asText(value))

// An image as the theme reads it: a string (a source), or an object. Returns
// undefined for anything else, which the caller drops. The theme spreads an
// object with a src onto an <img>, so only the keys below survive; an object
// without a src is a themed image, and its light and dark sides get the same
// treatment. A source is an attribute value, so a string stays as typed.
export function safeImage(image) {
  if (typeof image === 'string') return image
  if (!isRecord(image)) return undefined
  const safe = {}
  for (const key of ['src', 'alt', 'width', 'height']) if (isPlain(image[key])) safe[key] = image[key]
  if (isPlain(image.wrap) || typeof image.wrap === 'boolean') safe.wrap = image.wrap
  if (!('src' in safe)) {
    for (const key of ['light', 'dark']) {
      const side = safeImage(image[key])
      if (side !== undefined) safe[key] = side
    }
  }
  return safe
}

const sanitizeFeature = (feature) => {
  const item = withText(feature, ['title', 'details'])
  if (!isRecord(item)) return item
  const icon = isRecord(item.icon) ? safeImage(item.icon) : asText(item.icon)
  const { icon: _drop, ...rest } = item
  return icon === undefined ? rest : { ...rest, icon }
}

export function sanitizeFrontmatter(frontmatter) {
  const safe = { ...frontmatter }
  if (!allowedDirs.has(safe.dir)) delete safe.dir
  if (safe.layout !== false && !allowedLayouts.has(safe.layout)) delete safe.layout
  for (const key of ['prev', 'next']) if (key in safe) safe[key] = pageLink(safe[key])
  if ('hero' in safe) {
    const hero = withText(safe.hero, ['name', 'text', 'tagline'])
    if (isRecord(hero)) {
      const { image: source, ...rest } = hero
      const image = safeImage(source)
      safe.hero = image === undefined ? rest : { ...rest, image }
    } else {
      safe.hero = hero
    }
  }
  if ('features' in safe) {
    if (Array.isArray(safe.features)) safe.features = safe.features.map(sanitizeFeature)
    else delete safe.features
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
