# dsh-git-worktrees

One git worktree per task, as a bundle of its own.

Two agents editing one checkout fight over the index: one stages the other's
half-finished file, and a `git status` that was clean a moment ago is not. A
linked worktree per task is the fix — its own HEAD, its own index, shared
history — and this package is the worktree half of `dsh-git`, extracted so it
can be installed, versioned and unloaded on its own.

## What it owns

- The `worktree` tool: `start`, `list`, `remove`.
- The edit guard: a `tools/pre-execute` listener that refuses a file edit which
  would land in a repository sitting on a protected branch — or, with
  `autoWorktree: always`, in any repository this session has no worktree for —
  and points at action `start` instead. It never creates the worktree itself: a
  guard with a side effect on a refused call creates a worktree for every edit
  somebody abandons, and teaches nothing about why the write stopped.

It does not commit, push, open pull requests or prune branches — that is
`dsh-git`'s job. The only thing it writes besides worktrees is the core's
per-session record of which worktrees a session owns.

Installed beside `dsh-git` with that bundle's own worktree enforcement on, two
guards answer the same edit; the first refusal is the one the caller sees, so
enable one of them.

## The three actions

| action | what it does |
| --- | --- |
| `start` | Creates the task worktree — branch `<branchPrefix><slug>`, cut from `origin/<base>` when that ref exists, at `<worktreeRoot>/<repo>/<slug>` — and returns its path. A second call with the same slug returns the worktree this session already owns rather than creating a second one and splitting the work. The worktree is recorded in the core's state store. |
| `list` | Runs `git worktree list --porcelain` for the repository and reports each entry: path, branch, head, detached / locked / prunable, whether it is the main checkout, and whether this bundle created it (decided by the ownership marker beside the worktree, never derived from a path and a slug). Reads only. |
| `remove` | Removes one worktree. A dry run unless `apply: true`, so the first call deletes nothing and says what would happen. The main checkout is never removed. A worktree this bundle did not create is refused unless `force: true`; one with uncommitted changes is refused unless `force: true`, and the refusal names the paths. |

Parameters: `action` (required; one of `start`, `list`, `remove`), `repo`,
`base`, `slug`, `task`, `apply`, `force`. The tool description carries the
per-action meaning of each.

`repo` names the repository, or any directory inside it, or a linked worktree
itself — the path `start` returned. With `remove`, the worktree is named by
`slug`, or by a `repo` that points at it, or, when this session owns exactly
one worktree for that repository, by neither.

## Settings

| setting | default | meaning |
| --- | --- | --- |
| `worktreeRoot` | `null` → `<cwd>/.worktrees` | Where worktrees live. Each task gets `<worktreeRoot>/<repo>/<slug>`. A relative value is resolved against the session's working directory. The default sits inside the session workspace — where a file sandbox permits writes — and outside every repository, so there is nothing to add to `.gitignore`. |
| `autoWorktree` | `'protected'` | When a file edit is refused. `off`: never (the tool still creates worktrees on request). `protected`: refuse an edit to a repository on a protected branch. `always`: refuse any edit to a repository this session has no worktree for. A branch with no commits yet is never treated as protected, because no worktree can be cut from an unborn HEAD. |
| `worktrees` | `true` | Boolean shorthand over the two settings below it. `true` means `autoWorktree: protected` with `protectedBranches: ['main', 'master']`; `false` means `autoWorktree: off` and no protected branches. A named key beside it wins. |
| `protectedBranches` | `['main', 'master']` | Branch names, matched exactly against the checked-out branch. This is this bundle's own list, not GitHub branch protection, which is a server-side rule it never consults. An explicit `[]` protects nothing. |
| `branchPrefix` | `'dsh/'` | Namespace for task branches: the branch for a slug is `<branchPrefix><slug>`. |
| `stateRoot` | `null` → the core's default | Where the core keeps the per-session record of owned worktrees. `null` leaves the core's own default in place (`$DSH_HOME/state`, else `~/.dsh/state`). |

An unknown `autoWorktree` value falls back to the default rather than leaving
the bundle half-configured, and an unknown key is dropped.

Settings are changed by overriding this bundle's row in the profile's patch
layer:

```yaml
- id: dsh-git-worktrees
  config:
    autoWorktree: always
    protectedBranches: [main]
```

An override replaces the row's `config` wholesale, never deep-merges it, so
restate every field you want to keep. There is no Configure page and no config
block in this bundle's own patch: every field has a default.

## Dependency: dsh-git-core

The git commands, the state store and the merge proofs live in `dsh-git-core`,
declared as `link:../dsh-git-core`. A `link:` install does not hoist a bundle's
dependencies, so a bare `import 'dsh-git-core/git.mjs'` would not resolve from
this package; the shims in `lib/` (`git.mjs`, `state.mjs`, `merge-proof.mjs`)
re-export the core through `lib/core-loader.mjs`, which probes the sibling
directory, the profile's `node_modules` and the working directory, and fails
with a sentence naming what to install instead of a bare
`ERR_MODULE_NOT_FOUND` at activation. Install `dsh-git-core` beside this
bundle.

## Files

- `index.js` — the Cordis plugin: `name`, `inject`, `apply`.
- `lib/tool.mjs` — the `worktree` tool.
- `lib/worktree-guard.mjs` — the `tools/pre-execute` guard.
- `lib/worktrees.mjs` — worktree creation and removal, ownership markers, and the path and branch naming rules.
- `lib/config.mjs` — this bundle's settings, with no schema library.
- `lib/git.mjs`, `lib/state.mjs`, `lib/merge-proof.mjs` — shims over `dsh-git-core`.
- `lib/core-loader.mjs` — resolves the core, wherever it is installed.
