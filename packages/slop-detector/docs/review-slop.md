# review-slop rule pack

Opt in with `--pack review-slop`. Catches run-local review tokens (finding ids, round references, workspace-handoff phrases) leaking into reusable content; see the [rule pack reference](rule-packs.md) for the full pack table.


Opt in with `--pack review-slop`. Three rules catch run-local review
tokens: content that only means something inside the one review cycle (or
the one workspace's handoff process) that produced it, and reads as dead
or misleading the moment that cycle is over.

- **`finding-id`** (block): a finding shorthand like `F1` or `F2a` (a
  capital `F`, exactly one digit, an optional lowercase letter), only
  resolvable against the review cycle that minted it. `F1-2026` (a
  version- or date-shaped token immediately followed by a hyphen and a
  digit) never matches; an isolated `F1`/`F5`-shaped word with no other
  review-process context (a Formula 1 reference, a function key) is not
  otherwise disambiguated, since this pack does not do LLM-judged
  precision -- see "Negative fixtures" below. The same shape also
  matches a severity-letter id -- `H1`, `M2`, `L3`, `C4` (high, medium,
  low, critical), same digit-plus-optional-letter shape and hyphenated-
  year exclusion as the `F` form -- but, unlike the `F` form, only when
  the same sentence also carries a review-process word (`review`,
  `reviewer`, `reviewed`/`reviews`/`reviewing`, `finding`/`findings`,
  `fix`/`fixed`/`fixes`/`fixing`, or
  `round`/`rounds`): left ungated, these four letters would swallow
  plain vocabulary far more often than a capital `F` does (`H1`-`H6`
  heading levels, `M1`-`M3` chip generations, `L1`/`L2` cache layers, a
  `C4` hazmat class), so `the M1 chip` and `an L2 cache` stay clean only
  while their sentence carries no review-process word, and `(M1)` in a
  sentence that also mentions a review or a fix still fires. This is a
  coarse gate, not disambiguation: it clears a sentence because no
  review-process word shares it, not because the pack understood the
  sentence's topic, so a genuine bug-fix sentence that happens to name
  one of these letters -- `This fix makes the M1 build reproducible.`
  or `We fixed the L2 cache eviction bug.` -- still fires, as a known,
  accepted false positive; `review.allow` (or `review.allowPaths`) is
  the escape hatch for such a line, not a smarter gate.
- **`round-reference`** (block): `round 2`, `R3`, `review round 1 fixes`,
  same problem, for the round itself rather than a specific
  finding inside it. A digitless `review round` never matches, at any
  severity (the kit's own vocabulary for its own review-round mechanism
  uses this exact phrase); `round N` and a bare `RN` token only match
  when the same sentence also carries a review-process word (`review`,
  `reviewer`, `reviewed`, `reviews`, `reviewing`, `finding`, `fix`, or --
  for the bare token -- `round` itself), so an
  unrelated `round 2 of the DNS retry` or a Cloudflare `R2` bucket is
  left alone. "The same sentence" is bounded by a `.`, `!` or `?`, a
  blank line, a Markdown heading line, or the start of a list item: a
  `## Review rounds` heading, or a previous bullet, does not lend its
  words to the bullet below it, while one list item's own soft-wrapped
  continuation line is still part of the same sentence. Inside a source
  comment the window is narrower: each `//` comment is its own window,
  and inside a block comment each ` * ` gutter line starts a new one, so
  a context word on the previous comment line does not count.
- **`handoff-phrase`** (warn): `per the <workspace> handoffs` (e.g.
  `per the pandora handoffs`), points a reader at a workspace's own
  operating layer that a package shipped to other repos has no access
  to.

All three scan the same four surfaces: Markdown files (`.md`/`.mdx`/
`.markdown`), TypeScript/JavaScript source comments (line and block),
test titles, and a commit-message file (see "Commit-message mode"
below).

A test title is the first string-literal argument of an `it`/`test`/
`describe` call, including a chained modifier
(`.only`/`.skip`/`.each`/`.concurrent`/`.for`, up to two deep, so
`it.only.each` counts) and the curried `.each` forms where the title sits
in the outer call: ``it.each(table)("title", fn)`` and
``it.each`table`("title", fn)``. A title built by template literal or
string concatenation rather than a plain string literal is not scanned,
and neither is a string literal outside a test call.

```markdown
<!-- BLOCKED by review-slop/finding-id and review-slop/round-reference -->
Fixed per finding F5 in review round 2; F2/F5 crossover handled in R3.
```

```ts
// BLOCKED by review-slop/finding-id and review-slop/round-reference
// Mutation-check intent (F1, review R1)
it("F2a: does not regress the earlier fix", () => {
  /* ... */
});
```

```markdown
<!-- clean: no run-local review token -->
Fixed the off-by-one in the paginator; added a regression test.
```

**Negative fixtures that stay clean by design**, so the pack doesn't
punish adjacent, unrelated content: an 8-char lowercase-hex tracker id
(a workspace's own convention, a different shape than `F`/`R` plus
digits), `round-trip`, a version number (`v1.2.3`, `1.0`), a bare plural
`rounds` with no digit or `review` prefix, a two-digit `F`-number
(`F16`, `F22`, a function-key range) or an `F1-2026`-shaped token, a
hyphenated `round-2` cross-reference (`round-reference` requires
whitespace, not a hyphen, before the digit), a bare `R2`/`R3`/`R1`-shaped
token with no review-process word in its sentence (a Cloudflare `R2`
bucket, `DeepSeek-R1`, a model name), and a code-block label like an
`R1` resistor or an `F1` JSON key inside a fenced (backtick- or
tilde-delimited) code block: fenced and inline code spans are stripped
from Markdown before either rule runs, the same way `prose-slop`'s rules
already skip code spans. A fence is recognized only where one actually
opens a code block: at the start of a line, with at most three spaces of
indentation, both for the opener and the closer. A mid-sentence run of
three backticks or tildes (prose *about* fences, a `~~~` used as a
visual separator) therefore does not open anything, and does not blank
the prose up to the next such run. (An indented, four-space code block
is *not* stripped -- only a fenced one -- so a review token inside one
still flags; wrap it in a fence, or add it to `review.allow`, instead.)

**Commit-message mode.** `check --stdin-path COMMIT_MSG` (or a path
ending in `COMMIT_EDITMSG`/`.commitmsg`, e.g. a real `.git/COMMIT_EDITMSG`
git-hook file) is scanned the same way a Markdown file is:

```bash
git log -1 --format=%B HEAD | node packages/slop-detector/dist/cli.js check --stdin-path COMMIT_MSG --pack review-slop
```

`check` also takes more than one path (`check fileA fileB --pack
review-slop`, or `--pack review-slop fileA fileB`, either ordering): each
is scanned and folded into one combined result, and the same file named
twice is scanned once rather than counted twice.

`--stdin-path` only applies when reading stdin (no path given, or a bare
`-`); passing it together with a real path is a usage error (exit `2`).
So is reading stdin with nothing to read, and emptiness is the predicate
there, not whether stdin is a terminal: a TTY, `< /dev/null`, an empty
pipe and a whitespace-only pipe all exit `2` with a message naming
`--stdin-path`, because a clean report over an empty document reads as
"checked, found nothing" when in fact nothing was checked. A stdin that
is opened but never written to and never closed (an inherited, non-TTY
stream with no writer, which is what a CI step or an agent harness
spawning the CLI with stdio inherited hands it) used to hang forever; it
is now bounded by a 10-second first-byte timeout that is armed once,
before the first byte, and cleared for good the moment any data arrives,
and reports the same usage error. `SLOP_DETECTOR_STDIN_TIMEOUT_MS`
overrides that bound. Trade-off: only the never-written case is bounded; a
producer that writes some data and then stalls forever mid-stream is an
ordinary pipe hang again, not a timed-out usage error, since a producer
that has proven it is alive is trusted to keep going -- and a whitespace-only
first chunk counts as proof too, since the timeout clears on any data
regardless of content and the emptiness check only runs after `end`, so a
whitespace-only chunk followed by a stall disarms the guard the same way a
real one does.

**Configuration.**

```yaml
# slop.config.yml
packs:
  review-slop: true

review:
  allow:
    - "R1"
  allowPaths:
    - "**/CHANGELOG.md"
```

`review.allow` is a regex allowlist with the same per-span semantics as
`placement.allow`: a matched span is excused across every rule in the
pack, on every scanned surface (Markdown text, and a whole comment or
test title on the code surfaces). `review.allowPaths` is a glob allowlist
matched relative to the anchor described in [Path pattern
anchor](configuration.md#path-pattern-anchor); a whole file matching any pattern is
skipped by every rule in the pack. It defaults to `["**/CHANGELOG.md"]`
even without a config: a repo's changelog convention narrating rounds and
finding ids by design is a config-level allow, not a violation, so the
default excuses that file at the file level rather than forcing every
repo to add the same entry by hand.
