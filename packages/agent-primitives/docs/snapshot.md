# `snapshot`

Capture read-only fingerprints for one physical Git checkout. Paths are
root-relative even when `-C` names a subdirectory.

```bash
agent-primitives snapshot
agent-primitives -C ./project snapshot --output /tmp/project-before.json
```

The command writes a versioned `agent-primitives-snapshot/v1` JSON artifact.
The default is a unique `snapshot-*.json` file in the resolved log directory.
An explicit output path is resolved against `-C`. Artifact and log paths must
resolve outside the checkout and its Git administrative directories, including
symlink aliases. Existing files are never overwritten. Parent directories are
created outside the checkout. Exit `0` means the full artifact was written;
exit `2` means capture or persistence could not conclude.

Stdout uses the usual [bounded envelope](output-shape.md): `artifactPath`,
checkout identity, HEAD/branch and entry counts. It never contains the canonical
artifact. Reducing stdout cannot truncate the saved artifact. Failure reporting
writes no full-result log, including when the requested log directory is unsafe.

The artifact records physical root, per-worktree Git directory and common Git
directory; nullable HEAD (unborn) and symbolic branch (detached); every index
path/stage/mode/object ID, including conflict stages; nonignored untracked
paths; and working-tree SHA256 fingerprints. Files use raw bytes and executable
permission bits. Symlinks use target bytes without reading the target. Missing
tracked files are explicit. Tracked files are included even when ignored.
The artifact contains hashes and metadata, never file contents or backups.

Git calls use argv, optional locks disabled, fsmonitor disabled, ten-second
command timeouts and 32 MiB output limits. Git environment settings are scrubbed;
repository/index/object/config redirections are refused. No filters or hooks
are executed. Unsupported modes/types, sparse checkouts, gitlinks/submodules,
nested nonignored repositories, non-UTF-8 paths and symlink ancestors fail
explicitly. Whitespace, newlines, tabs and leading dashes in UTF-8 names work;
backslash path names are unsupported in this format. Special files are refused
unless ignored and untracked.

Capture repeats Git identity/HEAD/index/untracked inventory and checks file
identity, mode, size and modification/change times around hashing and at the
end. Detected changes fail. This is a best-effort observation, not an atomic
global snapshot or protection against hostile concurrent path replacement.
The saved artifact input/output limit is 32 MiB; each entry collection is
limited to 100,000 entries. File hashing uses a fixed-size buffer.

Index flags (including assume-unchanged), timestamps, owners, xattrs, empty
directories and ignored untracked files are excluded. No recursive submodule
support, rename inference, author attribution, restore or automatic test reuse
is provided. See [`delta`](delta.md) for comparison.
