# dsh-git-worktrees

One git worktree per task, as a bundle of its own.

Two agents editing one checkout fight over the index: one stages the other's
half-finished file, and a `git status` that was clean a moment ago is not. A
linked worktree per task is the fix — its own HEAD, its own index, shared
history — and this package is the worktree half of the dsh-git family, kept
separate so it can be installed, versioned and unloaded on its own.

It is optional. [dsh-git-core](https://github.com/stansz/dsh-git-core) +
[dsh-git](https://github.com/stansz/dsh-git) is the minimum for the everyday
git flow with automatic commit and push. Install this bundle when you want each
task to land in its own worktree, and want an edit aimed at a protected branch
refused.

## What it contributes

Two things, both registered through `ctx.effect` so that unloading the row
removes the tool and the guard together:

- the `worktree` tool — actions `start`, `list`, `remove`.
- the edit guard — a `tools/pre-execute` listener on the mutating file tools.

It does not commit, push, open pull requests or delete branches; that is
dsh-git's business. Neither bundle imports the other; both depend on
`dsh-git-core` for the git operations layer, the state store and the merge
proofs.

## Install

`package.json` declares `"dsh-git-core": "link:../dsh-git-core"`. Install order is
[dsh-git-core](https://github.com/stansz/dsh-git-core) first, then this bundle and/or
[dsh-git](https://github.com/stansz/dsh-git); the dsh-git repository's install page
covers the profile side.

A `link:` install does not hoist a bundle's dependencies, so the shims in `lib/`
(`git.mjs`, `state.mjs`, `merge-proof.mjs`) re-export the core through
`lib/core-loader.mjs`. The loader probes the sibling directory, the profile's
`node_modules` and the working directory, and fails with a sentence naming the missing
core instead of a bare `ERR_MODULE_NOT_FOUND` at activation.

## The tool

One tool, named `worktree`, with three actions.

| action | what it does |
| --- | --- |
| `start` | Creates the task worktree at `<worktreeRoot>/<repo>/<slug>`, on branch `<branchPrefix><slug>`, cut from `origin/<base>` when that ref exists (else from the repository's default branch), and returns its path. `slug` defaults to `task`; `task` is the text recorded beside the worktree and defaults to the slug. A second call with the same slug returns the worktree this session already owns, or adopts one already registered at the path it would create — `reused: true` — rather than making a second one and splitting the work. The worktree is locked with reason `dsh`, so git will not prune a task that is still live, and recorded in the core's state store; if that record cannot be written the result says `recorded: false` and names what to do. |
| `list` | Runs `git worktree list --porcelain` for the repository and reports each entry: path, branch, head, detached / locked / prunable, whether it is the main checkout, and whether this bundle created it — decided by the ownership marker beside the worktree, never derived from a path and a slug. Reads only. |
| `remove` | Removes one worktree. A dry run unless `apply: true`, so the first call deletes nothing and says what would happen. The main checkout is never removed. A worktree with no ownership marker and no record in this session is refused unless `force: true`; one with uncommitted changes is refused unless `force: true`, and the refusal names the paths. After a removal, the ownership marker and the session's record of the worktree are dropped too. |

Parameters: `action` (required; one of `start`, `list`, `remove`), `repo`,
`base`, `slug`, `task`, `apply`, `force`. The tool description carries the
per-action meaning of each.

`repo` names the repository, or any directory inside it, or a linked worktree
itself — the path `start` returned. With `remove`, the worktree is named by
`slug`, or by a `repo` that points at it, or, when this session owns exactly
one worktree for that repository, by neither; more than one and the answer asks
for a `slug`.

Ownership is a small marker file written beside the worktree, not inside it —
at `<worktreeRoot>/<repo>/<slug>.owned.json` — so it is invisible to git and
still answers "did this bundle make it, or is it somebody's work?" before
anything is removed. When the worktree root ends up inside the repository
itself, this bundle also appends a per-clone entry to `.git/info/exclude` so
its own scratch is never reported by `git status` and never committed.

## Settings

| setting | default | meaning |
| --- | --- | --- |
| `worktreeRoot` | `null` → `<cwd>/.worktrees` | Where worktrees live. Each task gets `<worktreeRoot>/<repo>/<slug>`. A relative value is resolved against the session's working directory. The default sits inside the session workspace — where a file sandbox permits writes — and outside every repository, so there is normally nothing to add to `.gitignore`. |
| `autoWorktree` | `'protected'` | When a file edit is refused. `off`: never (the tool still creates worktrees on request). `protected`: refuse an edit landing in a repository sitting on a protected branch. `always`: refuse any edit landing in a repository this session has no worktree for. A branch with no commits yet is never treated as protected, because no worktree can be cut from an unborn HEAD. |
| `worktrees` | `true` | Boolean shorthand over the two settings below it. `true` alone means `autoWorktree: protected` with `protectedBranches: ['main', 'master']`; `false` alone means `autoWorktree: off` and no protected branches. A named `autoWorktree` beside it wins; a named `protectedBranches` list is kept whatever the shorthand says. The resolved value is always derived from the mode, and is `autoWorktree !== 'off'`. |
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

## The edit guard

Every other part of this bundle asks. The guard is the refusal.

- It fires on the mutating file tools — `write`, `edit`, `str_replace_editor`,
  `notebook_edit`, `apply_patch` — and on nothing else. A shell command can
  write a file, and reading a command well enough to know whether it will is an
  unbounded problem; gating every `bash` call would refuse `git status`, which
  is the one thing this bundle most wants a session doing freely.
- In `protected` it refuses an edit landing in a repository sitting on a
  protected branch; in `always` it refuses an edit landing in any repository
  this session has no worktree for; in `off` it never refuses.
- The refusal names the repository and the branch and points at the exact next
  step: run the worktree tool with action `start` (slug: something-short), then
  repeat the edit against the path it returns. The guard never creates the
  worktree itself — a guard with a side effect on a refused call creates a
  worktree for every edit somebody abandons, and teaches nothing about why the
  write stopped.
- "Inside the session's worktree" is decided by where the write *lands*: the
  target is resolved through its deepest existing ancestor with symlinks
  followed, and compared against the worktrees git still registers for the
  repository, at the paths this session owns. A link inside the worktree that
  points at the main checkout is therefore a write into main and is refused,
  while a new file whose path only passes through a symlinked directory that
  resolves inside the worktree is allowed.
- It is fail-soft: a check that cannot read the repository allows the edit,
  because a guard that breaks unrelated tool calls is worse than a guard that
  misses one.

The guard sees the agent's own tool calls and nothing else. The user's editor
and terminal are untouched.

## Dependency: dsh-git-core, and the shared state store

The git commands, the state store and the merge proofs live in
[dsh-git-core](https://github.com/stansz/dsh-git-core); this bundle carries no git
operations of its own.

What this bundle reads and writes there is the core's per-session state file,
`<stateRoot>/dsh-git/sessions/<safeSessionId>.json`: it records each worktree a
session owns with `addWorktree`, and drops the record with `removeWorktree`.
That is the same store [dsh-git](https://github.com/stansz/dsh-git) uses for its
push backoff — one store, two bundles, so an install of both writes one file per
session rather than two.

Installed without the core, this bundle fails at activation with the loader's
sentence naming the missing core rather than mounting half of itself.

## Files

- `index.js` — the Cordis plugin: `name`, `inject`, `apply`.
- `lib/tool.mjs` — the `worktree` tool.
- `lib/worktree-guard.mjs` — the `tools/pre-execute` guard.
- `lib/worktrees.mjs` — worktree creation and removal, ownership markers, and the path and branch naming rules.
- `lib/config.mjs` — this bundle's settings, with no schema library.
- `lib/git.mjs`, `lib/state.mjs`, `lib/merge-proof.mjs` — shims over `dsh-git-core`.
- `lib/core-loader.mjs` — resolves the core, wherever it is installed.
- `cordis.patch.yml` — the one inserted row.
