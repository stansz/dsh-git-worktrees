/**
 * The pure rules: settings, branch and path naming, ownership markers, worktree
 * matching, and the `git worktree list --porcelain` parser. None of this needs a
 * repository; the files that do are tool.test.mjs, worktrees.test.mjs and
 * guard.test.mjs.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  AUTO_WORKTREE_MODES,
  DEFAULT_CONFIG,
  isProtectedBranch,
  resolveConfig,
  worktreeRootFor,
} from '../lib/config.mjs';
import {
  branchNameFor,
  findWorktreeForBranch,
  isInsideBranchPrefix,
  isOwnedWorktreePath,
  slugify,
  worktreePathFor,
} from '../lib/worktrees.mjs';
import { parseWorktrees } from '../lib/git.mjs';
import { makeTempRoot, markerFor, readJson, removeTempRoot } from './helpers.mjs';

describe('resolveConfig', () => {
  test('fills every default for an absent, null or empty row config', () => {
    assert.deepEqual(resolveConfig(), DEFAULT_CONFIG);
    assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG);
    assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG);
    assert.deepEqual(resolveConfig('not an object'), DEFAULT_CONFIG);
  });

  test('the documented defaults are exactly the ones chosen', () => {
    assert.equal(DEFAULT_CONFIG.autoWorktree, 'protected');
    assert.equal(DEFAULT_CONFIG.worktrees, true);
    assert.deepEqual(DEFAULT_CONFIG.protectedBranches, ['main', 'master']);
    assert.equal(DEFAULT_CONFIG.branchPrefix, 'dsh/');
    assert.equal(DEFAULT_CONFIG.worktreeRoot, null);
    assert.equal(DEFAULT_CONFIG.stateRoot, null);
    assert.deepEqual(AUTO_WORKTREE_MODES, ['off', 'protected', 'always']);
  });

  test('drops unknown keys', () => {
    const config = resolveConfig({ nope: 1, anotherThing: 'x' });
    assert.equal(Object.hasOwn(config, 'nope'), false);
    assert.equal(Object.hasOwn(config, 'anotherThing'), false);
  });

  test('does not share the default protected-branch array with callers', () => {
    const config = resolveConfig();
    config.protectedBranches.push('release');
    assert.deepEqual(DEFAULT_CONFIG.protectedBranches, ['main', 'master']);
    assert.deepEqual(resolveConfig().protectedBranches, ['main', 'master']);
  });

  test('an unknown autoWorktree value falls back to protected', () => {
    assert.equal(resolveConfig({ autoWorktree: 'protcted' }).autoWorktree, 'protected');
    assert.equal(resolveConfig({ autoWorktree: 'ALWAYS' }).autoWorktree, 'protected');
  });

  test('a typo is not a choice: worktrees:false beside it still turns enforcement off', () => {
    const config = resolveConfig({ autoWorktree: 'protcted', worktrees: false });
    assert.equal(config.autoWorktree, 'off');
    assert.equal(config.worktrees, false);
    assert.deepEqual(config.protectedBranches, []);
  });

  test('worktrees:false alone means off with no protected branches', () => {
    const config = resolveConfig({ worktrees: false });
    assert.equal(config.autoWorktree, 'off');
    assert.equal(config.worktrees, false);
    assert.deepEqual(config.protectedBranches, []);
  });

  test('worktrees:true alone means protected with the default branches', () => {
    const config = resolveConfig({ worktrees: true });
    assert.equal(config.autoWorktree, 'protected');
    assert.equal(config.worktrees, true);
    assert.deepEqual(config.protectedBranches, ['main', 'master']);
  });

  test('a named autoWorktree wins over the worktrees shorthand', () => {
    const config = resolveConfig({ worktrees: true, autoWorktree: 'always' });
    assert.equal(config.autoWorktree, 'always');
    assert.equal(config.worktrees, true);
  });

  test('a named protectedBranches list is kept whatever the shorthand says', () => {
    const config = resolveConfig({ worktrees: false, protectedBranches: ['release'] });
    assert.equal(config.autoWorktree, 'off');
    assert.deepEqual(config.protectedBranches, ['release']);
  });

  test('the resolved worktrees flag always agrees with the mode', () => {
    assert.equal(resolveConfig({ autoWorktree: 'off' }).worktrees, false);
    assert.equal(resolveConfig({ autoWorktree: 'protected' }).worktrees, true);
    assert.equal(resolveConfig({ autoWorktree: 'always' }).worktrees, true);
  });

  test('an explicit empty protectedBranches list protects nothing', () => {
    assert.deepEqual(resolveConfig({ protectedBranches: [] }).protectedBranches, []);
  });

  test('protected branch entries are trimmed and blanks are dropped', () => {
    assert.deepEqual(resolveConfig({ protectedBranches: [' main ', '', '  ', 'trunk'] }).protectedBranches, ['main', 'trunk']);
  });

  test('an all-blank protectedBranches list falls back to the default', () => {
    assert.deepEqual(resolveConfig({ protectedBranches: ['', '  '] }).protectedBranches, ['main', 'master']);
  });

  test('a blank branchPrefix falls back to the default', () => {
    assert.equal(resolveConfig({ branchPrefix: '   ' }).branchPrefix, 'dsh/');
    assert.equal(resolveConfig({ branchPrefix: 'task/' }).branchPrefix, 'task/');
  });

  test('worktreeRoot is expanded for ~ but left relative otherwise', () => {
    assert.equal(resolveConfig({ worktreeRoot: '~/wt' }).worktreeRoot, join(homedir(), 'wt'));
    assert.equal(resolveConfig({ worktreeRoot: 'wt/here' }).worktreeRoot, 'wt/here');
    assert.equal(resolveConfig({ worktreeRoot: '/abs/wt' }).worktreeRoot, '/abs/wt');
    assert.equal(resolveConfig({ worktreeRoot: '   ' }).worktreeRoot, null);
  });

  test('stateRoot is expanded for ~ and keeps a configured value', () => {
    assert.equal(resolveConfig({ stateRoot: '/tmp/state' }).stateRoot, '/tmp/state');
    assert.equal(resolveConfig({ stateRoot: '~/state' }).stateRoot, join(homedir(), 'state'));
    assert.equal(resolveConfig({ stateRoot: '  ' }).stateRoot, null);
  });
});

describe('isProtectedBranch', () => {
  test('matches the configured list exactly', () => {
    assert.equal(isProtectedBranch(DEFAULT_CONFIG, 'main'), true);
    assert.equal(isProtectedBranch(DEFAULT_CONFIG, 'master'), true);
    assert.equal(isProtectedBranch(DEFAULT_CONFIG, 'feature/x'), false);
    assert.equal(isProtectedBranch(DEFAULT_CONFIG, 'Main'), false);
    assert.equal(isProtectedBranch(DEFAULT_CONFIG, 'main2'), false);
  });

  test('a blank or missing branch name answers true, not safe', () => {
    assert.equal(isProtectedBranch(DEFAULT_CONFIG, undefined), true);
    assert.equal(isProtectedBranch(DEFAULT_CONFIG, ''), true);
    assert.equal(isProtectedBranch(DEFAULT_CONFIG, '   '), true);
  });

  test('falls back to the default list when config carries none', () => {
    assert.equal(isProtectedBranch(undefined, 'main'), true);
    assert.equal(isProtectedBranch({}, 'master'), true);
  });

  test('an explicit empty list protects nothing', () => {
    assert.equal(isProtectedBranch({ protectedBranches: [] }, 'main'), false);
  });

  test('honours a custom list', () => {
    assert.equal(isProtectedBranch({ protectedBranches: ['trunk'] }, 'trunk'), true);
    assert.equal(isProtectedBranch({ protectedBranches: ['trunk'] }, 'main'), false);
  });
});

describe('worktreeRootFor', () => {
  test('defaults to <cwd>/.worktrees', () => {
    assert.equal(worktreeRootFor(resolveConfig(), '/workspace'), join('/workspace', '.worktrees'));
    assert.equal(worktreeRootFor(null, '/workspace'), join('/workspace', '.worktrees'));
    assert.equal(worktreeRootFor({ worktreeRoot: null }, '/workspace'), join('/workspace', '.worktrees'));
  });

  test('resolves a relative root against the session cwd', () => {
    assert.equal(worktreeRootFor({ worktreeRoot: 'wt' }, '/workspace'), join('/workspace', 'wt'));
    assert.equal(worktreeRootFor({ worktreeRoot: 'a/b' }, '/workspace'), join('/workspace', 'a/b'));
  });

  test('keeps an absolute root as given', () => {
    assert.equal(worktreeRootFor({ worktreeRoot: '/elsewhere/wt' }, '/workspace'), '/elsewhere/wt');
  });

  test('expands ~ against the home directory', () => {
    assert.equal(worktreeRootFor({ worktreeRoot: '~' }, '/workspace'), homedir());
    assert.equal(worktreeRootFor({ worktreeRoot: '~/wt' }, '/workspace'), join(homedir(), 'wt'));
  });

  test('falls back to the process directory without a cwd', () => {
    assert.equal(worktreeRootFor(resolveConfig()), join(process.cwd(), '.worktrees'));
    assert.equal(worktreeRootFor(resolveConfig(), '   '), join(process.cwd(), '.worktrees'));
  });
});

describe('slugify', () => {
  test('folds a title into a branch-and-directory safe slug', () => {
    assert.equal(slugify('Fix the Login Bug!'), 'fix-the-login-bug');
    assert.equal(slugify('  spaces   around  '), 'spaces-around');
    assert.equal(slugify('A_B.C'), 'a-b-c');
  });

  test('folds accents away', () => {
    assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
  });

  test('never returns empty, and never a path', () => {
    assert.equal(slugify(''), 'task');
    assert.equal(slugify(null), 'task');
    assert.equal(slugify(undefined), 'task');
    assert.equal(slugify('---'), 'task');
    assert.equal(slugify('日本語'), 'task');
    assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
    assert.equal(slugify('..'), 'task');
  });

  test('keeps at most 50 characters and no edge dashes', () => {
    const slug = slugify('a'.repeat(80));
    assert.equal(slug, 'a'.repeat(50));
    const dashed = slugify('-'.repeat(4) + 'b'.repeat(60));
    // The slice happens before the edge dashes are trimmed, so the leading run
    // costs its characters: 50 - 1 leading dash.
    assert.equal(dashed, 'b'.repeat(49));
    assert.equal(dashed.startsWith('-'), false);
    assert.equal(dashed.endsWith('-'), false);
  });

  test('a non-string value is stringified', () => {
    assert.equal(slugify(123), '123');
  });
});

describe('worktreePathFor', () => {
  test('lays a task out as <root>/<repo>/<slug>', () => {
    assert.equal(worktreePathFor('/wt', 'my-repo', 'Fix It'), join('/wt', 'my-repo', 'fix-it'));
  });

  test('uses only the last segment of the repository name', () => {
    assert.equal(worktreePathFor('/wt', 'some/path/my-repo', 'x'), join('/wt', 'my-repo', 'x'));
  });

  test('falls back to "repo" for an unusable repository name', () => {
    assert.equal(worktreePathFor('/wt', '', 'x'), join('/wt', 'repo', 'x'));
    assert.equal(worktreePathFor('/wt', '..', 'x'), join('/wt', 'repo', 'x'));
  });

  test('resolves an empty root against the process directory', () => {
    assert.equal(worktreePathFor('', 'repo', 'x'), join(resolve('.'), 'repo', 'x'));
  });

  test('slugifies the slug it is given', () => {
    assert.equal(worktreePathFor('/wt', 'repo', '..'), join('/wt', 'repo', 'task'));
  });
});

describe('branchNameFor', () => {
  test('builds <branchPrefix><slug>', () => {
    assert.equal(branchNameFor('dsh/', 'Fix It'), 'dsh/fix-it');
    assert.equal(branchNameFor('dsh', 'fix-it'), 'dsh/fix-it');
    assert.equal(branchNameFor('task/agent', 'x'), 'task/agent/x');
  });

  test('an empty prefix leaves just the slug', () => {
    assert.equal(branchNameFor('', 'x'), 'x');
    assert.equal(branchNameFor(undefined, 'x'), 'x');
  });

  test('cleans characters git refuses in a ref name', () => {
    assert.equal(branchNameFor('task.', 'x'), 'task/x');
    assert.equal(branchNameFor('a~b', 'x'), 'a-b/x');
  });
});

describe('isInsideBranchPrefix', () => {
  test('matches a whole namespace segment, not a string prefix', () => {
    assert.equal(isInsideBranchPrefix('dsh/fix', 'dsh'), true);
    assert.equal(isInsideBranchPrefix('dsh/fix', 'dsh/'), true);
    assert.equal(isInsideBranchPrefix('dshx', 'dsh'), false);
    assert.equal(isInsideBranchPrefix('dsh', 'dsh'), false);
  });

  test('an empty prefix matches nothing', () => {
    assert.equal(isInsideBranchPrefix('dsh/fix', ''), false);
    assert.equal(isInsideBranchPrefix('dsh/fix', undefined), false);
  });

  test('a nested prefix matches only its own namespace', () => {
    assert.equal(isInsideBranchPrefix('task/agent/x', 'task/agent'), true);
    assert.equal(isInsideBranchPrefix('task/agentx', 'task/agent'), false);
  });

  test('a non-string name matches nothing', () => {
    assert.equal(isInsideBranchPrefix(undefined, 'dsh'), false);
    assert.equal(isInsideBranchPrefix('', 'dsh'), false);
  });
});

describe('isOwnedWorktreePath', () => {
  let root;
  let repoRoot;

  before(() => {
    root = makeTempRoot('dsh-git-worktrees-owned-');
    repoRoot = join(root, 'worktrees', 'repo');
    mkdirSync(repoRoot, { recursive: true });
  });

  after(() => removeTempRoot(root));

  function worktree(name) {
    const path = join(repoRoot, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  test('true for the marker written beside a worktree', () => {
    const path = worktree('one');
    writeFileSync(markerFor(path), JSON.stringify({ repo: 'repo', path, branch: 'dsh/one', slug: 'one' }));
    assert.equal(isOwnedWorktreePath(path), true);
  });

  test('false without a marker', () => {
    assert.equal(isOwnedWorktreePath(worktree('no-marker')), false);
  });

  test('false when the marker names a different path', () => {
    const path = worktree('moved');
    const other = join(repoRoot, 'somewhere-else');
    writeFileSync(markerFor(path), JSON.stringify({ path: other, branch: 'dsh/moved' }));
    assert.equal(isOwnedWorktreePath(path), false);
  });

  test('false when the marker is malformed or missing its branch', () => {
    const broken = worktree('broken');
    writeFileSync(markerFor(broken), 'not json at all');
    assert.equal(isOwnedWorktreePath(broken), false);

    const branchless = worktree('branchless');
    writeFileSync(markerFor(branchless), JSON.stringify({ path: branchless }));
    assert.equal(isOwnedWorktreePath(branchless), false);
  });

  test('false for a missing or non-string path', () => {
    assert.equal(isOwnedWorktreePath(undefined), false);
    assert.equal(isOwnedWorktreePath(''), false);
    assert.equal(isOwnedWorktreePath(join(repoRoot, 'does-not-exist')), false);
  });

  test('the marker beside a real worktree parses as the documented record', () => {
    const path = worktree('recorded');
    writeFileSync(markerFor(path), JSON.stringify({
      repo: 'repo',
      path,
      branch: 'dsh/recorded',
      slug: 'recorded',
      createdAt: new Date().toISOString(),
      task: 'recorded task',
    }));
    const record = readJson(markerFor(path));
    assert.equal(record.path, path);
    assert.equal(record.branch, 'dsh/recorded');
    assert.equal(record.task, 'recorded task');
  });
});

describe('findWorktreeForBranch', () => {
  let root;
  let mainPath;
  let worktreePath;
  let nestedPath;

  before(() => {
    root = makeTempRoot('dsh-git-worktrees-find-');
    mainPath = join(root, 'repo');
    worktreePath = join(mainPath, 'sub', 'task');
    nestedPath = join(mainPath, 'nested-nested');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(nestedPath, { recursive: true });
  });

  after(() => removeTempRoot(root));

  function list() {
    return [
      { path: mainPath, branch: 'main' },
      { path: worktreePath, branch: 'dsh/task' },
      { path: nestedPath, branch: 'other' },
    ];
  }

  test('the main checkout is reported as main', () => {
    const found = findWorktreeForBranch(list(), mainPath);
    assert.equal(found.isMain, true);
    assert.equal(found.mainPath, mainPath);
    assert.equal(found.worktree.branch, 'main');
  });

  test('a linked worktree is found and is not main', () => {
    const found = findWorktreeForBranch(list(), worktreePath);
    assert.equal(found.isMain, false);
    assert.equal(found.worktree.branch, 'dsh/task');
  });

  test('a directory inside a linked worktree belongs to it', () => {
    const inside = join(worktreePath, 'src', 'deep');
    mkdirSync(inside, { recursive: true });
    const found = findWorktreeForBranch(list(), inside);
    assert.equal(found.worktree.path, worktreePath);
  });

  test('the longest matching worktree wins', () => {
    const inside = join(nestedPath, 'src');
    mkdirSync(inside, { recursive: true });
    const found = findWorktreeForBranch(list(), inside);
    assert.equal(found.worktree.path, nestedPath);
  });

  test('a path outside every worktree is not found', () => {
    const found = findWorktreeForBranch(list(), join(root, 'elsewhere'));
    assert.equal(found.worktree, undefined);
    assert.equal(found.isMain, false);
  });

  test('an unusable list answers "not found" rather than throwing', () => {
    assert.deepEqual(findWorktreeForBranch(null, mainPath), { worktree: undefined, isMain: false, mainPath: undefined });
    assert.deepEqual(findWorktreeForBranch([], mainPath), { worktree: undefined, isMain: false, mainPath: undefined });
  });

  test('a /tmp spelling matches the worktree git reports as /private/tmp', () => {
    const viaTmp = makeTempRoot('dsh-git-worktrees-realpath-');
    try {
      const real = realpathSync(viaTmp);
      const found = findWorktreeForBranch([{ path: real, branch: 'x' }], viaTmp);
      assert.equal(found.worktree?.path, real);
    } finally {
      removeTempRoot(viaTmp);
    }
  });
});

describe('parseWorktrees', () => {
  test('parses the porcelain blocks git prints', () => {
    const porcelain = [
      'worktree /nonexistent/main',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /nonexistent/task',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/dsh/task',
      'locked dsh',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    const trees = parseWorktrees(porcelain);
    assert.equal(trees.length, 2);
    assert.equal(trees[0].path, '/nonexistent/main');
    assert.equal(trees[0].branch, 'main');
    assert.equal(trees[0].head, '1111111111111111111111111111111111111111');
    assert.equal(trees[0].locked, undefined);
    assert.equal(trees[1].path, '/nonexistent/task');
    assert.equal(trees[1].branch, 'dsh/task');
    assert.equal(trees[1].locked, true);
    assert.equal(trees[1].lockReason, 'dsh');
    assert.equal(trees[1].prunable, true);
    assert.equal(trees[1].pruneReason, 'gitdir file points to non-existent location');
  });

  test('parses a detached and a bare record', () => {
    const trees = parseWorktrees([
      'worktree /nonexistent/detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
      'worktree /nonexistent/bare',
      'bare',
      '',
    ].join('\n'));
    assert.equal(trees.length, 2);
    assert.equal(trees[0].detached, true);
    assert.equal(trees[0].branch, undefined);
    assert.equal(trees[1].bare, true);
  });

  test('an empty listing is an empty array', () => {
    assert.deepEqual(parseWorktrees(''), []);
    assert.deepEqual(parseWorktrees(undefined), []);
  });
});
