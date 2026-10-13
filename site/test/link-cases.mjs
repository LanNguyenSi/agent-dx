// Link values shared by the unit tests and the build tests of the frontmatter
// link check (raw-output.mjs, isSafeLink).

// Relative values with no scheme and no leading "//" that the default theme
// still writes as "//evil.example/...": it parses the value and writes the
// parsed path back, so dot segments before a double slash leave a leading
// "//", and a "$" pattern in the path is expanded by the replacement it goes
// through. VitePress does not mark such a link as external, and the browser
// reads it as another site.
export const themeOffsite = [
  '/.//evil.example/x',
  '/%2e//evil.example/x',
  '/%2E//evil.example/x',
  '/././/evil.example/x',
  '/a/..//evil.example/x',
  'a/..//evil.example/x',
  '%2e%2e//evil.example/x',
  'x/../..//evil.example/deep',
  '/.//evil.example/x.md',
  '/.//evil.example/x?q=1#h',
  '/$1/evil.example/x',
  "/$'/evil.example/x",
  '/$&.evil.example',
  '/$1/evil.example/x?q=1#h'
]

// Values that stay: they resolve on the site however the theme rewrites them.
// Each carries no "evil.example", so a build test can look for that text.
export const keptRelative = [
  '/a/b',
  '/a/b/',
  './x',
  '../x',
  '../../x',
  '/a//b',
  './/e/x',
  '..//e/x',
  'a/b',
  'a/b/../c',
  '/a/./b',
  '/a/b?x=1#h',
  '/a/b.md',
  '/x/$$/y',
  '/a?$&',
  '#frag',
  '?q=1'
]
