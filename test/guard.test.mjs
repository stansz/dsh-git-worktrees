/**
 * The edit guard, against real repositories and real worktrees.
 *
 * Two layers are exercised: the decision function (`decideWorktree`) on its own,
 * and the whole rule (`evaluateWorktree`/`registerWorktreeGuard`, including the
 * `tools/pre-execute` handler `index.js` registers) driven with the exec shape a
 * file tool really sends and a plain Cordis context.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  MUTATING_FILE_TOOLS,
  decideWorktree,
  editTarget,
  evaluateWorktree,
  hasOwnWorktree,
  ownedWorktreePath,
  registerWorktreeGuard,
} from '../lib/worktree-guard.mjs';
import { resolveConfig } from '../lib/config.mjs';
import {
  editExec,
  gitOrThrow,
  initRepo,
  makeCtx,
  makeTempRoot,
  mountPlugin,
  removeTempRoot,
  sessionId,
  toolExec,
} from './helpers.mjs';

let root;
let counter = 0;
let worktreeRoot;
let stateRoot;

before(() => {
  root = makeTempRoot('dsh-git-worktrees-guard-');
  worktreeRoot = join(root, 'worktrees');
  stateRoot = join(root, 'state');
});

after(() => removeTempRoot(root));

function rawConfig(overrides = {}) {
  return { worktreeRoot, stateRoot, ...overrides };
}

async function setup({ repoOptions = {}, cwd, rowConfig } = {}) {
  counter += 1;
  const repo = await initRepo(root, { name: 'guard-repo-' + counter, ...repoOptions });
  const session = sessionId('guard-' + counter);
  const app = mountPlugin({ cwd: cwd ?? root, config: rowConfig ?? rawConfig() });
  return { repo, session, app };
}

async function startWorktree(app, session, repo, slug = 'task') {
  const result = await app.tool.execute({ action: 'start', repo, slug }, toolExec(session));
  assert.equal(result.ok, true, 'fixture worktree should be created');
  return result;
}

/** Run the rule as the guard runs it for one file tool call. */
function evaluate(tool, args, session, { rowConfig, cwd } = {}) {
  return evaluateWorktree(editExec(tool, args, session), resolveConfig(rowConfig ?? rawConfig()), { cwd: cwd ?? root });
}

describe('editTarget', () => {
  test('recognises every mutating file tool', () => {
    for (const name of ['write', 'edit', 'str_replace_editor', 'notebook_edit', 'apply_patch']) {
      assert.equal(MUTATING_FILE_TOOLS.has(name), true, name + ' should be guarded');
      assert.equal(editTarget(editExec(name, { file_path: '/some/file.txt' }, 's')), '/some/file.txt');
    }
  });

  test('reads the target from whichever path argument the tool uses', () => {
    assert.equal(editTarget(editExec('write', { path: '/a' }, 's')), '/a');
    assert.equal(editTarget(editExec('write', { filePath: '/a' }, 's')), '/a');
    assert.equal(editTarget(editExec('notebook_edit', { notebook_path: '/a.ipynb' }, 's')), '/a.ipynb');
    assert.equal(editTarget(editExec('apply_patch', { target_file: '/a.patch' }, 's')), '/a.patch');
  });

  test('prefers file_path over path', () => {
    assert.equal(editTarget(editExec('write', { path: '/first', file_path: '/second' }, 's')), '/second');
  });

  test('ignores tools that do not write files', () => {
    assert.equal(editTarget(editExec('bash', { command: 'rm -rf /' }, 's')), undefined);
    assert.equal(editTarget(editExec('read', { file_path: '/a' }, 's')), undefined);
    assert.equal(editTarget(editExec('', { file_path: '/a' }, 's')), undefined);
  });

  test('ignores a call with no usable target', () => {
    assert.equal(editTarget(undefined), undefined);
    assert.equal(editTarget({ name: 'write' }), undefined);
    assert.equal(editTarget({ name: 'write', arguments: null }), undefined);
    assert.equal(editTarget({ name: 'write', arguments: [] }), undefined);
    assert.equal(editTarget(editExec('write', {}, 's')), undefined);
    assert.equal(editTarget(editExec('write', { file_path: '' }, 's')), undefined);
  });

  test('falls through an empty file_path to the next argument name', () => {
    assert.equal(editTarget(editExec('write', { file_path: '', path: '/next' }, 's')), '/next');
  });
});

