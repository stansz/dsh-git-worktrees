/**
 * The worktree tool end to end: the real row is mounted with `apply()` from
 * index.js on a plain Cordis context, and every action is executed against real
 * repositories and real worktrees in a throwaway directory.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ACTION_NAMES } from '../lib/tool.mjs';
import { readSession } from '../lib/state.mjs';
import { isOwnedWorktreePath, worktreePathFor } from '../lib/worktrees.mjs';
import { listWorktrees } from '../lib/git.mjs';
import {
  addForeignWorktree,
  branchExists,
  git,
  gitOrThrow,
  initRepo,
  makeTempRoot,
  markerFor,
  mountPlugin,
  readJson,
  removeTempRoot,
  revParse,
  sessionId,
  toolExec,
} from './helpers.mjs';

let root;
let counter = 0;
let worktreeRoot;
let stateRoot;

before(() => {
  root = makeTempRoot('dsh-git-worktrees-tool-');
  worktreeRoot = join(root, 'worktrees');
  stateRoot = join(root, 'state');
});

after(() => removeTempRoot(root));

function config(overrides = {}) {
  return { worktreeRoot, stateRoot, ...overrides };
}

/**
 * One repository, one session, one mounted row. The session's working directory
 * is the temp root, so an absolute `repo` argument is the ordinary case.
 */
async function setup({ repoOptions = {}, cwd, rowConfig, sessionName } = {}) {
  counter += 1;
  const repo = await initRepo(root, { name: 'tool-repo-' + counter, ...repoOptions });
  const session = sessionId(sessionName ?? 'tool-' + counter);
  const app = mountPlugin({ cwd: cwd ?? root, config: rowConfig ?? config() });
  return { repo, session, app };
}

function start(app, session, args = {}) {
  return app.tool.execute({ action: 'start', ...args }, toolExec(session));
}

function list(app, session, args = {}) {
  return app.tool.execute({ action: 'list', ...args }, toolExec(session));
}

function remove(app, session, args = {}) {
  return app.tool.execute({ action: 'remove', ...args }, toolExec(session));
}

function expectedWorktree(repo, slug) {
  return worktreePathFor(worktreeRoot, basename(repo), slug);
}

describe('the plugin row', () => {
  test('declares its name and the tools service it injects', async () => {
    const app = mountPlugin({ cwd: root, config: config() });
    assert.equal(app.plugin.name, 'git-worktrees');
    assert.deepEqual(app.plugin.inject, ['tools']);
    assert.equal(typeof app.plugin.apply, 'function');
  });

  test('registers the worktree tool and one pre-execute guard under effects', () => {
    const app = mountPlugin({ cwd: root, config: config() });
    assert.equal(app.tools.size, 1);
    assert.notEqual(app.tool, undefined);
    assert.equal(typeof app.preExecute, 'function');
    assert.deepEqual(app.effects, ['worktree tool registration', 'worktree guard registration']);
  });

  test('the tool definition lists the three actions and never runs concurrently', () => {
    const app = mountPlugin({ cwd: root, config: config() });
    assert.equal(app.tool.name, 'worktree');
    assert.deepEqual(ACTION_NAMES, ['start', 'list', 'remove']);
    assert.deepEqual(app.tool.parameters.required, ['action']);
    assert.deepEqual(app.tool.parameters.properties.action.enum, ACTION_NAMES);
    assert.equal(app.tool.isConcurrencySafe(), false);
    assert.equal(app.tool.timeoutMs, 180000);
    assert.equal(typeof app.tool.description, 'string');
    assert.match(app.tool.description, /worktree/u);
    assert.match(app.tool.description, /- start: /u);
    assert.match(app.tool.description, /- list: /u);
    assert.match(app.tool.description, /- remove: /u);
  });

  test('presentCall names the action and marks list as a read', () => {
    const app = mountPlugin({ cwd: root, config: config() });
    assert.deepEqual(app.tool.presentCall({ action: 'list', repo: 'some/repo' }), {
      card: 'generic',
      title: 'worktree list: some/repo',
      kind: 'read',
      rawInput: { action: 'list', repo: 'some/repo' },
    });
    const dry = app.tool.presentCall({ action: 'start' });
    assert.equal(dry.kind, 'execute');
    assert.equal(dry.title, 'worktree start');
  });

  test('the output renderer reports success, failure and a dry run', () => {
    const app = mountPlugin({ cwd: root, config: config() });
    const success = app.tool.output.render({}, { action: 'start', ok: true, branch: 'dsh/x', worktree: '/w/x' });
    assert.equal(success.length, 1);
    assert.equal(success[0].type, 'text');
    assert.match(success[0].text, /start: ok/u);
    assert.match(success[0].text, /branch: dsh\/x/u);

    const failure = app.tool.output.render({}, {
      action: 'remove',
      ok: false,
      error: { code: 'dirty', message: 'uncommitted changes', hint: 'commit first' },
    });
    assert.match(failure[0].text, /remove: failed/u);
    assert.match(failure[0].text, /code: dirty/u);
    assert.match(failure[0].text, /hint: commit first/u);

    const dry = app.tool.output.render({}, { action: 'remove', ok: true, dryRun: true });
    assert.match(dry[0].text, /dry run - nothing was changed/u);
  });
});

