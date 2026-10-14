// The frontmatter link check (raw-output.mjs, isSafeLink) rests on a copy of
// what the default theme does to a relative link: themeHref repeats
// normalizeLink and withBase. A copy drifts silently when VitePress changes the
// rewrite, so this file runs the installed theme's own code over a generated
// corpus and compares it with the copy.
//
// How the installed code is obtained, and why it is the real one: the two files
// are located through the package exports of the installed `vitepress`
// (theme-default/support/utils.js holds normalizeLink; app/utils.js holds
// withBase and joinPath), read as text, and each function is cut out of the
// compiled source and evaluated in a context that holds only what the function
// names: the URL class, the theme's own isExternal and treatAsHtml (imported
// from the installed shared.js, not copied), and two stubs for the site data
// (the base and the cleanUrls switch). A function that starts to name anything
// else throws a ReferenceError, and a function that cannot be cut out fails
// with a message; both fail the suite instead of passing on a stale copy.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { EXTERNAL_URL_RE, isExternal, treatAsHtml } from 'vitepress/dist/client/shared.js'
import { isSafeLink, themeHref } from '../.vitepress/raw-output.mjs'
import { backtickRefused, keptRelative, themeOffsite } from './link-cases.mjs'

const installed = (specifier) => fileURLToPath(import.meta.resolve(specifier))
const themeUtils = installed('vitepress/dist/client/theme-default/support/utils.js')
const appUtils = installed('vitepress/dist/client/app/utils.js')
const clientIndex = installed('vitepress/dist/client/index.js')

// The text of a top-level function in compiled output: from its declaration to
// the closing brace at the start of a line.
function functionSource(file, name) {
  const text = fs.readFileSync(file, 'utf8')
  const start = text.indexOf(`export function ${name}(`)
  assert.notEqual(start, -1, `${name} is not declared in ${file}; read the theme again (docs/repo-layout.md)`)
  const end = text.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `the end of ${name} was not found in ${file}`)
  return text.slice(start, end + 2).replace(/^export /, '')
}

// normalizeLink and withBase of the installed theme, for one site base and
// cleanUrls setting.
function installedTheme({ base, cleanUrls }) {
  const context = vm.createContext({
    URL,
    EXTERNAL_URL_RE,
    isExternal,
    treatAsHtml,
    siteDataRef: { value: { base } },
    useData: () => ({ site: { value: { cleanUrls } } })
  })
  const source = ['joinPath', 'withBase'].map((n) => functionSource(appUtils, n)).join('\n') + '\n' + functionSource(themeUtils, 'normalizeLink')
  return vm.runInContext(`${source}\n;({ normalizeLink, withBase })`, context)
}

// Both files are the ones VitePress itself serves as `vitepress` exports.
test('the installed theme code is the code the site runs', () => {
  assert.match(fs.readFileSync(clientIndex, 'utf8'), /export \{[^}]*\bwithBase\b[^}]*\} from '\.\/app\/utils'/)
  const version = JSON.parse(fs.readFileSync(installed('vitepress/package.json'), 'utf8')).version
  const pinned = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).devDependencies.vitepress
  assert.equal(version, pinned, 'the installed VitePress is not the pinned one')
  const theme = installedTheme({ base: '/', cleanUrls: false })
  assert.equal(theme.normalizeLink('/a/b'), '/a/b.html')
  assert.equal(installedTheme({ base: '/agent-dx/', cleanUrls: false }).normalizeLink('x/../y'), '/agent-dx/y.html')
  assert.equal(installedTheme({ base: '/agent-dx/', cleanUrls: true }).normalizeLink('/a/b'), '/agent-dx/a/b')
})

// A seeded generator, so a failure names a value that comes back on every run.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Everything the rewrite reads: separators, dot segments, "$" patterns, a
// backtick, an escaped dot, the query and fragment marks, a colon, and the two
// extensions the rewrite looks at.
const tokens = ['/', '.', '..', 'a', '$', '$1', '$&', "$'", '`', '%2e', '?', '#', ':', '.md', '.html', '//']

