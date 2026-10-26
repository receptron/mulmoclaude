# fix: close the check-then-use race for file contents (#3573)

## Problem

Every containment check realpaths a path, checks it is inside the root, then uses the path
string. A component swapped to a symlink between the two syscalls is followed. Node `fs` has no
`openat` / `renameat` / `unlinkat`, so a descriptor-relative implementation is not available.

## What can be closed in portable Node, and how

**The trust anchor is the workspace, not the scope folder.** The scope folder (`artifacts/`, a
plugin's data or config folder) is something the agent can rename or replace; the workspace is
not (in Docker it is the mount root). So every check works from the anchor:

- `bindScope` records the anchor's bigint `dev` + `ino` when the call begins; it must still match
  at verification
- the scope is re-resolved under the anchor at every check (`scopeRealpath`): a scope that is, or
  becomes, a link out of the anchor is refused
- a real directory renamed into the scope's place from inside the anchor IS the scope from then
  on — the same as moving it there before the request, so nothing is gained by racing it

This replaced a per-scope root binding after three Codex findings on the same symbol (PR #3580
rounds 1–3: root replaced mid-call; scope already a link at call time; root swapped between the
host's check and the core call). Binding the scope enumerated ways to replace it; anchoring to
what cannot be replaced states the rule once.

**Reads (read / readBytes): closed.** Open first, then prove the descriptor is the
in-root file:

1. realpath the candidate; outside or missing → missing
2. `open` it (`O_RDONLY`, plus `O_NOFOLLOW` / `O_NONBLOCK` where the platform has them)
3. re-resolve the scope under the anchor and the candidate under the scope; `lstat` of it must have the
   same `dev` + `ino` (bigint) as `fstat` of the handle
4. read from the handle only

A swap before the open and back before the re-check leaves a handle whose inode is not the
in-root file's, so step 3 fails. A swap after step 3 does not matter: the handle is already bound.

**Writes: closed against anyone who cannot already write outside the workspace.** The staging file is created and verified, and the
rename lands in the directory that holds it:

1. confine the parent as today (`resolveWriteWithinRoot`, which mkdirs it)
2. create `<leaf>.<random>.tmp` with `wx` (+ `O_NOFOLLOW`)
3. re-resolve the scope under the anchor and the parent under the scope, and `lstat` the staging entry there: its
   inode must equal `fstat` of the handle — so the bytes are going into an in-root directory
4. write through the handle, close, rename staging → leaf in the directory holding it

The rename's source is the verified staging file under its random name, so it succeeds only where
that name reaches the staging inode: the verified directory, wherever it has been moved since
(Codex, PR #3580 round 2, accepted; pinned by a test), or a directory the actor could already
write. If the parent is swapped for a link after step 3, the source does not resolve in the link's
target and the rename fails with ENOENT — unless the actor put the staging name there first, by
planting a file or a hard link to the staging inode (round 4). Either needs write access to that
target, and an actor with it gains nothing: they can read the workspace and copy the bytes there
themselves. From the Docker sandbox, host directories are not visible and a hard link across the
mount fails (EXDEV). Closing it outright needs a descriptor-relative `renameat`.

## What stays best-effort (residual, documented)

- **readDir** — names of a swapped-in directory can leak (no content).
- **unlink** — no `unlinkat`; a parent swapped between the check and `unlink` deletes the
  same-named entry in the link's target.
- **stat / exists** — metadata and one bit, path-based as before: opening the file to verify
  would make an unreadable file throw EACCES where `stat` / `exists` answer today.
- **a write steered by someone who can write the target** — see above: a planted staging name or
  a hard link to the staging inode in the link's target, plus a parent swap before the rename.
- **a stray empty staging file** — a write whose parent was swapped before the staging file was
  created fails, and can leave that empty `<leaf>.<random>.tmp` in the link's target.
- **a real directory moved in** — a directory renamed into the scope (not linked) is inside it from
  then on; moving one in from outside the workspace needs write access to it already.
- **hard links** — an in-root hard link to an outside file IS that file, and the inode check
  cannot tell it apart. In Docker mode one cannot be made: the host outside the workspace mount is
  not visible and a hard link cannot cross the mount. In native mode (`DISABLE_SANDBOX=1`) Linux may
  allow it even without read access to the source when `fs.protected_hardlinks=0` — but the agent
  then runs with the user's own host access and could read the file directly, so the boundary these
  checks defend is the Docker one.

## Shape

- `packages/core/src/files/verified.ts`: `openVerifiedWithinScope`, `writeFileVerifiedInScope`,
  `scopeRealpath` (+ `VerifiedScope`), exported from `@mulmoclaude/core/files`. Core gets a minor bump; ranges swept.
- `createFileVerifiedInScope`, added later for the exclusive creates (`plans/fix-3573-files-route-create.md`): an
  `O_EXCL` open, then the same proof as the staging file, then the bytes through the handle.
- `server/plugins/confined-file-ops.ts` uses them for read / readBytes / write.
- Other `resolveWithinRoot` call sites (files.ts, pdf.ts, /artifacts static, …) migrate in
  follow-up PRs, one per site group — each can be reverted on its own.

## Tests

- core `test/files/test_verified.ts`: races simulated at `beforeOpen` / `afterOpen` /
  `beforeRename` hooks (a parent swapped to an outside symlink, and back) → read is refused,
  write throws, the outside file is untouched
- server: existing confined-ops suites stay green
