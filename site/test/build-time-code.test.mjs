// Builds the real site config over a fixture repository whose playbook
// directory holds a dynamic route plus a paths file with a payload that writes
// a marker file. VitePress imports a paths file to list the route's pages, so
// without the check the payload runs during the build. The test proves the
// check fires first: the build fails naming the file and the marker is never
// written. A second build with the check taken out of the copied config proves
// the payload does run when nothing stops it, so a missing marker means the
// check worked and not that the setup could not run the payload. The same pair
// runs with the route reached through a directory link, which VitePress follows,
// and with the paths "file" being a directory whose index.jsx holds the payload,
// which VitePress also takes for a paths file and esbuild resolves to the index.
// A last pair puts dynamic routes with payloads in directories beside the
// allowed ones (names that start like an allowed directory): those are not
// pages, so the build never loads their paths files; with the page list taken
// back to the negation patterns that used to carry it, the payloads run.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAYLOAD = 'packages/agentic-coding-playbook/[x].paths.mjs'
const LINK = 'packages/agentic-coding-playbook/linked'
const CALL = '  refuseBuildTimeCode(repoRoot)\n'
const EXCLUDE = 'srcExclude: [...pageExclude(repoRoot), '
// Directories beside the allowed ones. The first three were pages under the
// negation patterns; site/index.mdx is ignored by those too, and stays in the
// tree as one more place a page must not come from.
const SIBLINGS = ['packages/agentic-coding-playbook-x', 'sitex', 'packagesX']
const IGNORED = ['site/index.mdx']
let work

// True when the output holds the refusal for exactly this path: the message
// ends the line, so a longer path with the same start does not count.
const refusal = (output, rel, suffix = '') =>
  output.split('\n').some((line) => line.trimEnd().endsWith(`Build-time code is not supported in playbook content: ${rel}${suffix}`))

// A repository of its own under tmp: site/.vitepress copied (without its cache
// and output), site/node_modules linked, a home page, the two playbook READMEs
// the config reads, a dynamic route and its paths file (in a playbook
// directory, behind a directory link in one, or as a directory with an index
// file). The marker lives in tmp.
function fixture(name, { bypassCheck, bypassExclude = false, linkedRoute = false, dirPaths = false, siblings = false }) {
  const repo = path.join(work, name)
  const marker = path.join(repo, 'MARKER')
  const siteCopy = path.join(repo, 'site')
  fs.cpSync(path.join(site, '.vitepress'), path.join(siteCopy, '.vitepress'), {
    recursive: true,
    filter: (src) => !['cache', 'dist'].includes(path.basename(src))
  })
  fs.copyFileSync(path.join(site, 'package.json'), path.join(siteCopy, 'package.json'))
  fs.symlinkSync(path.join(site, 'node_modules'), path.join(siteCopy, 'node_modules'))
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), text)
  }
  write('site/index.md', '# Home\n')
  write('packages/agent-engineering-playbook/README.md', '# Engineering\n')
  write('packages/agentic-coding-playbook/README.md', '# Playbook\n')
  const payload = (param, file = marker) =>
    `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(file)}, 'ran')\nexport default { paths: () => [{ params: { ${param}: 'a' } }] }\n`
  const markers = []
  if (siblings) {
    // Dynamic routes in directories that are not playbooks, each with its own marker.
    for (const [i, dir] of [...SIBLINGS, ...IGNORED].entries()) {
      const file = path.join(repo, `MARKER-${i}`)
      markers.push({ dir, file })
      write(`${dir}/[x].md`, '# Page {{ $params.x }}\n')
      write(`${dir}/[x].paths.mjs`, payload('x', file))
    }
  } else if (linkedRoute) {
    // The dynamic route sits outside the playbook directories, reached through
    // a directory link inside one.
    write('elsewhere/[z].md', '# Page {{ $params.z }}\n')
    write('elsewhere/[z].paths.mjs', payload('z'))
    fs.symlinkSync('../../elsewhere', path.join(repo, LINK))
  } else if (dirPaths) {
    write('packages/agentic-coding-playbook/[x].md', '# Page {{ $params.x }}\n')
    write(`${PAYLOAD}/index.jsx`, payload('x'))
  } else {
    write('packages/agentic-coding-playbook/[x].md', '# Page {{ $params.x }}\n')
    write(PAYLOAD, payload('x'))
  }
  if (bypassCheck) {
    // Take the call out of the copy only, and make sure that is what happened.
    const helpers = path.join(siteCopy, '.vitepress/site-helpers.mjs')
    const source = fs.readFileSync(helpers, 'utf8')
    assert.equal(source.split(CALL).length - 1, 1, 'the config calls refuseBuildTimeCode exactly once')
    fs.writeFileSync(helpers, source.replace(CALL, ''))
  }
  if (bypassExclude) {
    // The page list as it was before pageExclude: negation patterns only.
    const config = path.join(siteCopy, '.vitepress/config.mts')
    const source = fs.readFileSync(config, 'utf8')
    assert.equal(source.split(EXCLUDE).length - 1, 1, 'the config lists the pageExclude entries once')
    fs.writeFileSync(config, source.replace(EXCLUDE, 'srcExclude: ['))
  }
  return { siteCopy, marker, markers }
}

