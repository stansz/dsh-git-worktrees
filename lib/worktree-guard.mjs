/**
 * Worktree enforcement: the half of "one worktree per task" that a description
 * cannot deliver.
 *
 * Every other part of this bundle asks. The tool description says to work in a
 * worktree, the guard redirects raw git at the tool, and the turn sync keeps
 * whatever happened committed. None of that stops the actual moment that decides
 * where the work lands: a file edit. A model that reads "work in a worktree" and
 * then edits `main` in place has followed the instruction as far as it understood
 * it, and the only thing that would have changed the outcome is a refusal.
 *
 * So this module refuses — narrowly, and only in the case the configuration
 * names:
 *
 *   off        never refuse; the description and the tool remain the whole story
 *   protected  refuse a write to a repository sitting on a protected branch — the
 *              default, because a rule that has to be switched on is the failure
 *              this bundle exists to end
 *   always     refuse a write to any repository this session has no worktree for
 *
 * One case sits outside all three: a branch with no commits. `git init -b main`
 * reports the branch name `main` before `main` exists, and reading that name as
 * protected refused the first file of every new project with a remedy that could
 * not run — no worktree can be cut from an unborn HEAD. There is nothing to
 * protect either: no history, and nothing another session could be sharing.
 *
 * "Inside the session's worktree" is decided by where the write LANDS, not by
 * how the path was spelled: the target is resolved through its deepest existing
 * ancestor, symlinks followed, and compared against the worktree paths this
 * session really owns. Ownership itself is answered from git, never from the
 * recorded string: a recorded path counts only while git still registers it as a
 * worktree of that repository AND the directory at that exact path really is
 * that worktree — a symlink planted there resolves into whatever it points at,
 * and ownership must not follow it — and a worktree git has moved counts at the
 * path git reports for its branch. A record is a claim, and `git worktree move`
 * — or a symlink recreating the old path — makes the claim false while the
 * string still looks right. A link inside the worktree that points at the main
 * checkout is therefore a write into main and is refused, while a new file whose
 * path only passes through a symlinked directory that resolves inside the
 * worktree is allowed. The repository a decision is *keyed* on is its main root
 * — the first `git worktree list` entry, which is what the session registry
 * stores — never the toplevel, because inside a linked worktree the toplevel is
 * the worktree itself.
 *
 * Two things are deliberately absent.
 *
 * It does not create the worktree for you. A guard that has a side effect on a
 * refused call is a guard that creates a worktree for every edit somebody
 * abandons, and the caller learns nothing about why the write stopped. The
 * refusal carries the exact action to run instead, which is one cheap step and a
 * better lesson.
 *
 * It does not fire on a branch that is already a task branch. A session working
 * in its own `dsh/...` worktree, or on any branch that is not protected, is
 * already isolated; gating that would make the rule feel arbitrary and teach the
 * caller to route around it.
 *
 * Only `node:` builtins and relative imports, and every function is fail-soft:
 * a check that cannot read the repository answers "allow", because a guard that
 * breaks unrelated tool calls is worse than a guard that misses one.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import * as git from './git.mjs';
import * as state from './state.mjs';
import { isProtectedBranch } from './config.mjs';

/**
 * File tools whose target decides where work lands.
 *
 * The same set `session-files.mjs` records, for the same reason: these are the
 * calls that change a repository, and a rule about where changes land has to
 * cover exactly them.
 */
export const MUTATING_FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'notebook_edit', 'apply_patch']);

/** Argument names that carry a target path, across the file tools. */
const PATH_ARGUMENTS = ['file_path', 'path', 'filePath', 'notebook_path', 'target_file'];

/**
 * The file this call is about, or undefined when it is not a mutating file
 * operation.
 *
 * A shell command is NOT included, and that is a deliberate limit worth stating:
 * `bash` can write a file, and reading a shell command well enough to know
 * whether it will is the same unbounded problem the git guard already documents
 * as best-effort. Treating every shell call as a write would gate `git status`,
 * which is the one thing this bundle most wants a session doing freely.
 */
