/**
 * dsh-git — one git worktree per task, with an owner.
 *
 * Two agents editing one checkout fight over the index: one stages the other's
 * half-finished file, and a `git status` that was clean a moment ago is not.
 * A linked worktree per task is the fix — its own HEAD, its own index, shared
 * history — but worktrees carry three traps of their own, and this module exists
 * to close them.
 *
 * The first is path identity. `git worktree list` reports realpaths, so on
 * macOS a worktree created under `/tmp` comes back as `/private/tmp`. A caller
 * comparing its own string against the list sees "no such worktree" for the one
 * that is right there, and then creates a second one or refuses to clean up.
 * Every comparison here goes through `sameFsPath`, which realpaths both sides.
 *
 * The second is deletion. `git worktree remove` refuses a dirty worktree for
 * good reason, and the naive fix — `--force`, or `rm -rf` — destroys work with
 * no error to notice. This module never forces on its own: a refusal comes back
 * as `ok:false` with the dirty paths named, and the caller decides.
 *
 * The third is ownership, which is why a small marker file is written next to
 * the worktree rather than inside it. Inside, it would show up as an untracked
 * file in every `git status` and could be committed by accident; outside, at
 * `<worktreeRoot>/<repo>/<slug>.owned.json`, it is invisible to git and still
 * answers "did dsh-git make this, or is it somebody's work?" before anything is
 * pruned.
 *
 * Only `node:` builtins are imported, and only relative imports reach the rest
 * of the bundle, so this file works wherever the bundle is installed.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  changedPaths,
  currentBranch,
  defaultBranchOf,
  isRepo,
  listWorktrees,
  run,
  toplevel,
} from './git.mjs';
import { isCommitId } from './merge-proof.mjs';

/**
 * Keep the plugin's own scratch out of the repository it works in.
 *
 * The worktree root is `<session workspace>/.worktrees` by default. That is
 * normally outside the repository, but a session can treat a repository as its
 * workspace, and then the root is *inside* the working tree. Everything under it
 * is the plugin's own scratch — worktrees, their ownership markers, and whatever a
 * test run leaves behind — yet `git status` reports all of it as untracked content,
 * and the turn sync stages everything `git status` reports.
 *
 * That is not hypothetical: fixture worktrees created by a suite became
 * `dsh: turn N` commits on task branches, and two of those branches were merged,
 * which put eight fixture files into `main`.
 *
 * `.git/info/exclude` is the right place for the rule. It is per-clone, never
 * committed, invisible to `git status`, to `.gitignore`, and to the user's diffs,
 * and it covers a scratch directory that did not exist when the clone was made.
 * Best effort by design: a repository whose exclude cannot be written is not a
 * reason to refuse work.
 *
 * @param {string} repoRoot - the repository's top level.
 * @param {string} root - the worktree root this session will use.
 * @param {object} gitOpts - signal and timeout for the git calls.
 */
async function excludeScratch(repoRoot, root, gitOpts) {
  try {
    const inside = relative(repoRoot, root);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return;

    const commonDir = await run(repoRoot, ['rev-parse', '--git-common-dir'], gitOpts);
    if (!commonDir.ok) return;
    const reported = String(commonDir.stdout).trim();
    if (reported === '') return;
    const gitDir = isAbsolute(reported) ? reported : resolve(repoRoot, reported);

    const file = join(gitDir, 'info', 'exclude');
    // Leading slash anchors the pattern to the repository root, and the trailing
    // slash keeps it to directories — a file named `.worktrees` stays visible.
    const pattern = '/' + inside.split(sep).join('/') + '/';
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (existing.split('\n').some((line) => line.trim() === pattern)) return;

    mkdirSync(dirname(file), { recursive: true });
    const header = existing.trim() === ''
      ? '# Written by dsh-git. Its worktree root is inside this repository, and'
        + '\n# scratch must never be committed. Per-clone: not tracked, not in .gitignore.'
      : '';
    const lead = header === '' ? (existing.endsWith('\n') ? '' : '\n') : header + '\n';
    appendFileSync(file, lead + pattern + '\n');
  } catch {
    /* best effort: an unwritable exclude must never refuse work */
  }
}

/** Longest slug kept; a branch name and a directory name both have to hold it. */
const SLUG_MAX = 50;

/**
 * A filesystem-safe slug for a task title.
 *
 * Lowercased, ASCII-folded, and reduced to `[a-z0-9-]`, because the slug becomes
 * both a branch name and a directory name. Never empty — a title made entirely
 * of non-Latin characters folds away, and an empty slug would mean a worktree at
 * the repository root. Everything outside the safe set becomes `-`, which also
 * makes `.` and `..` impossible, so a title can never escape its root.
 *
 * @param {string} text - the task title or any caller-supplied text.
 * @returns {string} 1-50 characters of `[a-z0-9-]`, never starting or ending
 *   with `-`, falling back to `task`.
 */
export function slugify(text) {
  const raw = text === undefined || text === null ? '' : String(text);
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/gu, '');
  return slug === '' ? 'task' : slug;
}

/**
 * Where a task's worktree lives: `<worktreeRoot>/<repo>/<slug>`.
 *
 * The repository name is kept as a directory level on purpose: several
 * repositories share one worktree root, and two of them can easily have a task
 * with the same title.
 *
 * @param {string} worktreeRoot - the parent directory for all worktrees.
 * @param {string} repoName - the repository's directory name; only its last
 *   path segment is used, so a name containing separators cannot escape.
 * @param {string} slug - the task slug.
 * @returns {string} an absolute path. Nothing is created here.
 */
