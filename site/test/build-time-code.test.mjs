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
function fixture(name, { bypassCheck, linkedRoute = false, dirPaths = false }) {
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
  const payload = (param) =>
    `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, 'ran')\nexport default { paths: () => [{ params: { ${param}: 'a' } }] }\n`
  if (linkedRoute) {
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
  return { siteCopy, marker }
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