function build(siteCopy) {
  const cli = path.join(siteCopy, 'node_modules/vitepress/bin/vitepress.js')
  const r = spawnSync(process.execPath, [cli, 'build'], {
    cwd: siteCopy,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' }
  })
  assert.equal(r.error, undefined, `the build did not run: ${r.error}`)
  assert.equal(r.signal, null, `the build was cut off: ${r.signal}`)
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` }
}

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dx-site-code-'))
})
after(() => fs.rmSync(work, { recursive: true, force: true }))

test('a paths file in playbook content fails the build with its path, before it runs', () => {
  const { siteCopy, marker } = fixture('guarded', { bypassCheck: false })
  const { status, output } = build(siteCopy)
  assert.notEqual(status, 0, output)
  assert.ok(refusal(output, PAYLOAD), output)
  assert.equal(fs.existsSync(marker), false, 'the payload ran')
})

test('negative control: with the check taken out, the same build runs the payload', () => {
  const { siteCopy, marker } = fixture('bypassed', { bypassCheck: true })
  const { output } = build(siteCopy)
  assert.equal(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8'), 'ran', output)
})

test('a directory link to a dynamic route is refused too, before the route runs', () => {
  const { siteCopy, marker } = fixture('linked', { bypassCheck: false, linkedRoute: true })
  const { status, output } = build(siteCopy)
  assert.notEqual(status, 0, output)
  assert.ok(refusal(output, LINK, ' (symbolic link)'), output)
  assert.equal(fs.existsSync(marker), false, 'the payload ran')
})

test('negative control: with the check taken out, the linked route runs the payload', () => {
  const { siteCopy, marker } = fixture('linked-bypassed', { bypassCheck: true, linkedRoute: true })
  const { output } = build(siteCopy)
  assert.equal(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8'), 'ran', output)
})

test('a paths directory with an index.jsx is refused too, before it runs', () => {
  const { siteCopy, marker } = fixture('dir-paths', { bypassCheck: false, dirPaths: true })
  const { status, output } = build(siteCopy)
  assert.notEqual(status, 0, output)
  assert.ok(refusal(output, PAYLOAD), output)
  assert.equal(fs.existsSync(marker), false, 'the payload ran')
})

test('negative control: with the check taken out, the paths directory runs the payload', () => {
  const { siteCopy, marker } = fixture('dir-paths-bypassed', { bypassCheck: true, dirPaths: true })
  const { output } = build(siteCopy)
  assert.equal(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8'), 'ran', output)
})

test('a dynamic route beside the playbook directories is not a page: the build never loads its paths file', () => {
  const { siteCopy, markers } = fixture('siblings', { bypassCheck: false, siblings: true })
  const { status, output } = build(siteCopy)
  assert.equal(status, 0, output)
  for (const { dir, file } of markers) {
    assert.equal(fs.existsSync(file), false, `the payload in ${dir} ran`)
  }
})

test('negative control: with the page list back at the negation patterns, the payloads beside the playbooks run', () => {
  const { siteCopy, markers } = fixture('siblings-negations', { bypassCheck: false, bypassExclude: true, siblings: true })
  const { output } = build(siteCopy)
  for (const { dir, file } of markers.filter(({ dir }) => SIBLINGS.includes(dir))) {
    assert.equal(fs.existsSync(file) && fs.readFileSync(file, 'utf8'), 'ran', `${dir}: ${output}`)
  }
})