export function worktreePathFor(worktreeRoot, repoName, slug) {
  const root = resolve(typeof worktreeRoot === 'string' && worktreeRoot.trim() !== '' ? worktreeRoot.trim() : '.');
  const segment = basename(String(repoName ?? ''));
  const repo = segment === '' || segment === '.' || segment === '..' ? 'repo' : segment;
  return join(root, repo, slugify(slug));
}

/**
 * The branch name for a task: `<prefix>/<slug>`.
 *
 * The prefix is cleaned rather than trusted, because it reaches `git worktree
 * add -b` as an argument and a space or a `..` in it would surface as a
 * confusing git error much later. A prefix may contain slashes (`task/agent`) —
 * that is how branch namespaces are built — but not the characters git refuses
 * in a ref name.
 *
 * @param {string} branchPrefix - e.g. `dsh` or `task/agent`.
 * @param {string} slug - the task slug.
 * @returns {string} a branch name such as `dsh/fix-the-thing`, or just the slug
 *   when the prefix is empty.
 */
export function branchNameFor(branchPrefix, slug) {
  const base = slugify(slug);
  const prefix = typeof branchPrefix === 'string' ? cleanBranchPrefix(branchPrefix) : '';
  return prefix === '' ? base : prefix + '/' + base;
}

/**
 * Whether a branch name lives under the plugin's own prefix.
 *
 * The branch must start with the prefix followed by the separator — `dsh/x`
 * yes, `dshx` no. A plain `startsWith` is not that test: with a configured
 * prefix of `task`, it also matches a user branch named `taskforce`, and the
 * sweep then treats somebody's branch as a plugin leftover. A prefix with no
 * slash still has to match a whole segment, which `prefix + '/'` enforces the
 * same way.
 *
 * @param {string} name - the branch name.
 * @param {string} branchPrefix - the configured prefix, with or without a slash.
 * @returns {boolean} true only for a name inside that namespace.
 */
export function isInsideBranchPrefix(name, branchPrefix) {
  if (typeof name !== 'string' || name === '') return false;
  const prefix = typeof branchPrefix === 'string' ? branchPrefix.replace(/\/+$/u, '') : '';
  if (prefix === '') return false;
  return name.startsWith(prefix + '/');
}

/** Drop the characters git refuses in a ref name, and the empty segments. */
function cleanBranchPrefix(prefix) {
  return prefix
    .split('/')
    .map((segment) => segment.replace(/[\s~^:?*[\]\\]+/gu, '-').replace(/\.+$/u, '').replace(/^\.+/u, ''))
    .filter((segment) => segment !== '')
    .join('/');
}

/**
 * Create (or re-adopt) the worktree for one task.
 *
 * The base is the remote-tracking `origin/<base>` when it exists, otherwise the
 * local `<base>`: a task branch must start from what the team has published, not
 * from whatever this checkout happens to have. `baseBranch` defaults to the
 * repository's default branch. Starting from a remote-tracking ref also means
 * git points the new branch's upstream at it, so `repoState` reports the task
 * branch's sync state against its base until the first push repoints the
 * upstream at the branch's own remote.
 *
 * Refusals are deliberate and are never worked around:
 *  - the branch is already checked out in another worktree → `ok:false` naming
 *    that path; never `--force`, never a detached worktree, because both would
 *    leave two worktrees fighting over one branch;
 *  - the path is already registered to a different branch → `ok:false`;
 *  - the path exists on disk but no worktree is registered there → `ok:false`,
 *    because it may be somebody's directory.
 *
 * If the exact path is already registered to exactly this branch, the
 * worktree is adopted instead: `reused:true`, with the lock and the ownership
 * marker repaired if they are missing.
 *
 * @param {string} repoDir - any directory inside the repository.
 * @param {object} opts
 * @param {string} opts.worktreeRoot - where worktrees live for this session.
 * @param {string} opts.branchPrefix - branch namespace, e.g. `dsh`.
 * @param {string} opts.slug - the task slug, normally from `slugify`.
 * @param {string} [opts.baseBranch] - branch to start from.
 * @param {string} [opts.task] - task text, recorded in the ownership marker.
 * @param {string} [opts.sessionFile] - session log path, recorded in the marker.
 * @param {AbortSignal} [opts.signal] - aborts the git calls.
 * @returns {Promise<{ok: boolean, path?: string, branch?: string, slug?: string,
 *   base?: string, reused?: boolean, error?: string}>} `path` is a realpath, so
 *   it compares equal to the paths `git worktree list` reports. On `ok:false`
 *   nothing is left behind: a worktree that could not be locked and marked is
 *   removed again, and so is the branch it was created for.
 */
/**
 * Delete a local branch, against a proof of the commit it points at.
 *
 * Callers are supposed to delete only what they have proved disposable — `prune`
 * removes a branch whose commits are all in the base, or one a merged pull request
 * covers. That guarantee used to live **only** in the callers, and this function
 * was a bare `git update-ref -d`: any caller that got its reasoning wrong deleted
 * whatever the name pointed at, and the name may have moved since the reasoning was
 * done. Worse, `update-ref` does not refuse a branch that a worktree has checked
 * out — it leaves that worktree with a broken HEAD — so the one case git itself
 * protects against elsewhere was unprotected here.
 *
 * So the proof is an argument. `tip` is the commit the caller believes this branch
 * points at, and it is required: an absent proof is a refusal, never a weaker
 * deletion. It is then both checked and *used* — `git update-ref -d <ref> <old>`
 * refuses the delete if the branch moved in between, so the proof is the condition
 * of the deletion rather than a claim made beside it.
 *
 * @param {string} repoRoot - the repository's top level.
 * @param {string} name - the branch name, without the `refs/heads/` prefix.
 * @param {object} gitOpts - signal and timeout for the git call.
 * @param {{tip: string}} proof - the commit that was proved disposable.
 * @returns {Promise<{ok: boolean, absent?: boolean, code?: string, error?: string}>}
 *   `absent: true` means there was no such branch, which is not a failure: the
 *   caller's goal is that the branch is gone.
 */