export function editTarget(exec) {
  const name = typeof exec?.name === 'string' ? exec.name : '';
  if (!MUTATING_FILE_TOOLS.has(name)) return undefined;
  const args = exec?.arguments;
  if (args === null || typeof args !== 'object') return undefined;
  for (const key of PATH_ARGUMENTS) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * Whether a path is a worktree directory itself: a real directory, at that exact
 * path, carrying the `.git` entry every checkout has.
 *
 * `lstat` is the point of this function: it does not follow the final path
 * component, so a symlink planted at a recorded path is not a directory here. A
 * deleted worktree whose path was pointed at another session's worktree made an
 * edit spelled inside the "owned" path land in that stranger's checkout, and the
 * only thing wrong with the state was that the owned path was not the worktree
 * directory any more. A symlinked *ancestor* (`/tmp` on this platform) is
 * untouched, because only the last component is exempt from resolution.
 *
 * The `.git` entry is the second half of "is a checkout": a directory git has no
 * checkout metadata for is not a worktree, whichever path it sits at.
 *
 * `path` may be anything someone stored; a missing, non-string, or unreadable
 * value is simply not a worktree directory.
 */
function worktreeDirectoryAt(path) {
  try {
    return lstatSync(path).isDirectory() && existsSync(join(path, '.git'));
  } catch {
    return false;
  }
}

/** Whether a stored entry claims a repository, named by its main root. */
function claimsRepo(entry, mainRoot) {
  return entry !== null && typeof entry === 'object' && samePath(entry.repoRoot, mainRoot);
}

/**
 * Whether the checkout at a registered worktree's path is the checkout that
 * registration describes.
 *
 * `git worktree list` prints the REAL path of every registration, so a
 * registration whose checkout directory was replaced by a symlink arrives
 * wearing the path of whatever the symlink resolves to: the branch in the
 * listing comes from the registration's admin directory, the branch in the
 * directory comes from the checkout itself. They agree for an honest worktree
 * and disagree for a substituted one, and when two registrations report the same
 * path that disagreement is the only thing that tells them apart — which is why
 * ownership cannot rest on the path alone.
 *
 * A registration with no branch is a detached checkout, and a detached checkout
 * is what has to be there for it to match.
 */
async function checkoutMatchesRegistration(tree) {
  const branch = await git.currentBranch(tree.path);
  return tree.branch === undefined ? branch === undefined : branch === tree.branch;
}

/**
 * A registered worktree at the path a session recorded, when it is really there.
 *
 * `registered` is git's own `worktree list`, so a match is a worktree this
 * repository has — not a directory somebody recreated at a path a record
 * mentions. The recorded path has to be a worktree directory itself, too:
 * `samePath` resolves both sides, so a symlink planted at the recorded path
 * resolves to whatever it points at, and without that test the symlink matched
 * *any* registered worktree — another session's included, which is how an edit
 * at the owned path landed in a checkout this session does not own. A
 * registration whose checkout was deleted outside git fails the same test, and
 * treating it as isolated would report an edit as isolated while it lands in the
 * main checkout.
 */
async function liveWorktreeAt(registered, path) {
  if (!worktreeDirectoryAt(path)) return undefined;
  for (const tree of registered) {
    if (!samePath(tree.path, path) || !worktreeDirectoryAt(tree.path)) continue;
    if (await checkoutMatchesRegistration(tree)) return tree;
  }
  return undefined;
}

/**
 * The registered worktree a moved record belongs to, if git moved it.
 *
 * `git worktree move` renames the checkout and keeps its branch, so the branch
 * is the identity that survives: a recorded path that is no longer a registered
 * worktree, whose branch git now has at another path, is that worktree at its
 * new home. The main worktree is never a candidate — a session's task branch
 * checked out in the main checkout is not a worktree this session owns — and the
 * registered path has to be a worktree directory whose own checkout is on that
 * branch, because a registration whose checkout was replaced by a symlink is
 * not the worktree it claims to be, whichever branch it reports.
 */
async function movedWorktreeFor(entry, registered, mainRoot) {
  if (typeof entry.branch !== 'string' || entry.branch === '') return undefined;
  for (const tree of registered) {
    if (tree.branch !== entry.branch || samePath(tree.path, mainRoot) || !worktreeDirectoryAt(tree.path)) continue;
    if (await checkoutMatchesRegistration(tree)) return tree;
  }
  return undefined;
}

/**
 * The paths of the worktrees this session really owns in one repository.
 *
 * Ownership is answered from git, never from the recorded string, because a
 * recorded path is a claim and not a fact. `git worktree move` leaves the record
 * pointing at a directory that is no longer a worktree, and that path can then
 * be filled with anything — a symlink to the main checkout made an edit spelled
 * inside the "worktree" land in main. So a recorded path counts only while git
 * still registers it as a worktree of this repository and the directory at that
 * path really is one, and a recorded worktree git has at a different path
 * (moved) counts at the path git reports.
 *
 * When git cannot answer, the record is all there is. That is the fail-soft
 * direction this module documents: the alternative is denying edits inside a
 * worktree the session really owns because one `git worktree list` failed.
 */
async function ownedWorktreePaths(session, mainRoot, registered) {
  const entries = session.worktrees.filter((entry) => claimsRepo(entry, mainRoot));
  if (!Array.isArray(registered) || registered.length === 0) {
    return entries.filter((entry) => worktreeDirectoryAt(entry.path)).map((entry) => entry.path);
  }

  const paths = [];
  for (const entry of entries) {
    const here = await liveWorktreeAt(registered, entry.path);
    if (here !== undefined && !samePath(here.path, mainRoot)) {
      paths.push(here.path);
      continue;
    }
    const moved = await movedWorktreeFor(entry, registered, mainRoot);
    if (moved !== undefined) paths.push(moved.path);
  }
  return paths;
}

/**
 * The path this session recorded for a repository's worktree, if a worktree
 * directory is still there.
 *
 * Deliberately the record's own view and nothing more: this is synchronous and
 * never asks git, so it is a hint for a caller that only has the record. It is
 * NOT the verdict. A recorded path can have been moved by `git worktree move`
 * or replaced by a symlink — to the main checkout, or to another session's
 * worktree — and only `evaluateWorktree`, which can ask git which worktrees the
 * repository really has, decides whether an edit is inside a worktree this
 * session owns. What this function does insist on is that the path is a worktree
 * directory itself, so it never hands back a path that only resolves like one.
 *
 * Returning the path rather than a boolean, because the rule is not about
 * whether isolation exists — it is about whether *this edit* lands inside it.
 * A boolean said "the session has a worktree for this repository", which is true
 * while the caller edits the main checkout, and that would let the exact write
 * the rule exists to stop straight through.
 *
 * `repoRoot` has to be the repository's MAIN root — the first `git worktree
 * list` entry, which is the identity `actions.mjs` records as `repoRoot` when
 * it registers a worktree — and never the toplevel of the directory being
 * edited. Inside a linked worktree the toplevel IS the worktree path, so a
 * toplevel comparison found nothing for an edit in the worktree the session
 * already had, which is how `autoWorktree: 'always'` came to deny exactly the
 * writes the rule exists to permit. The comparison is realpath-aware, because
 * `/tmp/x` and `/private/tmp/x` are one directory on this platform.
 */
export function ownedWorktreePath(sessionId, repoRoot, config) {
  if (typeof repoRoot !== 'string' || repoRoot === '') return undefined;
  const session = state.readSession(sessionId, { stateRoot: config?.stateRoot });
  const entry = session.worktrees.find((candidate) => worktreeDirectoryAt(candidate?.path) && samePath(candidate.repoRoot, repoRoot));
  return entry?.path;
}

/**
 * Whether the session record names any usable worktree for a repository.
 *
 * Record-level, like `ownedWorktreePath`: the guard asks git instead.
 */
export function hasOwnWorktree(sessionId, repoRoot, config) {
  return ownedWorktreePath(sessionId, repoRoot, config) !== undefined;
}

/**
 * The decision for one file edit.
 *
 * Split out from the git work so it can be tested directly: this is the part
 * with the rule in it, and a rule that can only be exercised through a live Host
 * is a rule nobody tests. `snapshot` carries what the caller already had to look
 * up — the repository root, the branch, and whether a worktree exists.
 *
 * @returns {{kind: 'allow'} | {kind: 'deny', reason: string, displayReason: string}}
 */
export function decideWorktree(snapshot, config, options = {}) {
  // The fallback matches the documented default, so a config object that never
  // went through resolveConfig behaves like one that did.
  const mode = config?.autoWorktree ?? 'protected';
  if (mode === 'off') return { kind: 'allow' };
  if (snapshot === null || typeof snapshot !== 'object') return { kind: 'allow' };
  const { repoRoot, branch, insideOwned, protectedBranch } = snapshot;
  if (typeof repoRoot !== 'string' || repoRoot === '') return { kind: 'allow' };

  const repoName = repoRoot.split('/').filter((part) => part !== '').pop() ?? repoRoot;
  const where = 'repository ' + repoName;
  const how = 'Run the worktree tool with action "start" (slug: something-short), then repeat this edit against the path it returns.';

  // The edit is already in the session's own worktree: that is the destination,
  // not a detour, so no mode refuses it.
  if (insideOwned === true) return { kind: 'allow' };

  if (mode === 'protected') {
    // Nothing to say about a branch that is not protected: the rule is about
    // keeping `main` clean, not about forcing a worktree for its own sake.
    if (protectedBranch !== true) return { kind: 'allow' };
    return {
      kind: 'deny',
      reason: 'This edit targets ' + where + ', which is on the protected branch "' + String(branch ?? '')
        + '". Changes there cannot be pushed and cannot be isolated from other sessions working in the same checkout. '
        + how,
      displayReason: 'Blocked: edit to ' + repoName + ' on "' + String(branch ?? '') + '" — start a worktree first',
    };
  }

  // `always`: any repository without a worktree, on any branch.
  return {
    kind: 'deny',
    reason: 'This edit targets ' + where + ', which this session has no worktree for'
      + (typeof branch === 'string' ? ' (it is on "' + branch + '")' : '')
      + '. autoWorktree is "always", so every repository this session changes gets its own worktree. '
      + how,
    displayReason: 'Blocked: edit to ' + repoName + ' with no worktree — start one first',
  };
}

/**
 * Where a write to this path actually lands.
 *
 * The deepest ancestor that exists is realpath'd and the rest of the path
 * re-appended, so every symlink on the way is followed to its target. That is
 * the point of the function: a symlink inside the worktree that points at the
 * main checkout makes `<worktree>/link/new.txt` a write into main, and a symlink
 * that points back inside makes a path that only looks external a write into the
 * worktree. The end of the path may not exist yet — a new file, in a new folder,
 * is the ordinary way a session writes code — which is why the resolution starts
 * at the nearest existing ancestor rather than at the end.
 */
function landingPath(path) {
  const absolute = resolvePath(path);
  const ancestor = existingAncestorOf(absolute);
  const real = realpathOr(ancestor);
  const rest = relative(ancestor, absolute);
  return rest === '' ? real : join(real, rest);
}

/** Whether a write to `child` lands in `parent` or below it. */
function isInside(parent, child) {
  const from = landingPath(parent);
  const to = landingPath(child);
  const rel = relative(from, to);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** Whether two paths name the same directory, realpath-aware. */
function samePath(left, right) {
  if (typeof left !== 'string' || left === '' || typeof right !== 'string' || right === '') return false;
  const first = realpathOr(resolvePath(left));
  const second = realpathOr(resolvePath(right));
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

/**
 * The nearest directory at or above a path that exists.
 *
 * A write to `src/new/deep/file.txt` names a path whose own directory is not
 * there yet, and `git rev-parse --show-toplevel` answers nothing for a path that
 * does not exist — which made every such write unclassifiable, and an
 * unclassifiable write is allowed. The repository a path belongs to is decided
 * by the first directory above it that does exist, so that is the one to ask
 * about: the caller is still writing into that repository, on that branch.
 */
function existingAncestorOf(path) {
  let current = resolvePath(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** A realpath, or the path itself when it cannot be resolved. */
function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The main repository root that owns a working directory.
 *
 * `git worktree list` reports the main working tree first, always, so its first
 * entry is the identity every registry lookup uses — the same answer
 * `actions.mjs` computes before it records `repoRoot`, and therefore the value
 * `ownedWorktreePath` has to be given. The toplevel is not that value: inside a
 * linked worktree it is the worktree path itself.
 *
 * Deriving it from `--git-common-dir` would not do either: that path is the
 * shared git DIRECTORY (`.git`, or `<super>/.git/modules/<name>` for a
 * submodule), whose parent is not a working tree at all.
 *
 * The toplevel is the fallback when git cannot answer, because a label that is
 * merely imprecise is better than a decision that is missing.
 */
function mainRootOf(registered, toplevelPath) {
  const first = Array.isArray(registered) ? registered[0] : undefined;
  if (first !== undefined && typeof first.path === 'string' && first.path !== '') return first.path;
  return toplevelPath;
}

/**
 * The rule, applied to a pending tool call.
 *
 * Resolves the target's repository and branch through git, which is why this is
 * asynchronous while `lib/guard.mjs` is not: that one classifies a string, this
 * one has to know the state of a repository.
 *
 * @returns {Promise<{kind: 'allow'} | {kind: 'deny', reason: string, displayReason: string}>}
 */
export async function evaluateWorktree(exec, config, options = {}) {
  if (config?.autoWorktree === 'off') return { kind: 'allow' };
  const target = editTarget(exec);
  if (target === undefined) return { kind: 'allow' };

  const sessionId = String(exec?.agent?.id ?? exec?.agent?.session ?? '');
  if (sessionId === '') return { kind: 'allow' };

  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd();
  const absolute = isAbsolute(target) ? target : resolvePath(cwd, target);

  // Resolved from the nearest existing directory: the file itself may be about
  // to be created, and a new file in a new folder is the ordinary way a session
  // writes code. A path reached through a symlink answers about the checkout the
  // write really lands in, because git resolves the directory it is handed.
  const repoRoot = await git.toplevel(existingAncestorOf(absolute));
  if (repoRoot === undefined) return { kind: 'allow' };

  // Two roots, and they are not interchangeable. `repoRoot` is where this write
  // lands; `mainRoot` is the repository's identity in the session registry, and
  // comparing the two is the mistake this function no longer makes. One reading
  // of git's worktree list answers both questions: which repository this is (the
  // main worktree is listed first) and which worktrees the repository really has.
  const registered = await git.listWorktrees(repoRoot);
  const mainRoot = mainRootOf(registered, repoRoot);
  const branch = await git.currentBranch(repoRoot);
  // A branch name is not a branch. `hasHead` separates a repository with a commit
  // from one that was only initialised; the second is never protected, below.
  const head = await git.hasHead(repoRoot);
  const session = state.readSession(sessionId, { stateRoot: config?.stateRoot });
  const ownedPaths = await ownedWorktreePaths(session, mainRoot, registered);
  const snapshot = {
    repoRoot: mainRoot,
    branch,
    owned: ownedPaths.length > 0,
    // The distinction the rule turns on: a worktree existing is not the same as
    // this edit being in it. Decided from the worktree paths git says this
    // session owns and from where the write lands, so neither a root stored in
    // the registry, nor a symlink on the way, nor a recorded path that was moved
    // or replaced can throw the answer off.
    insideOwned: ownedPaths.some((path) => isInside(path, absolute)),
    // A branch with no commits is not a protected branch, whatever it is called:
    // there is no history to keep clean, and the refusal would name a step that
    // cannot run. `head` is undefined when git could not answer at all, and that
    // is treated as not protected — the fail-soft direction every read here takes.
    protectedBranch: branch !== undefined && head === true && isProtectedBranch(config, branch),
  };
  return decideWorktree(snapshot, config, options);
}

/**
 * Register the enforcement.
 *
 * Registered before the touched-file recorder so that a refused edit is never
 * recorded: the record decides what the turn end may commit, and a path that was
 * never written would make it commit a repository the session has not actually
 * changed.
 */
export function registerWorktreeGuard(ctx, rowConfig, options = {}) {
  const cwdOf = typeof options.cwdOf === 'function' ? options.cwdOf : () => process.cwd();
  const resolve = typeof options.resolveConfig === 'function' ? options.resolveConfig : (raw) => raw;

  ctx.on('tools/pre-execute', async (exec, next) => {
    let decision;
    try {
      // Resolved per call, not captured at mount: the row config is `volatile`,
      // so a value changed in the profile's patch layer is what the guard should
      // see at the next edit rather than the one that was in effect when the
      // plugin loaded.
      decision = await evaluateWorktree(exec, resolve(rowConfig), { cwd: cwdOf(exec?.agent) });
    } catch {
      // A rule that cannot read the repository must not block an unrelated edit.
      return next();
    }
    if (decision.kind === 'allow') return next();
    ctx.logger?.info?.('dsh-git-worktrees guard denied an edit: ' + decision.reason);
    return {
      kind: 'deny',
      reason: decision.reason,
      displayReason: { en: decision.displayReason },
      info: { name: 'dsh-git-worktrees', code: 'worktree-required' },
    };
  });
}