describe('start', () => {
  test('creates the worktree the model is supposed to work in', async () => {
    const { repo, session, app } = await setup();
    const result = await start(app, session, { repo, slug: 'first-task', task: 'First task' });
    const expected = expectedWorktree(repo, 'first-task');

    assert.equal(result.ok, true);
    assert.equal(result.action, 'start');
    assert.equal(result.path, repo);
    assert.equal(result.worktree, expected);
    assert.equal(result.branch, 'dsh/first-task');
    assert.equal(result.slug, 'first-task');
    assert.equal(result.base, 'main');
    assert.equal(result.task, 'First task');
    assert.equal(result.reused, false);
    assert.equal(result.recorded, true);
    assert.equal(result.error, undefined);

    assert.equal(existsSync(expected), true);
    assert.equal(await gitOrThrow(expected, ['branch', '--show-current']), 'dsh/first-task');
    assert.equal(isOwnedWorktreePath(expected), true);
    assert.equal(readJson(markerFor(expected)).task, 'First task');
  });

  test('defaults the slug to "task" and the task text to the slug', async () => {
    const { repo, session, app } = await setup();
    const result = await start(app, session, { repo });
    assert.equal(result.ok, true);
    assert.equal(result.slug, 'task');
    assert.equal(result.task, 'task');
    assert.equal(result.branch, 'dsh/task');
    assert.equal(result.worktree, expectedWorktree(repo, 'task'));
  });

  test('records the worktree in the session state store', async () => {
    const { repo, session, app } = await setup();
    const result = await start(app, session, { repo, slug: 'recorded' });
    const state = readSession(session, { stateRoot });

    assert.equal(state.worktrees.length, 1);
    assert.equal(state.worktrees[0].path, result.worktree);
    assert.equal(state.worktrees[0].repoRoot, repo);
    assert.equal(state.worktrees[0].repo, basename(repo));
    assert.equal(state.worktrees[0].branch, 'dsh/recorded');
    assert.equal(state.worktrees[0].slug, 'recorded');
  });

  test('reuses the worktree this session already owns', async () => {
    const { repo, session, app } = await setup();
    const first = await start(app, session, { repo, slug: 'same-slug' });
    const second = await start(app, session, { repo, slug: 'same-slug' });

    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(second.worktree, first.worktree);
    assert.equal(second.branch, first.branch);
    assert.equal(readSession(session, { stateRoot }).worktrees.length, 1);
    assert.equal((await listWorktrees(repo)).length, 2);
  });

  test('adopts a worktree already registered at the path it would create', async () => {
    const { repo, session, app } = await setup();
    const path = expectedWorktree(repo, 'adopted');
    await addForeignWorktree(repo, path, 'dsh/adopted');
    assert.equal(isOwnedWorktreePath(path), false);

    const result = await start(app, session, { repo, slug: 'adopted' });
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(result.worktree, path);
    assert.equal(result.recorded, true);
    assert.equal(isOwnedWorktreePath(path), true, 'adoption writes the ownership marker');

    const trees = await listWorktrees(repo);
    assert.equal(trees.find((tree) => tree.path === path).locked, true, 'adoption locks the worktree');
  });

  test('starts from the protected branch: that is the remedy the guard points at', async () => {
    const { repo, session, app } = await setup();
    // The fixture repository is on main, which is protected by default. Starting
    // a task from it must work — the guard's refusal names this exact call.
    assert.equal(await gitOrThrow(repo, ['branch', '--show-current']), 'main');
    const result = await start(app, session, { repo, slug: 'from-main' });
    assert.equal(result.ok, true);
    assert.equal(result.base, 'main');
  });

  test('cuts the task branch from origin/<base> when that ref exists', async () => {
    const { repo, session, app } = await setup({ repoOptions: { commits: 2 } });
    const firstCommit = await revParse(repo, 'HEAD~1');
    await gitOrThrow(repo, ['update-ref', 'refs/remotes/origin/main', firstCommit]);

    const result = await start(app, session, { repo, slug: 'published-base', base: 'main' });
    assert.equal(result.ok, true);
    assert.equal(result.base, 'origin/main');
    assert.equal(await revParse(result.worktree), firstCommit);
  });

  test('defaults the repository to the session working directory', async () => {
    const repo = await initRepo(root, { name: 'cwd-repo-' + (counter + 1) });
    counter += 1;
    const session = sessionId('cwd-repo');
    const app = mountPlugin({ cwd: repo, config: config() });
    const result = await start(app, session, { slug: 'by-cwd' });
    assert.equal(result.ok, true);
    assert.equal(result.path, repo);
    assert.equal(existsSync(result.worktree), true);
  });

  test('a relative repo argument resolves against the session cwd', async () => {
    counter += 1;
    const repo = await initRepo(root, { name: 'relative-repo-' + counter });
    const session = sessionId('relative-repo');
    const app = mountPlugin({ cwd: root, config: config() });
    const result = await start(app, session, { repo: basename(repo), slug: 'relative' });
    assert.equal(result.ok, true);
    assert.equal(result.path, repo);
  });

  test('the default worktree root is <cwd>/.worktrees and its scratch is excluded from git status', async () => {
    counter += 1;
    const repo = await initRepo(root, { name: 'inner-root-repo-' + counter });
    const session = sessionId('inner-root');
    const app = mountPlugin({ cwd: repo, config: { stateRoot: join(root, 'state-inner-root') } });

    const result = await start(app, session, { slug: 'inner' });
    assert.equal(result.ok, true);
    assert.equal(result.worktree, join(repo, '.worktrees', basename(repo), 'inner'));

    const exclude = await git(repo, ['rev-parse', '--git-common-dir']);
    assert.equal(exclude.ok, true);
    // No git status noise from the plugin's own scratch directory.
    assert.equal(await gitOrThrow(repo, ['status', '--porcelain']), '');
    const excluded = await git(repo, ['check-ignore', '-v', join(repo, '.worktrees', basename(repo), 'inner', 'file-0.txt')]);
    assert.equal(excluded.ok, true);
    assert.match(excluded.stdout, /\.worktrees\//u);
  });

  test('reports a failed result, not an exception, for an unknown base', async () => {
    const { repo, session, app } = await setup();
    const result = await start(app, session, { repo, slug: 'bad-base', base: 'not-a-branch' });
    assert.equal(result.ok, false);
    assert.equal(result.action, 'start');
    assert.equal(result.error.code, 'worktree-failed');
    assert.match(result.error.message, /unknown base branch: not-a-branch/u);
  });

  test('reports a repo path that does not exist', async () => {
    const { session, app } = await setup();
    const result = await start(app, session, { repo: join(root, 'no-such-directory'), slug: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'repo-missing');
    assert.match(result.error.message, /No such path/u);
  });

  test('reports a path that is not inside a repository', async () => {
    const { session, app } = await setup();
    const plain = join(root, 'plain-start-dir');
    mkdirSync(plain, { recursive: true });
    const result = await start(app, session, { repo: plain, slug: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-a-repo');
    assert.match(result.error.message, /is not inside a git repository/u);
  });

  test('reports an unknown action with a hint naming the real ones', async () => {
    const { session, app } = await setup();
    const result = await app.tool.execute({ action: 'destroy' }, toolExec(session));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unknown-action');
    assert.deepEqual(result.error.hint, 'Use one of: start, list, remove.');
  });

  test('a missing action is reported rather than thrown', async () => {
    const { session, app } = await setup();
    const result = await app.tool.execute({}, toolExec(session));
    assert.equal(result.ok, false);
    assert.equal(result.action, 'worktree');
    assert.equal(result.error.code, 'unknown-action');
    assert.match(result.error.message, /\(none given\)/u);
  });

  test('reports recorded:false when the session state root cannot be written', async () => {
    counter += 1;
    const repo = await initRepo(root, { name: 'readonly-state-repo-' + counter });
    const stateFile = join(root, 'state-root-is-a-file');
    writeFileSync(stateFile, 'not a directory\n');
    const session = sessionId('unwritable-state');
    const app = mountPlugin({ cwd: root, config: config({ stateRoot: stateFile }) });

    const result = await start(app, session, { repo, slug: 'unrecorded' });
    assert.equal(result.ok, true);
    assert.equal(result.recorded, false);
    assert.equal(Array.isArray(result.notes), true);
    assert.equal(result.notes.length, 2);
    assert.match(result.notes[0], /does not own it/u);
    assert.equal(existsSync(result.worktree), true);
  });
});

describe('list', () => {
  test('reports the main checkout and the worktree this bundle created', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'listed' });
    const result = await list(app, session, { repo });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'list');
    assert.equal(result.path, repo);
    assert.equal(result.count, 2);
    assert.equal(result.worktrees.length, 2);

    const [main, task] = result.worktrees;
    assert.equal(main.path, repo);
    assert.equal(main.branch, 'main');
    assert.equal(main.main, true);
    assert.equal(main.owned, false);
    assert.equal(task.path, created.worktree);
    assert.equal(task.branch, 'dsh/listed');
    assert.equal(task.main, false);
    assert.equal(task.owned, true);
    assert.equal(task.locked, true);
    assert.equal(typeof task.head, 'string');
    assert.equal(task.head, await revParse(repo));
  });

  test('reports a worktree this bundle did not create as not owned', async () => {
    const { repo, session, app } = await setup();
    const foreign = join(root, 'list-foreign-worktree');
    await addForeignWorktree(repo, foreign, 'someone-elses');
    const result = await list(app, session, { repo });
    const row = result.worktrees.find((tree) => tree.path === foreign);
    assert.notEqual(row, undefined);
    assert.equal(row.owned, false);
    assert.equal(row.locked, undefined);
    assert.equal(row.branch, 'someone-elses');
  });

  test('reports a missing, unlocked worktree as prunable', async () => {
    const { repo, session, app } = await setup();
    const prunable = join(root, 'list-prunable-worktree');
    await addForeignWorktree(repo, prunable, 'prunable-branch');
    rmSync(prunable, { recursive: true, force: true });

    const result = await list(app, session, { repo });
    const row = result.worktrees.find((tree) => tree.path === prunable);
    assert.notEqual(row, undefined);
    assert.equal(row.prunable, true);
    assert.equal(row.owned, false);
  });

  test('reports a missing, locked worktree as locked rather than prunable', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'locked-missing' });
    rmSync(created.worktree, { recursive: true, force: true });

    const result = await list(app, session, { repo });
    const row = result.worktrees.find((tree) => tree.path === created.worktree);
    assert.notEqual(row, undefined);
    assert.equal(row.locked, true);
    assert.equal(row.prunable, undefined);
  });

  test('reports a detached worktree', async () => {
    const { repo, session, app } = await setup();
    const detached = join(root, 'list-detached-worktree');
    await addForeignWorktree(repo, detached, undefined, { detach: true });
    const result = await list(app, session, { repo });
    const row = result.worktrees.find((tree) => tree.path === detached);
    assert.notEqual(row, undefined);
    assert.equal(row.detached, true);
    assert.equal(row.branch, undefined);
  });

  test('accepts a linked worktree itself as the repo argument', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'from-worktree' });
    const result = await list(app, session, { repo: created.worktree });
    assert.equal(result.ok, true);
    assert.equal(result.path, repo);
    assert.equal(result.count, 2);
  });

  test('fails for a path outside every repository', async () => {
    const { session, app } = await setup();
    const plain = join(root, 'plain-list-dir');
    mkdirSync(plain, { recursive: true });
    const result = await list(app, session, { repo: plain });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-a-repo');
  });
});