export async function deleteBranch(repoRoot, name, gitOpts, proof) {
  const branch = typeof name === 'string' ? name.trim() : '';
  if (branch === '') return { ok: false, error: 'a branch name is required' };

  const tip = typeof proof?.tip === 'string' ? proof.tip.trim() : '';
  if (!isCommitId(tip)) {
    return {
      ok: false,
      code: 'no-proof',
      error: 'deleting ' + branch + ' requires the commit it is believed to point at',
    };
  }

  // Asked on every delete, and a listing that fails refuses the delete instead of
  // answering "no worktree has it".
  const trees = await listWorktrees(repoRoot);
  if (trees === undefined) {
    return {
      ok: false,
      code: 'worktree-list-failed',
      error: 'the worktree registrations of ' + repoRoot + ' could not be read, so it is not known whether ' + branch + ' is checked out',
    };
  }
  if (trees.some((entry) => entry.branch === branch)) {
    return { ok: false, code: 'checked-out', error: 'refusing to delete ' + branch + ': a worktree has it checked out' };
  }

  const head = await run(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], gitOpts);
  const sha = head.ok ? String(head.stdout).trim() : '';
  if (sha === '') return { ok: true, absent: true };
  if (sha !== tip) {
    return {
      ok: false,
      code: 'tip-moved',
      error: 'refusing to delete ' + branch + ': it points at ' + sha.slice(0, 12)
        + ', not at the commit that was proved disposable (' + tip.slice(0, 12) + ')',
    };
  }

  const deleted = await run(repoRoot, ['update-ref', '-d', 'refs/heads/' + branch, tip], gitOpts);
  if (!deleted.ok) return { ok: false, error: deleted.error ?? 'could not delete ' + branch };
  return { ok: true };
}

export async function createWorktree(repoDir, opts = {}) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const root = typeof options.worktreeRoot === 'string' ? options.worktreeRoot.trim() : '';
  if (root === '') return { ok: false, error: 'worktreeRoot is required' };
  if (typeof options.branchPrefix !== 'string' || options.branchPrefix.trim() === '') {
    return { ok: false, error: 'branchPrefix is required' };
  }
  if (typeof options.slug !== 'string' || options.slug.trim() === '') {
    return { ok: false, error: 'slug is required' };
  }

  const gitOpts = { signal: options.signal, timeoutMs: options.timeoutMs };
  const repoRoot = (await toplevel(repoDir)) ?? realpathOr(resolve(repoDir));
  if (!(await isRepo(repoRoot))) {
    return { ok: false, error: repoRoot + ' is not a git repository' };
  }

  // Before the worktree exists, so the very first thing under it is already unseen by
  // `git status` — and before any failure path, because the exclusion is wanted either way.
  await excludeScratch(repoRoot, root, gitOpts);

  const repoName = basename(repoRoot);
  const slug = slugify(options.slug);
  const branch = branchNameFor(options.branchPrefix, slug);
  const path = worktreePathFor(root, repoName, slug);
  const base = await resolveBase(repoRoot, options.baseBranch, gitOpts);
  if (base.error !== undefined) return { ok: false, error: base.error };
  const baseRef = base.ref;

  // A listing that failed must not be read as "no worktree is registered there":
  // that answer creates a second worktree on top of a registered one, or a second
  // branch with the same name.
  const worktrees = await listWorktrees(repoRoot);
  if (worktrees === undefined) {
    return { ok: false, error: 'the worktree registrations of ' + repoRoot + ' could not be read, so no worktree was created' };
  }
  const atPath = worktrees.find((entry) => sameFsPath(entry.path, path));
  if (atPath !== undefined) {
    if (atPath.branch !== branch) {
      return {
        ok: false,
        error: 'the worktree path ' + atPath.path + ' is registered to branch '
          + (atPath.branch ?? '(detached HEAD)') + ', not ' + branch + '; use another slug',
      };
    }
    if (atPath.locked !== true) {
      await run(repoRoot, ['worktree', 'lock', '--reason', 'dsh', atPath.path], gitOpts);
    }
    writeMarker(markerPath(root, repoName, slug), markerRecord({ repoName, path: atPath.path, branch, slug, options }));
    return { ok: true, path: atPath.path, branch, slug, base: baseRef, reused: true };
  }

  const holder = worktrees.find((entry) => entry.branch === branch);
  if (holder !== undefined) {
    return {
      ok: false,
      error: 'branch ' + branch + ' is already checked out in the worktree at ' + holder.path
        + '; remove that worktree or use another slug, dsh-git will not force or detach',
    };
  }

  if (existsSync(path)) {
    return {
      ok: false,
      error: 'the path ' + path + ' already exists but is not a registered worktree; move it aside or use another slug',
    };
  }

  // `git worktree add -b` creates the branch before it populates the worktree, so
  // a failure — an unwritable path, a name collision, a full disk — leaves the
  // branch behind with no worktree to explain it. That orphan then refuses the
  // next attempt with "a branch named X already exists", which points at the
  // wrong cause entirely. Remember where the branch stood so a failure can
  // restore it exactly, newly created or not.
  const priorHead = await branchHead(repoRoot, branch, gitOpts);

  const added = await run(repoRoot, ['worktree', 'add', path, '-b', branch, baseRef], gitOpts);
  if (!added.ok) {
    const restored = await restoreBranch(repoRoot, branch, priorHead, gitOpts);
    return {
      ok: false,
      error: (added.error ?? 'git worktree add failed')
        + (restored ? '' : ' (and the branch it left behind could not be restored)'),
    };
  }
  const created = realpathOr(path);

  const locked = await run(repoRoot, ['worktree', 'lock', '--reason', 'dsh', created], gitOpts);
  if (!locked.ok) {
    const undone = await rollback(repoRoot, created, branch, priorHead, gitOpts);
    return {
      ok: false,
      error: 'created ' + created + ' but could not lock it (' + (locked.error ?? 'unknown error') + '); ' + describeRollback(undone),
    };
  }

  const marker = markerPath(root, repoName, slug);
  if (!writeMarker(marker, markerRecord({ repoName, path: created, branch, slug, options }))) {
    // Five arguments, like the call above: passing four bound `gitOpts` to
    // `priorHead` and left the branch behind, so the branch outlived the message
    // that said it was gone and the next attempt with this slug failed on the
    // orphan. `describeRollback` now reports each half instead of guessing.
    const undone = await rollback(repoRoot, created, branch, priorHead, gitOpts);
    return {
      ok: false,
      error: 'created ' + created + ' but could not write the ownership marker ' + marker + '; ' + describeRollback(undone),
    };
  }

  return { ok: true, path: created, branch, slug, base: baseRef, reused: false };
}

