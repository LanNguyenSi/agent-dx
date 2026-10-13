// Page text written into the generated component script must not be able to
// end the script block. Unit checks for the literal rewrite and the plugin
// wrapper; the built pages are checked in raw-output-build.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { resolveConfig } from 'vitepress'
import { escapeScriptLiterals, scriptSafePageData } from '../.vitepress/script-safe.mjs'

const variants = ['</script>', '</SCRIPT >', '</script', '<!--', '<script', '<\\/script>', 'a\\<b', '"</script>"']
const component = (data, name) =>
  `<script >\nexport const __pageData = JSON.parse(${JSON.stringify(JSON.stringify(data))})\nexport default {name:${JSON.stringify(name)}}</script>\n<template><div>x</div></template>`

test('the page data literal holds no "<" and reads back as the same data', () => {
  for (const v of variants) {
    const data = { title: `a ${v} b`, frontmatter: { description: v, nested: [{ text: v }] }, relativePath: `x${v}.md` }
    const out = escapeScriptLiterals(component(data, data.relativePath))
    const script = out.slice(0, out.indexOf('</script>'))
    assert.equal((script.match(/</g) ?? []).length, 1, `only the opening tag keeps a "<": ${v}`)
    assert.equal(out.indexOf('</script>'), out.lastIndexOf('</script>'), v)
    const sandbox = {}
    vm.runInNewContext(script.replace(/^<script >/, '').replace(/export const /, 'var ').replace(/export default /, 'var d = '), sandbox)
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__pageData)), data, v)
    assert.equal(sandbox.d.name, data.relativePath, v)
  }
})

test('source without a page data literal is returned unchanged', () => {
  const src = '<template><div>&lt;/script&gt;</div></template>'
  assert.equal(escapeScriptLiterals(src), src)
})

test('text outside the two literals is left alone', () => {
  const src = component({ title: 'T' }, 'a.md') + '\n<style>a > b {}</style>'
  const out = escapeScriptLiterals(src)
  assert.ok(out.endsWith('<template><div>x</div></template>\n<style>a > b {}</style>'))
})

test('the plugin wraps the transform of the vitepress plugin, and fails when it is missing', async () => {
  const seen = []
  const target = { name: 'vitepress', transform: async (code) => component({ title: '</script>' }, 'p.md') + (seen.push(code), '') }
  const plugin = scriptSafePageData()
  plugin.configResolved({ plugins: [target] })
  const out = await target.transform('src', 'p.md')
  assert.deepEqual(seen, ['src'])
  assert.equal(out.indexOf('</script>'), out.lastIndexOf('</script>'))
  assert.match(out, /\\u003c\/script>/)
  const objectHook = { name: 'vitepress', transform: { order: 'pre', handler: async () => ({ code: component({ title: '</script>' }, 'p.md'), map: null }) } }
  plugin.configResolved({ plugins: [objectHook] })
  const wrapped = await objectHook.transform.handler()
  assert.equal(objectHook.transform.order, 'pre')
  assert.equal(wrapped.map, null)
  assert.match(wrapped.code, /\\u003c\/script>/)
  const passive = { name: 'vitepress', transform: async () => undefined }
  plugin.configResolved({ plugins: [passive] })
  assert.equal(await passive.transform(), undefined)
  assert.throws(() => plugin.configResolved({ plugins: [] }), /no transform to guard/)
  assert.throws(() => plugin.configResolved({ plugins: [{ name: 'vitepress' }] }), /no transform to guard/)
})

test('the real site config carries the plugin', async () => {
  const cfg = await resolveConfig('.')
  assert.ok(cfg.userConfig.vite.plugins.some((p) => p?.name === 'agent-dx-script-safe-page-data'))
})
