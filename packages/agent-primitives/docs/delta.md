# `delta`

Compare a saved full [`snapshot`](snapshot.md) with the same physical checkout
now, including changes to files that were already dirty when captured.

```bash
agent-primitives -C ./project delta --since /tmp/project-before.json
```

`--since` resolves against `-C`. The saved artifact is bounded to 32 MiB and
validated before capture: format/version, hash algorithms, checkout identity,
object IDs, safe paths, unique stages/entries and plausible index/untracked/
working-tree membership. Nonregular inputs and symlinks are refused. Artifact
fields are data; no saved path is used to read checkout files or execute code.
Alternate checkouts are refused, including linked worktrees with a shared Git
common directory. Moving the checkout invalidates its physical identity.

The bounded console result separates `head` and `branch` changes (a before/
after pair, or null), `index` and `workingTree`. Each latter field has sorted
`added`, `modified` and `deleted` path arrays. Index changes compare all stages,
modes and object IDs per path. Working-tree changes compare presence, type,
executable bit and raw-byte hash. A tracked missing file counts as absent in
the working-tree comparison. Staging an already dirty file changes only the
index when its working bytes stay the same. Renames appear as deletion and
addition. Additions/deletions describe paths entering/leaving observed inventory,
not proof of physical creation/deletion: an untracked file that becomes ignored
leaves that inventory. Snapshot timestamps and serialization ordering do not affect results.

Exit codes:

- `0`, `status: "ok"`, `changed: false`: unchanged.
- `1`, `status: "fail"`, `changed: true`: at least one observed change.
- `2`, `status: "error"`: cannot conclude (invalid artifact, wrong checkout,
  unsupported state, unstable observation, Git/read/persistence error).

Large results use the common envelope reduction with the full result in an
external log directory. Log paths must resolve outside the checkout and its
Git administrative directories. Failures write no full-result logs.
Snapshot's observation and unsupported-state boundaries also apply to delta.
The result describes differences, not who made them or whether prior tests
can be reused.