/**
 * The base ref a new worktree should start from.
 *
 * @returns {Promise<{ref?: string, error?: string}>} `error` when no base can be
 *   determined; never guesses a ref that does not resolve.
 */
async function resolveBase(repoRoot, requested, gitOpts) {
  let wanted = typeof requested === 'string' ? requested.trim() : '';
  if (wanted === '') {
    wanted = (await defaultBranchOf(repoRoot)) ?? (await currentBranch(repoRoot)) ?? '';
  }
  if (wanted === '') {
    return { error: 'cannot determine a base branch; pass baseBranch explicitly' };
  }
  if (wanted.startsWith('-')) return { error: 'baseBranch may not start with a dash' };

  if (!wanted.startsWith('origin/')) {
    const remote = await run(repoRoot, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/' + wanted], gitOpts);
    if (remote.ok) return { ref: 'origin/' + wanted };
  }
  const local = await run(repoRoot, ['rev-parse', '-q', '--verify', 'refs/heads/' + wanted], gitOpts);
  if (local.ok) return { ref: wanted };
  // A tag, a sha, or `origin/<branch>`: whatever it is, it has to resolve.
  const any = await run(repoRoot, ['rev-parse', '-q', '--verify', wanted], gitOpts);
  if (any.ok) return { ref: wanted };
  return { error: 'unknown base branch: ' + wanted };
}

/**
 * Remove a worktree, without destroying anything by surprise.
 *
 * The worktree is unlocked first (a lock survives a plain `remove`), then
 * removed with `git worktree remove` and no force. A refusal is the interesting
 * path and is reported with the files that caused it, so the caller can say
 * which ones are uncommitted instead of "removal failed"; the lock is put back
 * first, so a refused cleanup does not leave the worktree unprotected.
 *
 * `rm -rf` is never used: the only thing this function deletes is a directory
 * git itself agrees is a worktree and is clean.
 *
 * Ownership is asked of the marker beside the worktree, not of a slug the caller
 * may not know: a worktree dsh-git did not create is refused, however clean it
 * looks, and the dead-registration branch below is the same act on a directory
 * whose worktree is already gone.
 *
 * @param {string} repoDir - any directory inside the repository.
 * @param {string} path - the worktree path, as created or as `git worktree list`
 *   reports it; both forms compare equal.
 * @param {object} [opts]
 * @param {boolean} [opts.allowForeign] - remove a worktree with no ownership
 *   marker beside it. Default false: a missing marker means "not ours", and
 *   removal refuses. Only a caller whose own record already proves ownership — a
 *   session record, a marker scan — passes it; the caller-facing door is prune's
 *   `force`.
 * @param {boolean} [opts.force] - pass `--force`, for a caller that has already
 *   shown the user the dirty paths. Never implied.
 * @param {AbortSignal} [opts.signal] - aborts the git calls.
 * @returns {Promise<{ok: boolean, removed: boolean, owned?: boolean, code?: string,
 *   dirty?: string[], error?: string}>} `dirty` is present when uncommitted files
 *   are the reason removal failed, and `owned: false` when ownership is the
 *   reason. The main working tree is refused outright. A worktree whose directory
 *   is already gone has its registration dropped instead (unlock, then prune), so
 *   a lock cannot keep a dead entry alive forever.
 */
export async function removeWorktree(repoDir, path, opts = {}) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  if (typeof path !== 'string' || path.trim() === '') {
    return { ok: false, removed: false, error: 'no worktree path was given' };
  }
  const gitOpts = { signal: options.signal, timeoutMs: options.timeoutMs };
  const repoRoot = (await toplevel(repoDir)) ?? realpathOr(resolve(repoDir));
  const worktrees = await listWorktrees(repoRoot);
  if (worktrees === undefined) {
    return { ok: false, removed: false, error: 'the worktree registrations of ' + repoRoot + ' could not be read, so nothing was removed' };
  }
  const wanted = realpathOr(resolve(path.trim()));
  const entry = worktrees.find((candidate) => sameFsPath(candidate.path, wanted));
  if (entry === undefined) {
    return { ok: false, removed: false, error: wanted + ' is not a worktree of ' + repoRoot };
  }

  const main = worktrees[0];
  if ((main !== undefined && sameFsPath(main.path, entry.path)) || sameFsPath(entry.path, repoRoot)) {
    return { ok: false, removed: false, error: 'refusing to remove the main working tree ' + entry.path };
  }

  // Ownership, before anything is unlocked or removed, and before the branch of
  // this function that runs when the directory is already gone: unlocking a dead
  // foreign registration is exactly how one disappeared from a repository that
  // never created it. The marker beside the worktree is the whole answer, and a
  // caller whose own record already proves ownership passes `allowForeign`
  // explicitly. Nothing infers it, so nothing removes a stranger's checkout.
  if (options.allowForeign !== true && !isOwnedWorktreePath(entry.path)) {
    return {
      ok: false,
      removed: false,
      code: 'not-owned',
      owned: false,
      error: 'refusing to remove ' + entry.path + ': dsh-git did not create it (no ownership marker beside it). '
        + 'Pass allowForeign to remove it anyway.',
    };
  }

  if (!existsSync(entry.path)) {
    // The directory is gone but the registration is not — and because dsh-git
    // locks what it creates, plain `git worktree prune` skips it, which would
    // leave a dead entry that no surface can clear. Removing it was an explicit
    // request, so the lock comes off and the registration goes; there is no
    // working tree left to lose.
    await run(repoRoot, ['worktree', 'unlock', entry.path], gitOpts);
    const pruned = await run(repoRoot, ['worktree', 'prune'], gitOpts);
    if (!pruned.ok) {
      return { ok: false, removed: false, error: pruned.error ?? 'git worktree prune failed' };
    }
    const still = await listWorktrees(repoRoot);
    if (still === undefined) {
      return { ok: false, removed: false, error: 'the worktree registrations of ' + repoRoot + ' could not be read after pruning ' + entry.path };
    }
    if (still.some((candidate) => sameFsPath(candidate.path, entry.path))) {
      return { ok: false, removed: false, error: entry.path + ' is registered but its directory is gone, and the registration could not be pruned' };
    }
    removeMarker(dirname(entry.path), basename(entry.path));
    removeEmptyParent(entry.path);
    return { ok: true, removed: true };
  }

  const dirty = await changedPaths(entry.path, gitOpts);
  // A lock blocks even a forced removal, so it comes off first — and goes back
  // on if the removal is refused, because a failed cleanup must not also leave
  // the worktree unprotected.
  const wasLocked = entry.locked === true;
  if (wasLocked) await run(repoRoot, ['worktree', 'unlock', entry.path], gitOpts);

  const args = ['worktree', 'remove'];
  if (options.force === true) args.push('--force');
  args.push(entry.path);
  const out = await run(repoRoot, args, gitOpts);

  if (!out.ok) {
    if (wasLocked) {
      await run(repoRoot, ['worktree', 'lock', '--reason', entry.lockReason ?? 'dsh', entry.path], gitOpts);
    }
    const result = { ok: false, removed: false, error: out.error ?? 'git worktree remove failed' };
    if (dirty.length > 0) {
      result.dirty = dirty;
      if (options.force !== true) {
        result.error = 'the worktree has ' + dirty.length
          + ' uncommitted change(s); commit, stash, or discard them first — dsh-git does not force removal on its own';
      }
    }
    return result;
  }

  removeMarker(dirname(entry.path), basename(entry.path));
  removeEmptyParent(entry.path);
  return { ok: true, removed: true };
}