describe('remove', () => {
  test('a dry run deletes nothing and says what it would remove', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'dry-run' });
    const result = await remove(app, session, { repo, slug: 'dry-run', apply: false });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'remove');
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.equal(result.removed, undefined);
    assert.equal(result.worktree, created.worktree);
    assert.equal(result.branch, 'dsh/dry-run');
    assert.equal(result.owned, true);
    assert.equal(existsSync(created.worktree), true);
    assert.equal(existsSync(markerFor(created.worktree)), true);
    assert.equal(readSession(session, { stateRoot }).worktrees.length, 1);
  });

  test('a dry run on a dirty worktree reports the refusal it would give', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'dirty-dry-run' });
    writeFileSync(join(created.worktree, 'uncommitted.txt'), 'work in progress\n');

    const result = await remove(app, session, { repo, slug: 'dirty-dry-run' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'dirty');
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.deepEqual(result.paths, ['uncommitted.txt']);
    assert.equal(existsSync(created.worktree), true);
  });

  test('a dry run on a foreign worktree reports the ownership refusal', async () => {
    const { repo, session, app } = await setup();
    const foreign = join(root, 'dry-run-foreign-worktree');
    await addForeignWorktree(repo, foreign, 'foreign-dry-run');
    const result = await remove(app, session, { repo: foreign });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-owned');
    assert.equal(result.dryRun, true);
    assert.equal(existsSync(foreign), true);
  });

  test('apply removes the worktree and forgets the session record', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'apply-me' });
    const result = await remove(app, session, { repo, slug: 'apply-me', apply: true });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.applied, true);
    assert.equal(result.removed, true);
    assert.equal(result.forgotten, true);
    assert.equal(existsSync(created.worktree), false);
    assert.equal(existsSync(markerFor(created.worktree)), false);
    assert.equal(readSession(session, { stateRoot }).worktrees.length, 0);
    // The branch survives a removal; deleting branches is dsh-git's business.
    assert.equal(await branchExists(repo, 'dsh/apply-me'), true);
  });

  test('refuses a worktree holding uncommitted work unless force is given', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'dirty-remove' });
    writeFileSync(join(created.worktree, 'uncommitted.txt'), 'work in progress\n');

    const refused = await remove(app, session, { repo, slug: 'dirty-remove', apply: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'dirty');
    assert.deepEqual(refused.paths, ['uncommitted.txt']);
    assert.equal(refused.dirtyCount, 1);
    assert.equal(existsSync(created.worktree), true);

    const forced = await remove(app, session, { repo, slug: 'dirty-remove', apply: true, force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.removed, true);
    assert.equal(existsSync(created.worktree), false);
  });

  test('refuses a foreign worktree unless force is given', async () => {
    const { repo, session, app } = await setup();
    const foreign = join(root, 'remove-foreign-worktree');
    await addForeignWorktree(repo, foreign, 'foreign-branch');

    const refused = await remove(app, session, { repo: foreign, apply: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'not-owned');
    assert.equal(refused.owned, false);
    assert.equal(refused.worktree, foreign);
    assert.match(refused.error.hint, /force: true/u);
    assert.equal(existsSync(foreign), true);

    const forced = await remove(app, session, { repo: foreign, apply: true, force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.removed, true);
    assert.equal(forced.owned, false);
    assert.equal(existsSync(foreign), false);
  });

  test('never removes the main checkout', async () => {
    const { repo, session, app } = await setup();
    const result = await remove(app, session, { repo, apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'main-checkout');
    assert.match(result.error.message, /refusing to remove the main working tree/u);
    assert.equal(existsSync(repo), true);
  });

  test('asks for a slug when the session owns more than one worktree', async () => {
    const { repo, session, app } = await setup();
    await start(app, session, { repo, slug: 'one' });
    await start(app, session, { repo, slug: 'two' });
    const result = await remove(app, session, { repo, apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'slug-required');
    assert.match(result.error.message, /2 worktrees/u);
  });

  test('removes the worktree a repo argument points at', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'pointed-at' });

    const dry = await remove(app, session, { repo: created.worktree });
    assert.equal(dry.ok, true);
    assert.equal(dry.worktree, created.worktree);

    const applied = await remove(app, session, { repo: created.worktree, apply: true });
    assert.equal(applied.ok, true);
    assert.equal(applied.removed, true);
    assert.equal(existsSync(created.worktree), false);
  });

  test('reports an unknown slug rather than removing anything', async () => {
    const { repo, session, app } = await setup();
    const result = await remove(app, session, { repo, slug: 'never-created', apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'nothing-to-remove');
    assert.match(result.error.message, /no worktree of .* is registered for slug "never-created"/u);
  });

  test('refuses a slug that does not name the branch of the named worktree', async () => {
    const { repo, session, app } = await setup();
    const foreign = join(root, 'mismatched-slug-worktree');
    await addForeignWorktree(repo, foreign, 'a-different-branch');
    const result = await remove(app, session, { repo: foreign, slug: 'not-matching' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'slug-mismatch');
    assert.match(result.error.message, /is on branch a-different-branch, not dsh\/not-matching/u);
  });

  test('drops the registration of a created worktree whose directory is gone', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'vanished-remove' });
    rmSync(created.worktree, { recursive: true, force: true });

    const result = await remove(app, session, { repo, slug: 'vanished-remove', apply: true });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.equal(readSession(session, { stateRoot }).worktrees.length, 0);
    assert.equal(existsSync(markerFor(created.worktree)), false);
    assert.equal((await listWorktrees(repo)).length, 1);
  });

  test('a second start after a removal hits the branch the removal kept', async () => {
    const { repo, session, app } = await setup();
    const created = await start(app, session, { repo, slug: 'reused-name' });
    const removed = await remove(app, session, { repo, slug: 'reused-name', apply: true });
    assert.equal(removed.ok, true);
    assert.equal(await branchExists(repo, 'dsh/reused-name'), true);
    assert.equal(existsSync(created.worktree), false);

    // Current behaviour: the removal keeps the branch (README.md: it does not
    // delete branches), so a second start with that slug collides with it and
    // reports git's own "already exists" sentence.
    const second = await start(app, session, { repo, slug: 'reused-name' });
    assert.equal(second.ok, false);
    assert.match(second.error.message, /already exists/u);
  });
});
