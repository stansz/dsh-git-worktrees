/**
 * lib/worktrees.mjs against real repositories and real git worktrees.
 *
 * The tool layer (tool.test.mjs) covers the model-facing envelope; this file
 * covers the operations themselves, including the failure and rollback paths the
 * tool only forwards. Every repository is a throwaway under os.tmpdir().
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  createWorktree,
  deleteBranch,
  findWorktreeForBranch,
  isOwnedWorktreePath,
  removeWorktree,
  worktreePathFor,
} from '../lib/worktrees.mjs';
import { listWorktrees } from '../lib/git.mjs';
import {
  addForeignWorktree,
  branchExists,
  commitFile,
  gitOrThrow,
  initRepo,
  makeTempRoot,
  markerFor,
  readJson,
  removeTempRoot,
  revParse,
} from './helpers.mjs';

let root;
let counter = 0;

before(() => {
  root = makeTempRoot('dsh-git-worktrees-lib-');
});

after(() => removeTempRoot(root));

async function freshRepo(options = {}) {
  counter += 1;
  return initRepo(root, { name: 'repo-' + counter, ...options });
}

function options(overrides = {}) {
  return {
    worktreeRoot: join(root, 'worktrees'),
    branchPrefix: 'dsh/',
    timeoutMs: 30000,
    ...overrides,
  };
}

function expectedPath(repo, slug, worktreeRoot = join(root, 'worktrees')) {
  return worktreePathFor(worktreeRoot, basename(repo), slug);
}

describe('createWorktree', () => {
  test('requires a worktreeRoot, a branchPrefix and a slug', async () => {
    const repo = await freshRepo();

    const noRoot = await createWorktree(repo, { branchPrefix: 'dsh/', slug: 'x' });
    assert.equal(noRoot.ok, false);
    assert.match(noRoot.error, /worktreeRoot is required/u);

    const noPrefix = await createWorktree(repo, { worktreeRoot: join(root, 'wt-a'), slug: 'x' });
    assert.equal(noPrefix.ok, false);
    assert.match(noPrefix.error, /branchPrefix is required/u);

    const noSlug = await createWorktree(repo, { worktreeRoot: join(root, 'wt-a'), branchPrefix: 'dsh/' });
    assert.equal(noSlug.ok, false);
    assert.match(noSlug.error, /slug is required/u);
  });

  test('refuses a directory that is not a git repository', async () => {
    const plain = join(root, 'plain-dir');
    mkdirSync(plain, { recursive: true });
    const result = await createWorktree(plain, options({ slug: 'x' }));
    assert.equal(result.ok, false);
    assert.match(result.error, /is not a git repository/u);
  });

  test('creates the branch and its worktree under the root', async () => {
    const repo = await freshRepo();
    const expected = expectedPath(repo, 'Fix Login');
    const created = await createWorktree(repo, options({ slug: 'Fix Login', task: 'Fix the login bug' }));

    assert.equal(created.ok, true);
    assert.equal(created.path, expected);
    assert.equal(created.branch, 'dsh/fix-login');
    assert.equal(created.slug, 'fix-login');
    assert.equal(created.base, 'main');
    assert.equal(created.reused, false);

    assert.equal(existsSync(join(expected, 'file-0.txt')), true);
    assert.equal(await gitOrThrow(expected, ['branch', '--show-current']), 'dsh/fix-login');
    assert.equal(await revParse(expected), await revParse(repo));

    const trees = await listWorktrees(repo);
    const registered = trees.find((tree) => tree.path === expected);
    assert.notEqual(registered, undefined);
    assert.equal(registered.branch, 'dsh/fix-login');
    assert.equal(registered.locked, true);
    assert.equal(registered.lockReason, 'dsh');
  });

  test('writes the ownership marker beside the worktree', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({
      slug: 'marked',
      task: 'a recorded task',
      sessionFile: '/tmp/some-session.json',
    }));

    const marker = readJson(markerFor(created.path));
    assert.equal(marker.repo, basename(repo));
    assert.equal(marker.path, created.path);
    assert.equal(marker.branch, 'dsh/marked');
    assert.equal(marker.slug, 'marked');
    assert.equal(marker.task, 'a recorded task');
    assert.equal(marker.sessionFile, '/tmp/some-session.json');
    assert.equal(typeof marker.createdAt, 'string');
    assert.equal(isOwnedWorktreePath(created.path), true);
  });

  test('omits a blank task and defaults the session file to the environment', async () => {
    const repo = await freshRepo();
    const previous = process.env.DSH_SESSION_FILE;
    process.env.DSH_SESSION_FILE = '/tmp/from-env.json';
    try {
      const created = await createWorktree(repo, options({ slug: 'blank-task', task: '   ' }));
      const marker = readJson(markerFor(created.path));
      assert.equal(Object.hasOwn(marker, 'task'), false);
      assert.equal(marker.sessionFile, '/tmp/from-env.json');
    } finally {
      if (previous === undefined) delete process.env.DSH_SESSION_FILE;
      else process.env.DSH_SESSION_FILE = previous;
    }
  });

  test('cuts the task branch from origin/<base> when that ref exists', async () => {
    const repo = await freshRepo({ commits: 2 });
    const firstCommit = await revParse(repo, 'HEAD~1');
    await gitOrThrow(repo, ['update-ref', 'refs/remotes/origin/main', firstCommit]);

    const created = await createWorktree(repo, options({ slug: 'from-origin' }));
    assert.equal(created.ok, true);
    assert.equal(created.base, 'origin/main');
    assert.equal(await revParse(created.path), firstCommit);
    assert.equal(existsSync(join(created.path, 'file-0.txt')), true);
    assert.equal(existsSync(join(created.path, 'file-1.txt')), false);
  });

  test('cuts from a local branch named as the base when there is no remote ref', async () => {
    const repo = await freshRepo();
    await gitOrThrow(repo, ['checkout', '-q', '-b', 'feature']);
    await commitFile(repo, 'feature.txt', 'feature work\n', 'feature commit');

    const created = await createWorktree(repo, options({ slug: 'from-feature', baseBranch: 'feature' }));
    assert.equal(created.ok, true);
    assert.equal(created.base, 'feature');
    assert.equal(existsSync(join(created.path, 'feature.txt')), true);
  });

  test('defaults the base to the repository default branch', async () => {
    const repo = await freshRepo({ name: 'trunk-repo', branch: 'trunk' });
    const created = await createWorktree(repo, options({ slug: 'default-base' }));
    assert.equal(created.ok, true);
    assert.equal(created.base, 'trunk');
  });

  test('an explicit base may be a tag', async () => {
    const repo = await freshRepo({ commits: 2 });
    const firstCommit = await revParse(repo, 'HEAD~1');
    await gitOrThrow(repo, ['tag', 'v1', firstCommit]);

    const created = await createWorktree(repo, options({ slug: 'from-tag', baseBranch: 'v1' }));
    assert.equal(created.ok, true);
    assert.equal(created.base, 'v1');
    assert.equal(await revParse(created.path), firstCommit);
  });

  test('refuses an unknown base branch', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'bad-base', baseBranch: 'does-not-exist' }));
    assert.equal(created.ok, false);
    assert.match(created.error, /unknown base branch: does-not-exist/u);
    assert.equal(existsSync(expectedPath(repo, 'bad-base')), false);
  });

  test('refuses a base that looks like a command-line option', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'dash-base', baseBranch: '--force' }));
    assert.equal(created.ok, false);
    assert.match(created.error, /may not start with a dash/u);
  });

  test('reuses a worktree already registered at the path it would create', async () => {
    const repo = await freshRepo();
    const first = await createWorktree(repo, options({ slug: 'again' }));
    const second = await createWorktree(repo, options({ slug: 'again' }));

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(second.path, first.path);
    assert.equal(second.branch, first.branch);
    const trees = await listWorktrees(repo);
    assert.equal(trees.filter((tree) => tree.path === first.path).length, 1);
    assert.equal(await revParse(first.path), await revParse(repo));
  });

  test('refuses a path registered to a different branch', async () => {
    const repo = await freshRepo();
    const path = expectedPath(repo, 'clash');
    await addForeignWorktree(repo, path, 'someone-elses-branch');

    const created = await createWorktree(repo, options({ slug: 'clash' }));
    assert.equal(created.ok, false);
    assert.match(created.error, /registered to branch someone-elses-branch, not dsh\/clash/u);
  });

  test('refuses a branch already checked out in another worktree', async () => {
    const repo = await freshRepo();
    const elsewhere = join(root, 'somebody-elses-worktree');
    await addForeignWorktree(repo, elsewhere, 'dsh/held');

    const created = await createWorktree(repo, options({ slug: 'held' }));
    assert.equal(created.ok, false);
    assert.match(created.error, /already checked out in the worktree at/u);
    assert.match(created.error, /will not force or detach/u);
  });

  test('refuses a path that exists but is not a registered worktree', async () => {
    const repo = await freshRepo();
    const path = expectedPath(repo, 'occupied');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'somebody.txt'), 'not ours\n');

    const created = await createWorktree(repo, options({ slug: 'occupied' }));
    assert.equal(created.ok, false);
    assert.match(created.error, /already exists but is not a registered worktree/iu);
  });

  test('refuses a branch name that already exists outside a worktree', async () => {
    const repo = await freshRepo();
    await gitOrThrow(repo, ['branch', 'dsh/orphan', 'main']);

    const created = await createWorktree(repo, options({ slug: 'orphan' }));
    assert.equal(created.ok, false);
    assert.match(created.error, /already exists/u);
  });

  test('leaves no branch behind when git cannot create the worktree', async () => {
    const repo = await freshRepo();
    const blocked = join(root, 'blocked-root');
    writeFileSync(blocked, 'a file where a parent directory would go\n');

    const created = await createWorktree(repo, options({
      slug: 'cannot-create',
      worktreeRoot: join(blocked, 'nested'),
    }));
    assert.equal(created.ok, false);
    assert.equal(created.ok, false);
    assert.equal(await branchExists(repo, 'dsh/cannot-create'), false);
  });

  test('rolls the worktree and branch back when the ownership marker cannot be written', async () => {
    const repo = await freshRepo();
    const worktreeRoot = join(root, 'marker-fail');
    const path = expectedPath(repo, 'no-marker', worktreeRoot);
    // A directory where the marker file has to go makes the write fail while
    // leaving everything else about the creation healthy.
    mkdirSync(markerFor(path), { recursive: true });

    const created = await createWorktree(repo, options({ slug: 'no-marker', worktreeRoot }));
    assert.equal(created.ok, false);
    assert.match(created.error, /could not write the ownership marker/u);
    assert.match(created.error, /the worktree and its branch were removed again/u);
    assert.equal(existsSync(path), false);
    assert.equal(await branchExists(repo, 'dsh/no-marker'), false);
    assert.equal((await listWorktrees(repo)).length, 1);
  });

  test('an already-aborted signal creates nothing', async () => {
    const repo = await freshRepo();
    const controller = new AbortController();
    controller.abort();

    const created = await createWorktree(repo, options({ slug: 'aborted', signal: controller.signal }));
    // Every git call the creation makes aborts, including the ones that would
    // resolve a base, so the first honest failure wins and nothing is created.
    assert.equal(created.ok, false);
    assert.match(created.error, /aborted|unknown base branch/u);
    assert.equal(await branchExists(repo, 'dsh/aborted'), false);
    assert.equal(existsSync(expectedPath(repo, 'aborted')), false);
  });
});

describe('removeWorktree', () => {
  test('refuses an empty or non-string path', async () => {
    const repo = await freshRepo();
    assert.deepEqual(await removeWorktree(repo, ''), { ok: false, removed: false, error: 'no worktree path was given' });
    assert.deepEqual(await removeWorktree(repo, undefined), { ok: false, removed: false, error: 'no worktree path was given' });
  });

  test('refuses the main working tree', async () => {
    const repo = await freshRepo();
    const result = await removeWorktree(repo, repo);
    assert.equal(result.ok, false);
    assert.equal(result.removed, false);
    assert.match(result.error, /refusing to remove the main working tree/u);
    assert.equal(existsSync(repo), true);
  });

  test('removes a created worktree and its marker, and keeps the branch', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'gone' }));
    assert.equal(isOwnedWorktreePath(created.path), true);

    const removed = await removeWorktree(repo, created.path);
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.equal(existsSync(created.path), false);
    assert.equal(existsSync(markerFor(created.path)), false);
    assert.equal((await listWorktrees(repo)).length, 1);
    // Documented in README.md: this bundle does not delete branches.
    assert.equal(await branchExists(repo, 'dsh/gone'), true);
  });

  test('refuses a worktree with no ownership marker unless allowForeign is given', async () => {
    const repo = await freshRepo();
    const foreign = join(root, 'foreign-worktree');
    await addForeignWorktree(repo, foreign, 'foreign-branch');

    const refused = await removeWorktree(repo, foreign);
    assert.equal(refused.ok, false);
    assert.equal(refused.removed, false);
    assert.equal(refused.code, 'not-owned');
    assert.equal(refused.owned, false);
    assert.match(refused.error, /dsh-git did not create it/u);
    assert.equal(existsSync(foreign), true);

    const allowed = await removeWorktree(repo, foreign, { allowForeign: true });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.removed, true);
    assert.equal(existsSync(foreign), false);
  });

  test('refuses a dirty worktree and names the files, keeping the lock', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'dirty' }));
    writeFileSync(join(created.path, 'work-in-progress.txt'), 'not committed\n');

    const refused = await removeWorktree(repo, created.path);
    assert.equal(refused.ok, false);
    assert.equal(refused.removed, false);
    assert.deepEqual(refused.dirty, ['work-in-progress.txt']);
    assert.match(refused.error, /uncommitted change/iu);
    assert.equal(existsSync(created.path), true);

    const trees = await listWorktrees(repo);
    const entry = trees.find((tree) => tree.path === created.path);
    assert.equal(entry.locked, true, 'a refused removal puts the lock back');
  });

  test('force removes a dirty worktree', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'forced' }));
    writeFileSync(join(created.path, 'work-in-progress.txt'), 'not committed\n');

    const removed = await removeWorktree(repo, created.path, { force: true });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.equal(existsSync(created.path), false);
  });

  test('drops the registration of a worktree whose directory is gone', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'vanished' }));
    rmSync(created.path, { recursive: true, force: true });
    assert.equal(existsSync(created.path), false);

    const removed = await removeWorktree(repo, created.path);
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.equal((await listWorktrees(repo)).length, 1);
    assert.equal(existsSync(markerFor(created.path)), false);
  });

  test('refuses a path that is not a worktree of the repository', async () => {
    const repo = await freshRepo();
    const notAWorktree = join(root, 'just-a-directory');
    mkdirSync(notAWorktree, { recursive: true });
    const result = await removeWorktree(repo, notAWorktree);
    assert.equal(result.ok, false);
    assert.equal(result.removed, false);
    assert.match(result.error, /is not a worktree of/u);
  });

  test('a realpath spelling of the path finds the registration', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'spelling' }));
    // git reports realpaths; the caller's spelling may differ under /tmp on macOS.
    const alias = created.path.startsWith('/private/')
      ? created.path.slice('/private'.length)
      : created.path;
    const removed = await removeWorktree(repo, alias);
    assert.equal(removed.ok, true);
    assert.equal(existsSync(created.path), false);
  });
});

describe('listWorktrees', () => {
  test('lists the main checkout and the linked worktrees git reports', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'listed' }));
    const trees = await listWorktrees(repo);

    assert.equal(trees.length, 2);
    assert.equal(trees[0].path, repo);
    assert.equal(trees[0].branch, 'main');
    assert.equal(trees[1].path, created.path);
    assert.equal(trees[1].branch, 'dsh/listed');
    assert.equal(trees[1].locked, true);
    assert.equal(typeof trees[1].head, 'string');
  });

  test('answers undefined outside a repository', async () => {
    const plain = join(root, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    assert.equal(await listWorktrees(plain), undefined);
  });

  test('a directory inside a linked worktree resolves to that worktree', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'inside' }));
    const trees = await listWorktrees(created.path);
    const found = findWorktreeForBranch(trees, join(created.path, 'sub', 'dir'));

    assert.equal(trees[0].path, repo);
    assert.equal(found.worktree.path, created.path);
    assert.equal(found.isMain, false);
    assert.equal(found.mainPath, repo);
  });
});

describe('deleteBranch', () => {
  test('refuses without the commit it is believed to point at', async () => {
    const repo = await freshRepo();
    await gitOrThrow(repo, ['branch', 'drop-me', 'main']);
    const result = await deleteBranch(repo, 'drop-me', {}, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no-proof');
    assert.equal(await branchExists(repo, 'drop-me'), true);
  });

  test('deletes a branch that still points at the proved commit', async () => {
    const repo = await freshRepo();
    await gitOrThrow(repo, ['branch', 'drop-me', 'main']);
    const tip = await revParse(repo, 'drop-me');
    const result = await deleteBranch(repo, 'drop-me', {}, { tip });
    assert.equal(result.ok, true);
    assert.equal(await branchExists(repo, 'drop-me'), false);
  });

  test('refuses a branch that moved after it was proved disposable', async () => {
    const repo = await freshRepo();
    await gitOrThrow(repo, ['branch', 'moved', 'main']);
    const oldTip = await revParse(repo, 'moved');
    await commitFile(repo, 'newer.txt', 'newer\n', 'newer');
    // The branch moves to a commit the caller never proved disposable.
    await gitOrThrow(repo, ['branch', '-f', 'moved', 'main']);
    assert.notEqual(await revParse(repo, 'moved'), oldTip);
    const result = await deleteBranch(repo, 'moved', {}, { tip: oldTip });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tip-moved');
    assert.equal(await branchExists(repo, 'moved'), true);
  });

  test('refuses a branch a worktree has checked out', async () => {
    const repo = await freshRepo();
    const created = await createWorktree(repo, options({ slug: 'checked-out' }));
    const tip = await revParse(repo, created.branch);
    const result = await deleteBranch(repo, created.branch, {}, { tip });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'checked-out');
    assert.equal(await branchExists(repo, created.branch), true);
    assert.equal(existsSync(created.path), true);
  });

  test('an absent branch is not a failure', async () => {
    const repo = await freshRepo();
    const result = await deleteBranch(repo, 'never-existed', {}, { tip: 'a'.repeat(40) });
    assert.equal(result.ok, true);
    assert.equal(result.absent, true);
  });

  test('an empty branch name is refused', async () => {
    const repo = await freshRepo();
    const result = await deleteBranch(repo, '   ', {}, { tip: 'a'.repeat(40) });
    assert.equal(result.ok, false);
    assert.match(result.error, /branch name is required/u);
  });
});