/**
 * Drop worktree registrations whose directory is gone.
 *
 * The dry run is the default, because the usual reason a registration is stale
 * is that somebody moved or deleted the directory by hand, and a prune is not
 * reversible. `opts.apply` is the explicit "yes, drop them".
 *
 * Entries are reported with the worktree's real path, taken from
 * `git worktree list` before the prune. `git worktree prune -v` prints only the
 * internal gitdir (`worktrees/<name>`), which is not a path any caller can act
 * on, so that form is used only for an entry the listing did not explain. A
 * locked entry whose directory is gone is reported too, with the lock named in
 * its reason, because `apply` will not remove it — that is what the lock is for.
 * A real prune also drops the ownership markers of the entries it removed, so
 * nothing claims a worktree that is gone; a dry run touches nothing.
 *
 * @param {string} repoDir - any directory inside the repository.
 * @param {object} [opts]
 * @param {boolean} [opts.apply] - actually prune; default false.
 * @param {AbortSignal} [opts.signal] - aborts the git calls.
 * @returns {Promise<{ok: boolean, dryRun: boolean, entries: {path: string, reason: string}[],
 *   error?: string}>} an empty `entries` means there was nothing stale, which is
 *   the normal answer and not a failure.
 */
export async function pruneWorktrees(repoDir, opts = {}) {
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const apply = options.apply === true;
  const gitOpts = { signal: options.signal, timeoutMs: options.timeoutMs };
  const repoRoot = (await toplevel(repoDir)) ?? realpathOr(resolve(repoDir));

  // Everything below this line is a claim about which worktrees exist, and the
  // branch sweep at the end of it deletes. A listing that failed cannot support
  // either, and read as an empty list it produced the worst answer available:
  // "nothing is stale" in the report, and "no worktree has this branch checked
  // out" in the sweep — which is precisely how a branch in a live worktree gets
  // deleted. There is no honest partial answer, so there is no partial answer.
  const before = await listWorktrees(repoRoot);
  if (before === undefined) {
    return {
      ok: false,
      dryRun: !apply,
      entries: [],
      error: 'the worktree registrations of ' + repoRoot + ' could not be read, so nothing was pruned and no branch was swept',
    };
  }
  const entries = [];
  // Identity is the path, and only the path. Deduping by basename as well meant a
  // second stale worktree that happened to share a directory name was never
  // reported and never had its marker cleaned — silently, because the first one
  // had answered for both. Two worktrees are two entries even when their last
  // path segment is the same.
  const seenPaths = new Set();
  const add = (path, reason) => {
    if (path === '' || seenPaths.has(path)) return;
    seenPaths.add(path);
    entries.push({ path, reason });
  };
  // git's own prune output names the internal gitdir (`worktrees/<name>`), which
  // is not a path a caller can act on, so it is reported only for an entry the
  // listing did not already explain. git derives that name from the worktree's
  // basename and appends a digit when two worktrees share one, so both forms are
  // matched here — against a set kept separate from the path set above, so the
  // reconciliation can never suppress a real second path again.
  const explained = new Set();
  const explainedBy = (name) => {
    const segment = basename(name);
    if (explained.has(segment)) return true;
    const withoutSuffix = segment.replace(/\d+$/u, '');
    return withoutSuffix !== '' && explained.has(withoutSuffix);
  };
  const addListed = (path, reason) => {
    add(path, reason);
    explained.add(basename(path));
  };

  // A registration is stale when the directory behind it is gone — checked
  // directly rather than trusted to `prunable`, because git does not mark a
  // *locked* worktree prunable, and dsh-git locks everything it creates.
  //
  // A lock protects work, so a lock whose directory is gone protects nothing:
  // there is no working tree left to hold an uncommitted or unpushed commit. Git
  // will not prune a locked entry at all and this tool has no unlock action, so
  // that case used to be permanent — an abandoned task left a registration no
  // code path could ever remove. `apply` therefore takes the lock off a dead
  // entry and says so. A *live* locked worktree is still reported and left
  // alone: dropping a lock that still guards a directory is the one thing this
  // must never do silently.
  const deadLocked = [];
  for (const worktree of before) {
    const missing = !existsSync(worktree.path);
    if (worktree.prunable !== true && !missing) continue;
    const detail = worktree.pruneReason ?? (missing ? 'the directory is gone' : 'prunable');
    if (worktree.locked !== true) {
      addListed(worktree.path, detail);
      continue;
    }
    if (missing) {
      deadLocked.push(worktree);
      addListed(worktree.path, detail + '; its lock is released to clear it');
      continue;
    }
    addListed(worktree.path, 'locked, so prune will skip it: ' + detail);
  }

  // Before the prune, never after: git skips a locked entry entirely, so the
  // lock has to be off for the very command that drops the registration.
  const notes = [];
  if (apply) {
    for (const worktree of deadLocked) {
      const unlocked = await run(repoRoot, ['worktree', 'unlock', worktree.path], gitOpts);
      notes.push(unlocked.ok
        ? 'released the lock on ' + worktree.path + ' (its directory is gone, so the lock protected nothing)'
        : 'could not unlock ' + worktree.path + ': ' + (unlocked.error ?? 'unknown error'));
    }
  }

  const out = await run(
    repoRoot,
    apply ? ['worktree', 'prune', '-v'] : ['worktree', 'prune', '-n', '-v'],
    gitOpts,
  );

  for (const line of (out.stdout + '\n' + out.stderr).split('\n')) {
    const match = /^\s*(?:Removing|Would remove)\s+(.+?):\s*(.*)$/u.exec(line);
    if (match === null) continue;
    const gitdir = match[1].trim();
    if (explainedBy(gitdir)) continue;
    add(gitdir, match[2].trim() === '' ? 'prunable' : match[2].trim());
  }

  if (!out.ok) {
    return { ok: false, dryRun: !apply, entries, error: out.error ?? 'git worktree prune failed' };
  }
  // A pruned worktree's ownership marker would otherwise outlive it and claim a
  // worktree that no longer exists. Only after a real prune, and only for the
  // entries git actually dropped: a locked entry that survived keeps its marker,
  // and a dry run touches nothing.
  if (apply) {
    // An unreadable listing leaves the markers where they are. Removing one is a
    // claim that the worktree is gone, and this is the only thing that cannot be
    // checked; a stale marker is a much smaller problem than one removed from a
    // worktree that still exists.
    const after = await listWorktrees(repoRoot);
    if (after !== undefined) {
      for (const entry of entries) {
        if (after.some((worktree) => sameFsPath(worktree.path, entry.path))) continue;
        removeMarker(dirname(entry.path), basename(entry.path));
      }
    }
  }

  // Orphaned task branches, from a creation that failed after git had already
  // made the branch. `createWorktree` now restores its own branch on failure, so
  // these are leftovers from an older build or a killed process.
  //
  // Deleting a branch is refused everywhere else on purpose — the guard denies
  // `git branch -D` because a branch may be checked out by a worktree or hold
  // unmerged commits. This is the one place it is safe, and the conditions are
  // the whole argument: the branch carries the plugin's own prefix, **no**
  // worktree has it checked out, and it holds no commit that is not already in
  // the base branch. A branch with any work of its own is reported, never
  // deleted.
  const branches = [];
  if (typeof options.branchPrefix === 'string' && options.branchPrefix !== '') {
    const trees = await listWorktrees(repoRoot);
    if (trees === undefined) {
      return {
        ok: false,
        dryRun: !apply,
        entries,
        error: 'the worktree registrations of ' + repoRoot + ' could not be read, so no branch was swept',
      };
    }
    const checkedOut = new Set(trees.map((entry) => entry.branch).filter((branch) => typeof branch === 'string'));
    // The object name comes back with the ref: it is the proof the delete needs,
    // and asking for it in the same call as the name means the two cannot disagree.
    const listed = await run(repoRoot, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads'], gitOpts);
    if (listed.ok) {
      for (const line of listed.stdout.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
        const split = line.indexOf(' ');
        const sha = split === -1 ? '' : line.slice(0, split);
        const name = split === -1 ? line : line.slice(split + 1);
        if (!isInsideBranchPrefix(name, options.branchPrefix) || checkedOut.has(name)) continue;
        // A commit that touches only the plugin's own scratch is not work. The
        // worktree root can end up inside the repository — the default is
        // `<session workspace>/.worktrees`, and a suite that runs the tool with no
        // session derives it from its own working directory — and the turn sync used
        // to stage everything under it. So a merged branch could carry a
        // `dsh: turn N` commit whose entire content is a fixture directory. Counting
        // those as 'commits of its own' kept the branch forever, and kept the sync
        // pushing it back to the remote after every merge.
        const args = ['rev-list', '--count', 'refs/heads/' + name, '--not', options.baseRef ?? 'HEAD'];
        const scratch = Array.isArray(options.scratchPaths)
          ? options.scratchPaths.filter((entry) => typeof entry === 'string' && entry !== '')
          : [];
        if (scratch.length > 0) args.push('--', '.', ...scratch.map((entry) => ':(exclude)' + entry));

        const unique = await run(repoRoot, args, gitOpts);
        const ahead = unique.ok ? Number.parseInt(unique.stdout.trim(), 10) : Number.NaN;
        if (Number.isFinite(ahead) && ahead === 0) {
          const record = {
            branch: name,
            sha: sha === '' ? undefined : sha,
            reason: scratch.length > 0
              ? "no worktree, and no commits of its own outside the plugin's scratch"
              : 'no worktree, and no commits of its own',
          };
          if (apply) {
            // The count above is the argument, the sha is the proof handed to the
            // delete, and the answer is reported: a branch this could not remove is
            // not a branch it removed.
            const gone = await deleteBranch(repoRoot, name, gitOpts, { tip: sha });
            record.deleted = gone.ok === true;
            if (gone.ok !== true) {
              record.error = gone.error;
              record.kept = true;
            }
          }
          branches.push(record);
        } else {
          branches.push({
            branch: name,
            reason: 'no worktree, but it holds ' + (Number.isFinite(ahead) ? String(ahead) : 'some') + ' commit(s) of its own, so it is kept',
            kept: true,
          });
        }
      }
    }
  }

  return { ok: true, dryRun: !apply, entries, branches, notes };
}

/**
 * Whether dsh-git created the worktree at this path.
 *
 * Checked before anything destructive: a worktree with no marker is somebody
 * else's, and pruning it would discard work this tool never knew about. The
 * marker lives beside the worktree, so the path is all a caller has to know
 * — and it is the form that cannot be handed the wrong number of arguments,
 * which is how every worktree this plugin created came to be reported as
 * somebody else's.
 *
 * The record's own `path` has to agree with the worktree it sits beside: a
 * marker left behind when a worktree moved would otherwise claim whatever
 * replaced it.
 *
 * @param {string} worktreePath - the worktree's directory.
 * @returns {boolean} false when the marker is missing, unreadable or malformed —
 *   "not ours" is the safe answer.
 */
export function isOwnedWorktreePath(worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath === '') return false;
  try {
    const marker = join(dirname(worktreePath), basename(worktreePath) + '.owned.json');
    const parsed = JSON.parse(readFileSync(marker, 'utf8'));
    if (typeof parsed?.path !== 'string' || parsed.path === '') return false;
    if (typeof parsed?.branch !== 'string') return false;
    return sameFsPath(parsed.path, worktreePath);
  } catch {
    return false;
  }
}

