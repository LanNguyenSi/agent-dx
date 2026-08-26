# Log

A reserved doc's own citations still get the base checks, just not the
`--require-anchors` opt-in ones (`doc.isReserved`).

A string-anchored citation whose anchor is found but not on the range's
own last line: `src/note.md:1-2#"First line"`.

A full citation into a test file whose range straddles into another
block's own head line: `src/target.test.ts:4-10`.