describe('decideWorktree', () => {
  const mainRepo = '/tmp/work/repo';

  test('the default mode is protected and refuses a protected branch with the fix named', () => {
    const decision = decideWorktree({
      repoRoot: mainRepo,
      branch: 'main',
      insideOwned: false,
      protectedBranch: true,
    }, null);

    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /repository repo/u);
    assert.match(decision.reason, /protected branch "main"/u);
    assert.match(decision.reason, /worktree tool with action "start"/u);
    assert.equal(decision.displayReason, 'Blocked: edit to repo on "main" — start a worktree first');
  });

  test('off never refuses', () => {
    const decision = decideWorktree({
      repoRoot: mainRepo,
      branch: 'main',
      insideOwned: false,
      protectedBranch: true,
    }, { autoWorktree: 'off' });
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('protected allows a branch that is not protected', () => {
    const decision = decideWorktree({
      repoRoot: mainRepo,
      branch: 'feature/thing',
      insideOwned: false,
      protectedBranch: false,
    }, { autoWorktree: 'protected' });
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('inside the session own worktree is always allowed', () => {
    for (const autoWorktree of ['protected', 'always']) {
      for (const protectedBranch of [true, false]) {
        const decision = decideWorktree({
          repoRoot: mainRepo,
          branch: 'main',
          insideOwned: true,
          protectedBranch,
        }, { autoWorktree });
        assert.deepEqual(decision, { kind: 'allow' }, autoWorktree + ' / protectedBranch=' + protectedBranch);
      }
    }
  });

  test('always refuses any repository without a worktree, on any branch', () => {
    const decision = decideWorktree({
      repoRoot: mainRepo,
      branch: 'feature/thing',
      insideOwned: false,
      protectedBranch: false,
    }, { autoWorktree: 'always' });

    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /has no worktree for/u);
    assert.match(decision.reason, /it is on "feature\/thing"/u);
    assert.match(decision.reason, /autoWorktree is "always"/u);
    assert.equal(decision.displayReason, 'Blocked: edit to repo with no worktree — start one first');
  });

  test('always also refuses when the branch is unknown (detached HEAD)', () => {
    const decision = decideWorktree({
      repoRoot: mainRepo,
      branch: undefined,
      insideOwned: false,
      protectedBranch: false,
    }, { autoWorktree: 'always' });
    assert.equal(decision.kind, 'deny');
    assert.equal(/it is on/u.test(decision.reason), false);
  });

  test('an unusable snapshot is allowed, never turned into a refusal', () => {
    const config = { autoWorktree: 'protected' };
    assert.deepEqual(decideWorktree(null, config), { kind: 'allow' });
    assert.deepEqual(decideWorktree(undefined, config), { kind: 'allow' });
    assert.deepEqual(decideWorktree({}, config), { kind: 'allow' });
    assert.deepEqual(decideWorktree({ repoRoot: '' }, config), { kind: 'allow' });
  });
});

describe('evaluateWorktree in protected mode', () => {
  test('refuses an edit landing in a repository on main', async () => {
    const { repo, session } = await setup();
    const decision = await evaluate('write', { file_path: join(repo, 'notes.txt') }, session);

    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, new RegExp('repository ' + basename(repo), 'u'));
    assert.match(decision.reason, /protected branch "main"/u);
    assert.match(decision.reason, /action "start"/u);
    assert.match(decision.displayReason, /^Blocked: edit to /u);
  });

  test('refuses a new file in a directory that does not exist yet', async () => {
    const { repo, session } = await setup();
    const decision = await evaluate('write', { file_path: join(repo, 'src', 'deep', 'nested', 'new-file.js') }, session);
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /protected branch "main"/u);
  });

  test('refuses through every guarded file tool', async () => {
    const { repo, session } = await setup();
    const calls = [
      ['write', { file_path: join(repo, 'a.txt') }],
      ['edit', { file_path: join(repo, 'b.txt') }],
      ['str_replace_editor', { path: join(repo, 'c.txt') }],
      ['notebook_edit', { notebook_path: join(repo, 'd.ipynb') }],
      ['apply_patch', { target_file: join(repo, 'e.txt') }],
    ];
    for (const [name, args] of calls) {
      const decision = await evaluate(name, args, session);
      assert.equal(decision.kind, 'deny', name + ' should be refused on main');
    }
  });

  test('refuses a relative target resolved against the session cwd', async () => {
    const { repo, session } = await setup();
    const decision = await evaluate('edit', { file_path: 'file-0.txt' }, session, { cwd: repo });
    assert.equal(decision.kind, 'deny');
  });

  test('allows an edit in a repository on a non-protected branch', async () => {
    const { repo, session } = await setup();
    await gitOrThrow(repo, ['checkout', '-q', '-b', 'feature/thing']);
    const decision = await evaluate('edit', { file_path: join(repo, 'file-0.txt') }, session);
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('allows an edit inside the worktree this session owns', async () => {
    const { repo, session, app } = await setup();
    const created = await startWorktree(app, session, repo, 'guarded-task');
    const decision = await evaluate('write', { file_path: join(created.worktree, 'file-0.txt') }, session);
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('inside the owned worktree wins even when its branch is on the protected list', async () => {
    const rowConfig = rawConfig({ protectedBranches: ['main', 'master', 'dsh/guarded-task'] });
    const { repo, session, app } = await setup({ rowConfig });
    const created = await startWorktree(app, session, repo, 'guarded-task');
    const decision = await evaluate('write', { file_path: join(created.worktree, 'file-0.txt') }, session, { rowConfig });
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('refuses the main checkout even when this session owns a worktree for the repository', async () => {
    const { repo, session, app } = await setup();
    await startWorktree(app, session, repo, 'somewhere-else');
    const decision = await evaluate('edit', { file_path: join(repo, 'file-0.txt') }, session);
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /protected branch "main"/u);
  });

  test('allows a repository whose protected branch has no commits yet', async () => {
    counter += 1;
    const repo = await initRepo(root, { name: 'unborn-repo-' + counter, commits: 0 });
    const session = sessionId('unborn-' + counter);
    const decision = await evaluate('write', { file_path: join(repo, 'first-file.txt') }, session);
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('an explicitly empty protectedBranches list allows main', async () => {
    const { repo, session } = await setup();
    const rowConfig = rawConfig({ protectedBranches: [] });
    const decision = await evaluate('write', { file_path: join(repo, 'file-0.txt') }, session, { rowConfig });
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('autoWorktree off allows everything', async () => {
    const { repo, session } = await setup();
    const rowConfig = rawConfig({ autoWorktree: 'off' });
    const decision = await evaluate('write', { file_path: join(repo, 'file-0.txt') }, session, { rowConfig });
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('the worktrees:false shorthand turns the guard off', async () => {
    const { repo, session } = await setup();
    const rowConfig = rawConfig({ worktrees: false });
    const decision = await evaluate('write', { file_path: join(repo, 'file-0.txt') }, session, { rowConfig });
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('allows a path outside every repository', async () => {
    const { session } = await setup();
    const plain = join(root, 'plain-guard-dir');
    mkdirSync(plain, { recursive: true });
    const decision = await evaluate('write', { file_path: join(plain, 'file.txt') }, session);
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('allows a tool that does not write files, and one with no target', async () => {
    const { repo, session } = await setup();
    assert.deepEqual(await evaluate('bash', { command: 'touch x' }, session), { kind: 'allow' });
    assert.deepEqual(await evaluate('read', { file_path: join(repo, 'file-0.txt') }, session), { kind: 'allow' });
    assert.deepEqual(await evaluate('write', {}, session), { kind: 'allow' });
  });

  test('allows when the exec has no session identity', async () => {
    const { repo } = await setup();
    const decision = await evaluateWorktree(
      { name: 'write', arguments: { file_path: join(repo, 'file-0.txt') } },
      resolveConfig(rawConfig()),
      { cwd: root },
    );
    assert.deepEqual(decision, { kind: 'allow' });
  });
});

describe('evaluateWorktree and symlinks', () => {
  test('a symlink inside the worktree that points at the main checkout is a write into main', async () => {
    const { repo, session, app } = await setup();
    const created = await startWorktree(app, session, repo, 'symlink-escape');
    symlinkSync(repo, join(created.worktree, 'escape'), 'dir');

    const decision = await evaluate('write', { file_path: join(created.worktree, 'escape', 'evil.txt') }, session);
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /protected branch "main"/u);
  });

  test('a symlinked directory resolving inside the worktree is still inside it', async () => {
    const { repo, session, app } = await setup();
    const created = await startWorktree(app, session, repo, 'symlink-inside');
    const alias = join(root, 'alias-to-worktree');
    symlinkSync(created.worktree, alias, 'dir');

    const decision = await evaluate('write', { file_path: join(alias, 'new-file.txt') }, session);
    assert.deepEqual(decision, { kind: 'allow' });
  });
});

describe('evaluateWorktree in always mode', () => {
  test('refuses a repository this session has no worktree for, on any branch', async () => {
    const rowConfig = rawConfig({ autoWorktree: 'always' });
    const { repo, session } = await setup({ rowConfig });
    await gitOrThrow(repo, ['checkout', '-q', '-b', 'feature/thing']);
    const decision = await evaluate('write', { file_path: join(repo, 'file-0.txt') }, session, { rowConfig });
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /has no worktree for/u);
    assert.match(decision.reason, /autoWorktree is "always"/u);
  });

  test('allows the worktree this session owns', async () => {
    const rowConfig = rawConfig({ autoWorktree: 'always' });
    const { repo, session, app } = await setup({ rowConfig });
    const created = await startWorktree(app, session, repo, 'always-task');
    assert.deepEqual(await evaluate('write', { file_path: join(created.worktree, 'file-0.txt') }, session, { rowConfig }), { kind: 'allow' });
  });

  test('an edit to the main checkout is refused even while the worktree exists', async () => {
    const rowConfig = rawConfig({ autoWorktree: 'always' });
    const { repo, session, app } = await setup({ rowConfig });
    await startWorktree(app, session, repo, 'always-task');
    const decision = await evaluate('write', { file_path: join(repo, 'file-0.txt') }, session, { rowConfig });
    assert.equal(decision.kind, 'deny');
  });

  test('a worktree git moved counts at its new path', async () => {
    const rowConfig = rawConfig({ autoWorktree: 'always' });
    const { repo, session, app } = await setup({ rowConfig });
    const created = await startWorktree(app, session, repo, 'moved-task');
    const moved = join(root, 'moved-worktree');
    await gitOrThrow(repo, ['worktree', 'unlock', created.worktree]);
    await gitOrThrow(repo, ['worktree', 'move', created.worktree, moved]);

    const decision = await evaluate('write', { file_path: join(moved, 'file-0.txt') }, session, { rowConfig });
    assert.deepEqual(decision, { kind: 'allow' });

    const inMain = await evaluate('write', { file_path: join(repo, 'file-0.txt') }, session, { rowConfig });
    assert.equal(inMain.kind, 'deny');
  });
});

describe('record-level ownership helpers', () => {
  test('ownedWorktreePath reports the path this session recorded', async () => {
    const { repo, session, app } = await setup();
    const created = await startWorktree(app, session, repo, 'record-level');
    const config = resolveConfig(rawConfig());

    assert.equal(ownedWorktreePath(session, repo, config), created.worktree);
    assert.equal(hasOwnWorktree(session, repo, config), true);
  });

  test('a repository this session has no record for reports nothing', async () => {
    const { repo, session } = await setup();
    const config = resolveConfig(rawConfig());
    assert.equal(ownedWorktreePath(session, repo, config), undefined);
    assert.equal(hasOwnWorktree(session, repo, config), false);
    assert.equal(ownedWorktreePath(session, '', config), undefined);
  });

  test('a recorded path whose directory is gone is not owned', async () => {
    const { repo, session, app } = await setup();
    const created = await startWorktree(app, session, repo, 'gone-record');
    rmSync(created.worktree, { recursive: true, force: true });
    const config = resolveConfig(rawConfig());
    assert.equal(ownedWorktreePath(session, repo, config), undefined);
    assert.equal(hasOwnWorktree(session, repo, config), false);
  });
});

describe('registerWorktreeGuard', () => {
  test('the registered pre-execute listener denies an edit on main', async () => {
    const { repo, session, app } = await setup();
    let calledNext = false;
    const next = () => {
      calledNext = true;
      return { kind: 'allow', fromNext: true };
    };

    const decision = await app.preExecute(editExec('write', { file_path: join(repo, 'file-0.txt') }, session), next);
    assert.equal(calledNext, false, 'a denial must not run the tool');
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /protected branch "main"/u);
    assert.equal(typeof decision.displayReason.en, 'string');
    assert.match(decision.displayReason.en, /Blocked/u);
    assert.deepEqual(decision.info, { name: 'dsh-git-worktrees', code: 'worktree-required' });
    assert.equal(app.logs.length, 1);
    assert.match(app.logs[0], /guard denied an edit/u);
  });

  test('the registered listener calls next() and returns its value for an allowed edit', async () => {
    const { repo, session, app } = await setup();
    let calledNext = false;
    const next = () => {
      calledNext = true;
      return { kind: 'allow', fromNext: true };
    };
    const plain = join(root, 'plain-hook-dir');
    mkdirSync(plain, { recursive: true });

    const allowed = await app.preExecute(editExec('write', { file_path: join(plain, 'file.txt') }, session), next);
    assert.equal(calledNext, true);
    assert.deepEqual(allowed, { kind: 'allow', fromNext: true });

    calledNext = false;
    const ignoredTool = await app.preExecute(editExec('bash', { command: 'ls' }, session), next);
    assert.equal(calledNext, true);
    assert.deepEqual(ignoredTool, { kind: 'allow', fromNext: true });

    assert.equal(app.logs.length, 0);
  });

  test('a guard mounted on a worktrees:false row lets the edit through', async () => {
    const { repo, session, app } = await setup({ rowConfig: rawConfig({ worktrees: false }) });
    let calledNext = false;
    const next = () => {
      calledNext = true;
      return { kind: 'allow' };
    };
    const decision = await app.preExecute(editExec('write', { file_path: join(repo, 'file-0.txt') }, session), next);
    assert.equal(calledNext, true);
    assert.deepEqual(decision, { kind: 'allow' });
  });

  test('a config resolver that throws fails soft and runs the tool', async () => {
    const { repo, session } = await setup();
    const harness = makeCtx({ cwd: root });
    registerWorktreeGuard(harness.ctx, rawConfig(), {
      cwdOf: () => root,
      resolveConfig: () => {
        throw new Error('config exploded');
      },
    });
    const handler = harness.handlers.get('tools/pre-execute');

    let calledNext = false;
    const decision = await handler(editExec('write', { file_path: join(repo, 'file-0.txt') }, session), () => {
      calledNext = true;
      return { kind: 'allow', fromNext: true };
    });
    assert.equal(calledNext, true);
    assert.deepEqual(decision, { kind: 'allow', fromNext: true });
  });

  test('a context without a logger still denies without throwing', async () => {
    const { repo, session } = await setup();
    const ctx = {
      on(event, handler) {
        this.handler = handler;
      },
    };
    registerWorktreeGuard(ctx, rawConfig(), { cwdOf: () => root, resolveConfig });
    const decision = await ctx.handler(
      editExec('write', { file_path: join(repo, 'file-0.txt') }, session),
      () => ({ kind: 'allow' }),
    );
    assert.equal(decision.kind, 'deny');
  });

  test('the listener resolves the row config per call, so a changed mode is picked up', async () => {
    const { repo, session } = await setup();
    const harness = makeCtx({ cwd: root });
    const rowConfig = rawConfig();
    registerWorktreeGuard(harness.ctx, rowConfig, { cwdOf: () => root, resolveConfig });
    const handler = harness.handlers.get('tools/pre-execute');
    const next = () => {
      throw new Error('next should not run');
    };
    const exec = editExec('write', { file_path: join(repo, 'file-0.txt') }, session);

    assert.equal((await handler(exec, next)).kind, 'deny');
    rowConfig.autoWorktree = 'off';
    assert.deepEqual(await handler(exec, () => ({ kind: 'allow' })), { kind: 'allow' });
  });
});
