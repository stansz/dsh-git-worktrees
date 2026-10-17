/**
 * Shared fixtures for the dsh-git-worktrees test suite.
 *
 * Every test builds its own real repository under a fresh directory in
 * `os.tmpdir()` and removes it in an `after` hook. The git commands here create
 * plain fixture repositories *inside that temp directory* — the suite never runs
 * git against this checkout or against any repository it did not just create —
 * because the tool and the guard only mean something against a real repository
 * with a real HEAD, and there is no way to test "create worktree from main"
 * without a main that exists.
 *
 * The implementation modules are imported through their real entry points
 * (`../index.js`, `../lib/*.mjs`); only the Cordis context is a plain object, in
 * the shape `index.js` and the modules actually read.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import * as plugin from '../index.js';

const execFileAsync = promisify(execFile);

// The machine's own git configuration is deliberately kept out of every command,
// including the plugin's own (its run() inherits process.env): a user-level
// commit.gpgsign, init.defaultBranch or hooks path must not change what a test
// asserts. A fixture repository's *local* config still applies, which is where
// the commit identity comes from.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_ASKPASS = '';

/** A fresh, realpath'd temp directory for one test file. */
export function makeTempRoot(prefix = 'dsh-git-worktrees-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Delete a temp root, including any worktrees and state files under it. */
export function removeTempRoot(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Run one git command in a directory. Resolves `{ok, stdout, stderr}` and never
 * throws for a non-zero exit; `gitOrThrow` is the fixture-setup wrapper.
 */
export function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args.map(String), {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null || error === undefined,
        code: error?.code ?? 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error,
      });
    });
  });
}

/** Run one git command and throw with git's own message when it fails. */
export async function gitOrThrow(cwd, args) {
  const result = await git(cwd, args);
  if (!result.ok) {
    throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + (result.stderr.trim() || result.error?.message));
  }
  return result.stdout.trim();
}

/** Create a real repository at `<root>/<name>` with `commits` commits on `branch`. */
export async function initRepo(root, { name = 'repo', branch = 'main', commits = 1 } = {}) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  await gitOrThrow(repo, ['init', '-q', '-b', branch]);
  await gitOrThrow(repo, ['config', 'user.name', 'dsh-test']);
  await gitOrThrow(repo, ['config', 'user.email', 'dsh-test@example.invalid']);
  for (let index = 0; index < commits; index += 1) {
    await commitFile(repo, 'file-' + index + '.txt', 'content ' + index + '\n', 'commit ' + index);
  }
  return repo;
}

/** Write a file, stage it, and commit it in a fixture repository. */
export async function commitFile(repo, path, content, message) {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  await gitOrThrow(repo, ['add', '--', path]);
  await gitOrThrow(repo, ['commit', '-q', '-m', message]);
}

/**
 * A worktree created by raw git rather than by this bundle: no ownership marker,
 * no session record. Used for the "foreign worktree" and "prunable" cases.
 */
export async function addForeignWorktree(repo, path, branch, { base = 'main', detach = false } = {}) {
  if (detach) {
    await gitOrThrow(repo, ['worktree', 'add', '-q', '--detach', path, base]);
  } else {
    await gitOrThrow(repo, ['worktree', 'add', '-q', path, '-b', branch, base]);
  }
  return path;
}

/** The commit a ref points at, realpath'd through git. */
export async function revParse(repo, ref = 'HEAD') {
  return gitOrThrow(repo, ['rev-parse', ref]);
}

/** Whether a local branch exists. */
export async function branchExists(repo, branch) {
  const result = await git(repo, ['rev-parse', '-q', '--verify', 'refs/heads/' + branch]);
  return result.ok && result.stdout.trim() !== '';
}

/** Whether a path exists on disk. */
export function pathExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A path as JSON, or undefined when it does not exist / does not parse. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The marker file this bundle writes beside a worktree. */
export function markerFor(worktreePath) {
  return join(dirname(worktreePath), worktreePath.split(/[\\/]/u).pop() + '.owned.json');
}

/**
 * A plain Cordis context, in the shape this bundle uses: `effect`, `tools.register`,
 * `on`, `get('sessions')` and `logger`. Nothing here is a live Harness.
 */
export function makeCtx({ cwd, effects = [], tools = new Map(), handlers = new Map(), logs = [] } = {}) {
  const ctx = {
    effect(fn, label) {
      effects.push(label);
      return fn();
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    get(name) {
      if (name !== 'sessions') return undefined;
      return { get: () => ({ header: { cwd } }) };
    },
    logger: {
      info(message) {
        logs.push('info: ' + String(message));
      },
    },
  };
  return { ctx, tools, handlers, effects, logs, cwd };
}

/**
 * Mount the real plugin (`index.js` `apply`) on a plain context and hand back
 * the registered worktree tool and the registered `tools/pre-execute` handler.
 * A second call mounts another row over the same context, which is how the
 * "config changed" cases are built.
 */
export function mountPlugin({ cwd, config = {} } = {}) {
  const harness = makeCtx({ cwd });
  plugin.apply(harness.ctx, config);
  return {
    ...harness,
    plugin,
    cwd,
    tool: harness.tools.get('worktree'),
    preExecute: harness.handlers.get('tools/pre-execute'),
  };
}

/** The exec object the tool's `execute` receives, as this bundle reads it. */
export function toolExec(sessionId, extra = {}) {
  return { agent: { id: sessionId }, ...extra };
}

/** The exec object a `tools/pre-execute` listener receives, as the guard reads it. */
export function editExec(name, args, sessionId) {
  return { name, arguments: args, agent: { id: sessionId } };
}

/** A per-file, unique session id. */
export function sessionId(suffix) {
  return 'session-' + suffix;
}