function corpus() {
  const values = new Set([...themeOffsite, ...backtickRefused, ...keptRelative, '', '.', '..', '...', '/', '//', '///'])
  // Every sequence of up to four tokens.
  let level = ['']
  for (let length = 1; length <= 4; length++) {
    level = level.flatMap((prefix) => tokens.map((t) => prefix + t))
    for (const v of level) values.add(v)
  }
  // Longer sequences, drawn at random.
  const next = mulberry32(20241014)
  for (let i = 0; i < 20000; i++) {
    const length = 5 + Math.floor(next() * 5)
    let v = ''
    for (let j = 0; j < length; j++) v += tokens[Math.floor(next() * tokens.length)]
    values.add(v)
  }
  return [...values]
}

const attempt = (fn, value) => {
  try {
    return { value: fn(value) }
  } catch {
    return { threw: true }
  }
}

test('themeHref is what the installed theme writes for a relative link, over a generated corpus', () => {
  const values = corpus()
  assert.ok(values.length > 50000, `corpus of ${values.length} values`)
  for (const base of ['/', '/agent-dx/']) {
    const theme = installedTheme({ base, cleanUrls: false })
    let rewritten = 0
    let external = 0
    let threw = 0
    for (const v of values) {
      const real = attempt(theme.normalizeLink, v)
      const copy = attempt(themeHref, v)
      // The copy reads the value with the same URL parser, so it fails on the same values.
      if (real.threw || copy.threw) {
        assert.deepEqual({ real: !!real.threw, copy: !!copy.threw }, { real: true, copy: true }, `parse failure differs for ${JSON.stringify(v)}`)
        threw++
        continue
      }
      // What the theme writes is the value as typed, or the rewritten path, with the base added to either.
      const asTyped = theme.withBase(v)
      const asRewritten = theme.withBase(copy.value)
      assert.ok(real.value === asTyped || real.value === asRewritten, `base ${base}: ${JSON.stringify(v)} -> theme ${JSON.stringify(real.value)}, copy ${JSON.stringify(copy.value)}`)
      // Where the theme rewrites, the copy gives the same path.
      if (real.value !== asTyped) {
        rewritten++
        assert.equal(real.value, asRewritten, JSON.stringify(v))
      }
      if (EXTERNAL_URL_RE.test(real.value)) external++
    }
    // A comparison that never rewrote or never produced an off-site result would prove nothing.
    assert.ok(rewritten > 10000, `base ${base}: ${rewritten} rewritten values`)
    assert.ok(external > 100, `base ${base}: ${external} external results`)
    assert.ok(threw > 0, `base ${base}: no value the URL parser rejects`)
  }
})

test('cleanUrls only changes the end of what the theme writes, so it never decides whether the result is another site', () => {
  const values = corpus()
  for (const base of ['/', '/agent-dx/']) {
    const withExtension = installedTheme({ base, cleanUrls: false })
    const clean = installedTheme({ base, cleanUrls: true })
    for (const v of values) {
      const a = attempt(withExtension.normalizeLink, v)
      const b = attempt(clean.normalizeLink, v)
      assert.equal(!!a.threw, !!b.threw, JSON.stringify(v))
      if (a.threw) continue
      assert.equal(EXTERNAL_URL_RE.test(a.value), EXTERNAL_URL_RE.test(b.value), `base ${base}: ${JSON.stringify(v)} -> ${JSON.stringify(a.value)} / ${JSON.stringify(b.value)}`)
    }
  }
})

test('a relative link the guard keeps is never written as another site by the installed theme', () => {
  const values = corpus()
  const pageUrl = new URL('https://site.invalid/agent-dx/page')
  let kept = 0
  for (const cleanUrls of [false, true]) {
    for (const base of ['/', '/agent-dx/']) {
      const theme = installedTheme({ base, cleanUrls })
      for (const v of values) {
        if (!isSafeLink(v) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) continue
        kept++
        const href = theme.normalizeLink(v)
        assert.ok(!EXTERNAL_URL_RE.test(href) && !href.startsWith('\\'), `${JSON.stringify(v)} -> ${JSON.stringify(href)}`)
        assert.equal(new URL(href, pageUrl).origin, pageUrl.origin, `${JSON.stringify(v)} -> ${JSON.stringify(href)}`)
      }
    }
  }
  assert.ok(kept > 10000, `${kept} kept values checked`)
})

test('the corpus holds the values the guard refuses, so the refusals are compared too', () => {
  const values = new Set(corpus())
  for (const v of [...themeOffsite, ...backtickRefused]) {
    assert.ok(values.has(v), v)
    assert.equal(isSafeLink(v), false, v)
  }
  assert.ok([...values].some((v) => v.includes('$`')))
})