/**
 * Which worktree a directory is in.
 *
 * Used to answer "am I in the main checkout or in a task worktree?" before a
 * caller does something that only makes sense in one of them. Paths from
 * `parseWorktrees` are already realpath'd; the cwd is realpath'd here, so the
 * two meet. The longest matching path wins, because the main worktree's path is
 * a prefix of nothing here but nested worktrees do exist.
 *
 * @param {{path: string}[]} worktrees - the list from `listWorktrees`.
 * @param {string} cwd - the directory to place.
 * @returns {{worktree?: object, isMain: boolean, mainPath?: string}} the entry
 *   as it appears in the list (undefined when cwd is outside every worktree),
 *   whether it is the main worktree, and the main worktree's path. The first
 *   entry is the main worktree, which is the order git prints.
 */
export function findWorktreeForBranch(worktrees, cwd) {
  const list = (Array.isArray(worktrees) ? worktrees : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string');
  const mainPath = list.length > 0 ? list[0].path : undefined;

  let match;
  if (typeof cwd === 'string' && cwd !== '') {
    const target = realpathOr(resolve(cwd));
    for (const entry of list) {
      if (!isInside(target, entry.path)) continue;
      if (match === undefined || entry.path.length > match.path.length) match = entry;
    }
  }

  const isMain = match !== undefined && mainPath !== undefined && sameFsPath(match.path, mainPath);
  return { worktree: match, isMain, mainPath };
}

/** Whether a path is a worktree root or lives under one. */
function isInside(target, root) {
  if (sameFsPath(target, root)) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * Whether two paths are the same filesystem object.
 *
 * Both sides are realpath'd before comparison, which is the whole point: git
 * reports `/private/tmp/x` where the caller passed `/tmp/x`, and a plain `===`
 * says they differ. Case is folded on Windows only, matching the rest of this
 * profile's path handling.
 */
function sameFsPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const first = realpathOr(left);
  const second = realpathOr(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

/** realpath when the path exists, the path as given when it does not. */
function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `<worktreeRoot>/<repo>/<slug>.owned.json` — beside the worktree, not in it. */
function markerPath(worktreeRoot, repoName, slug) {
  const worktree = worktreePathFor(worktreeRoot, repoName, slug);
  return join(dirname(worktree), basename(worktree) + '.owned.json');
}

/** The ownership record written beside a worktree. */
function markerRecord({ repoName, path, branch, slug, options }) {
  const record = {
    repo: repoName,
    path,
    branch,
    slug,
    createdAt: new Date().toISOString(),
    sessionFile: sessionFileOf(options),
  };
  if (typeof options.task === 'string' && options.task.trim() !== '') record.task = options.task.trim();
  return record;
}

/** Where the session file is, as far as this process can tell. */
function sessionFileOf(options) {
  if (typeof options.sessionFile === 'string' && options.sessionFile !== '') return options.sessionFile;
  const fromEnv = process.env.DSH_SESSION_FILE;
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : null;
}

/** Write the ownership marker; false when the directory cannot be written. */
function writeMarker(marker, record) {
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the directory a worktree lived in, once nothing is left in it.
 *
 * Worktrees live at `<worktreeRoot>/<repo>/<slug>`, so retiring the last task
 * for a repository left `<worktreeRoot>/<repo>/` behind — observed holding
 * nothing but a `.DS_Store`, which is exactly the leftover a session is told it
 * does not have to think about. Only a directory with no content goes: another
 * worktree's directory or marker means the parent is still in use, and anything
 * else in there is somebody's, so it stays. Finder metadata is not content — the
 * suite's own scratch cleanup treats `.DS_Store` the same way, and leaving it
 * would mean the directory this exists to remove survives on every Mac.
 *
 * Best effort by design, like the marker removal above: a parent that cannot be
 * read or removed costs a leftover directory, never the removal that succeeded.
 *
 * @param {string} worktreePath - the worktree that was just removed.
 * @returns {boolean} whether the parent directory is gone.
 */
function removeEmptyParent(worktreePath) {
  const dir = dirname(worktreePath);
  try {
    const leftovers = readdirSync(dir).filter((name) => name !== '.DS_Store');
    if (leftovers.length > 0) return false;
    // Only the Finder metadata this rule ignores, and only explicitly: nothing
    // here ever deletes a directory tree.
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Forget a worktree's marker after it is gone. Failure costs nothing. */
function removeMarker(dir, name) {
  try {
    unlinkSync(join(dir, name + '.owned.json'));
  } catch {
    // No marker, or no permission: the next ownership check simply says "not ours".
  }
}

/**
 * Undo a worktree that was created but could not be locked or marked.
 *
 * Only ever called on a worktree this module created moments ago, which is why
 * the branch is deleted too: `git worktree remove` leaves the branch behind,
 * and a stray branch would make the next attempt with the same slug fail.
 */
/**
 * The commit a branch points at, or undefined when it does not exist.
 *
 * Used to undo a half-finished creation. `undefined` is the meaningful answer: it
 * distinguishes "this branch is ours to delete" from "this branch was already
 * here and must not be touched".
 */
async function branchHead(repoRoot, branch, gitOpts) {
  const out = await run(repoRoot, ['rev-parse', '-q', '--verify', 'refs/heads/' + branch], gitOpts);
  if (!out.ok) return undefined;
  const sha = out.stdout.trim();
  return sha === '' ? undefined : sha;
}

/**
 * Put a branch back where it was, or remove it when it did not exist.
 *
 * Restoring rather than deleting is what makes this safe to call on a branch the
 * caller did not create: an existing branch is moved back to its own previous
 * commit, which is invisible, instead of being force-deleted, which would
 * discard whatever it held.
 */
async function restoreBranch(repoRoot, branch, priorHead, gitOpts) {
  if (priorHead === undefined) {
    const gone = await run(repoRoot, ['branch', '-D', branch], gitOpts);
    return gone.ok;
  }
  const reset = await run(repoRoot, ['branch', '-f', branch, priorHead], gitOpts);
  return reset.ok;
}

async function rollback(repoRoot, path, branch, priorHead, gitOpts) {
  await run(repoRoot, ['worktree', 'unlock', path], gitOpts);
  const removed = await run(repoRoot, ['worktree', 'remove', path], gitOpts);
  const branchRestored = await restoreBranch(repoRoot, branch, priorHead, gitOpts);
  return { worktreeRemoved: removed.ok === true, branchRestored: branchRestored === true };
}

/**
 * What a rollback really undid, in words that match what happened.
 *
 * The message used to claim "the worktree and its branch were removed again"
 * whenever the worktree came off — which is how a call site that passed one
 * argument too few kept a surviving branch while promising it was gone, and how
 * the orphan that made the next `start` with that slug fail "a branch named X
 * already exists" was born. Each half is now reported on its own, so a branch
 * that is still there is named as needing cleanup rather than announced as
 * removed.
 *
 * @param {{worktreeRemoved: boolean, branchRestored: boolean}} outcome
 * @returns {string} a clause for the failure message.
 */
function describeRollback(outcome) {
  if (outcome.worktreeRemoved === true && outcome.branchRestored === true) {
    return 'the worktree and its branch were removed again';
  }
  const parts = [
    outcome.worktreeRemoved === true
      ? 'the worktree was removed again'
      : 'the worktree may still be on disk and needs manual cleanup',
    outcome.branchRestored === true
      ? 'its branch was restored to where it stood before the attempt'
      : 'its branch could not be restored and needs manual cleanup',
  ];
  return parts.join('; ');
}
