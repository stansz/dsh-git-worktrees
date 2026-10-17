/**
 * The 'worktree' tool: the model-facing half of this bundle.
 *
 * One tool with three actions rather than three tools. A catalog entry costs a
 * schema in every request, the three share almost all of theirs — repository,
 * base, slug, task are the same arguments wherever they apply — and an agent
 * looking for "how do I isolate this task" finds start, list and remove
 * together instead of guessing which of three near-identical names to open.
 *
 * Two properties of the definition are load-bearing:
 *
 *   - 'isConcurrencySafe' is false. Two agents must never mutate one repository
 *     or one worktree at the same time, and the scheduler is the only place that
 *     can be enforced. 'list' is the one read-only case where the cost is real,
 *     and it is worth paying: a listing that races a create reports a state that
 *     never existed.
 *
 *   - The output schema is permissive on purpose. A strict schema that rejects a
 *     real result turns a working operation into a failure the model cannot read,
 *     which is how a session ends up back in raw git.
 *
 * Every action returns the tool's result envelope and never throws. A tool that
 * throws gives the model a stack trace instead of a next step.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve as resolvePath } from 'node:path';

import * as git from './git.mjs';
import * as state from './state.mjs';
import * as worktrees from './worktrees.mjs';
import { resolveConfig, worktreeRootFor } from './config.mjs';

/** The actions the tool exposes, in the order the description introduces them. */
export const ACTION_NAMES = ['start', 'list', 'remove'];

/** What each action is for, used in the description and the parameter enum. */
export const ACTION_SUMMARY = {
  start: 'create the worktree for one task and return its path, so every later edit of the task lands there. The branch is <branchPrefix><slug>, cut from origin/<base> when that ref exists. Calling it again with the same slug returns the worktree this session already owns instead of making a second one.',
  list: 'list the worktrees of a repository: path, branch, whether it is the main checkout, and whether this bundle created it. Reads only.',
  remove: 'remove one worktree. A dry run unless apply is true: nothing is deleted and the answer says what would happen. The main checkout is never removed; a worktree this bundle did not create is refused unless force is true; one holding uncommitted changes is refused with its paths named unless force is true.',
};

const DESCRIPTION = [
  'Work in an isolated git worktree per task, so two agents never edit one checkout.',
  '',
  'A linked worktree has its own HEAD and its own index over shared history. Action "start" creates one for a task and returns its path - edit the task there, not in the main checkout. Action "list" shows what exists. Action "remove" clears one away, dry run first. This tool is about where work happens: committing, pushing and pull requests are not its business.',
  '',
  ...ACTION_NAMES.map((name) => '- ' + name + ': ' + ACTION_SUMMARY[name]),
].join('\n');

/**
 * The outcome shapes, as one permissive object.
 *
 * Every field is optional and additional properties are allowed: the value here
 * is documentation for the model and a floor under the renderer, not a contract
 * that can turn a real result into an error.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    action: { type: 'string', description: 'Which action produced this result.' },
    ok: { type: 'boolean', description: 'False when nothing was done; the error field says why.' },
    error: {
      type: 'object',
      additionalProperties: true,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        hint: { type: 'string', description: 'The next thing to try.' },
      },
    },
    path: { type: 'string', description: 'The repository this result is about - its main working tree.' },
    worktree: { type: 'string', description: 'The worktree path to work in, from action "start".' },
    branch: { type: 'string', description: 'The branch checked out in that worktree.' },
    slug: { type: 'string' },
    base: { type: 'string', description: 'The ref the task branch was cut from.' },
    task: { type: 'string' },
    reused: { type: 'boolean', description: 'True when an existing worktree was returned rather than created.' },
    recorded: { type: 'boolean', description: 'False when the session record could not be written, so this session does not own the worktree it just created.' },
    dryRun: { type: 'boolean', description: 'True when nothing was changed. Action "remove" is a dry run unless apply is true.' },
    applied: { type: 'boolean', description: 'True when the requested change was made.' },
    removed: { type: 'boolean' },
    owned: { type: 'boolean', description: 'True when this bundle created the worktree (an ownership marker sits beside it, or this session recorded it).' },
    dirty: { type: 'array', items: { type: 'string' }, description: 'The worktree paths with uncommitted changes.' },
    dirtyCount: { type: 'integer' },
    forgotten: { type: 'boolean', description: 'False when the session record could not be dropped after a removal.' },
    count: { type: 'integer' },
    message: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
    worktrees: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: 'One entry per registered worktree: path, branch, head, detached, locked, prunable, main, owned.',
    },
  },
};

/** The tool parameters, shared by the definition and the description. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ACTION_NAMES,
      description: ACTION_NAMES.map((name) => name + ': ' + ACTION_SUMMARY[name]).join('\n'),
    },
    repo: {
      type: 'string',
      description: 'The repository, or any directory inside it - or a linked worktree itself, which is the path action "start" returns. Absolute, or relative to the session working directory. Omit for the working directory.',
    },
    base: {
      type: 'string',
      description: 'With start, the branch to cut the task branch from. Its origin/<base> is used when that ref exists, so the branch starts from what the team published rather than from whatever this checkout happens to have. Defaults to the repository default branch.',
    },
    slug: {
      type: 'string',
      description: 'A short task name, lowercased and folded into a safe form. It becomes both the branch name <branchPrefix><slug> and the worktree directory name. Defaults to "task". With remove it names the task to remove.',
    },
    task: {
      type: 'string',
      description: 'With start, the task text recorded beside the worktree. Defaults to the slug. With remove, an alternative to slug.',
    },
    apply: {
      type: 'boolean',
      description: 'With remove, actually remove it. Without it the call is a dry run: nothing is deleted, and the answer says what would happen.',
    },
    force: {
      type: 'boolean',
      description: 'With remove, override both refusals: remove a worktree this bundle did not create, and one that still holds uncommitted changes. The dirty paths are reported either way.',
    },
  },
  required: ['action'],
};

/** Deadline for one git call this tool makes. */
const GIT_TIMEOUT_MS = 30000;

/** A successful result, with every undefined field left out. */
function ok(action, fields) {
  return stripUndefined({ action, ok: true, ...fields });
}

/** A failed result, in the shape the renderer and the output schema both expect. */
function fail(action, code, message, hint, extra) {
  return stripUndefined({ action, ok: false, error: { code, message, hint }, ...extra });
}

/** A value with every undefined-valued key removed, recursively. */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map((entry) => stripUndefined(entry));
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = stripUndefined(entry);
  }
  return out;
}

/** Text, or undefined when there is nothing meaningful. */
function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The session's working directory, else the process directory. */
export function sessionDirectory(ctx, exec) {
  try {
    const sessions = ctx.get?.('sessions');
    const agent = exec?.agent;
    const session = sessions?.get?.(agent?.id);
    const cwd = session?.header?.cwd ?? session?.cwd ?? session?.meta?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    /* fall through to the process directory */
  }
  return process.cwd();
}

/** The repository a call is about: an explicit argument, else the reference directory. */
async function locateRepo(args, reference, action) {
  const explicit = text(args?.repo);
  const dir = explicit === undefined
    ? reference
    : (isAbsolute(explicit) ? explicit : resolvePath(reference, explicit));
  if (!existsSync(dir)) {
    return { error: fail(action, 'repo-missing', 'No such path: ' + dir, 'Pass repo pointing at the repository, or create one first.') };
  }
  const repoDir = await git.toplevel(dir);
  if (repoDir === undefined) {
    return { error: fail(action, 'not-a-repo', dir + ' is not inside a git repository', 'Pass repo pointing at the repository you mean.') };
  }
  return { repoDir };
}

/**
 * The main repository root that owns a working directory.
 *
 * 'git worktree list' reports the main working tree first, always, so its first
 * entry is the identity the session registry is keyed by. Inside a linked
 * worktree the toplevel is the worktree itself, so the toplevel is only the
 * fallback for a repository git cannot list.
 */
async function mainRepoRootOf(workingDir) {
  const trees = (await git.listWorktrees(workingDir)) ?? [];
  const first = trees[0];
  if (first !== undefined && typeof first.path === 'string' && first.path !== '') return first.path;
  return workingDir;
}

/** The worktrees this session recorded for one repository. */
function sessionWorktrees(sessionId, config, mainRoot) {
  const session = state.readSession(sessionId, { stateRoot: config.stateRoot });
  return session.worktrees.filter(
    (entry) => typeof entry?.path === 'string' && entry.path !== '' && sameFsPath(entry.repoRoot, mainRoot),
  );
}

/**
 * 'start' - a worktree for one task, or the one this session already has.
 *
 * Reuse is deliberate and is what makes the action safe to call on every task: a
 * second call for the same session, repository and slug returns the worktree it
 * already owns rather than creating a second one and splitting the work.
 */
export async function start(args, context) {
  const { config, sessionId, reference, signal } = context;
  const located = await locateRepo(args, reference, 'start');
  if (located.error !== undefined) return located.error;

  // The main repository root is what the session registry is keyed by. Creating
  // the worktree is the one operation that must run against a repository whose
  // identity is not the path the caller happens to be standing in.
  const mainRoot = await mainRepoRootOf(located.repoDir);

  const requested = text(args?.slug) ?? text(args?.task) ?? 'task';
  const existing = sessionWorktrees(sessionId, config, mainRoot).find((entry) => entry.slug === requested);
  if (existing !== undefined && existsSync(existing.path)) {
    return ok('start', {
      path: mainRoot,
      worktree: existing.path,
      branch: existing.branch,
      slug: existing.slug,
      reused: true,
    });
  }

  const created = await worktrees.createWorktree(mainRoot, {
    worktreeRoot: worktreeRootFor(config, reference),
    branchPrefix: config.branchPrefix,
    slug: requested,
    baseBranch: text(args?.base),
    task: text(args?.task) ?? requested,
    signal,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (created.ok !== true) {
    return fail('start', created.code ?? 'worktree-failed', created.error ?? 'Could not create a worktree', created.hint);
  }

  // Registered by PATH, not by slug and not by a bare repository match: a
  // session legitimately works on more than one task in a repository, and the
  // core's store treats a worktree at the same path as an update rather than a
  // second entry. The worktree is real and usable whether or not this record
  // lands — but it is not silent either: without the record this session does not
  // own the worktree it just made.
  const recorded = state.addWorktree(sessionId, {
    repo: basename(mainRoot),
    repoRoot: mainRoot,
    path: created.path,
    branch: created.branch,
    slug: created.slug,
    createdAt: new Date().toISOString(),
  }, { stateRoot: config.stateRoot });

  return ok('start', {
    path: mainRoot,
    worktree: created.path,
    branch: created.branch,
    slug: created.slug,
    base: created.base,
    task: text(args?.task) ?? requested,
    reused: created.reused === true,
    recorded,
    ...(recorded === true
      ? {}
      : {
        notes: [
          'the worktree was created, but its session record could not be written, so this session does not own it: it will not be reported as yours and will not be reused by a later "start".',
          'make the state root writable and call action "start" with the same slug again: the existing worktree is re-adopted and the record written.',
        ],
      }),
  });
}

/** 'list' - every worktree of a repository, with its branch and its owner. */
export async function list(args, context) {
  const { signal } = context;
  const located = await locateRepo(args, context.reference, 'list');
  if (located.error !== undefined) return located.error;
  const mainRoot = await mainRepoRootOf(located.repoDir);

  const listed = await git.run(mainRoot, ['worktree', 'list', '--porcelain'], { signal, timeoutMs: GIT_TIMEOUT_MS });
  if (!listed.ok) {
    return fail('list', 'worktree-list-failed', listed.error ?? 'git worktree list failed for ' + mainRoot, 'Check that the repository is intact, then retry.');
  }
  const trees = git.parseWorktrees(listed.stdout);
  const rows = trees.map((tree, index) => ({
    path: tree.path,
    branch: tree.branch,
    head: tree.head,
    detached: tree.detached,
    locked: tree.locked,
    prunable: tree.prunable,
    main: index === 0,
    // Ownership is asked of the marker beside the worktree, never derived from a
    // path and a slug: that derivation is how every worktree this bundle created
    // was once reported as somebody else's.
    owned: worktrees.isOwnedWorktreePath(tree.path),
  }));

  return ok('list', { path: mainRoot, count: rows.length, worktrees: rows });
}

/** 'remove' - dry run first, and never the main checkout. */
export async function remove(args, context) {
  const { config, sessionId, reference, signal } = context;
  const located = await locateRepo(args, reference, 'remove');
  if (located.error !== undefined) return located.error;
  const mainRoot = await mainRepoRootOf(located.repoDir);

  const trees = await git.listWorktrees(mainRoot);
  if (trees === undefined) {
    return fail('remove', 'worktree-list-failed', 'the worktree registrations of ' + mainRoot + ' could not be read, so nothing was removed', 'Retry; if it persists, run git worktree list in the repository.');
  }

  // A 'repo' that points into a linked worktree names that worktree. The main
  // checkout does not: 'findWorktreeForBranch' reports it as main, and a remove
  // addressed at the repository itself is about a task worktree, not the
  // repository.
  const here = worktrees.findWorktreeForBranch(trees, located.repoDir);
  const named = here.worktree !== undefined && here.isMain !== true ? here.worktree : undefined;
  const slug = text(args?.slug) ?? text(args?.task);

  const chosen = chooseTarget({ config, sessionId, reference, mainRoot, trees, slug, named, isMainPath: here.isMain === true });
  if (chosen.error !== undefined) return chosen.error;
  const path = chosen.path;

  const main = trees[0];
  if ((main !== undefined && sameFsPath(main.path, path)) || sameFsPath(path, mainRoot)) {
    return fail('remove', 'main-checkout', 'refusing to remove the main working tree ' + path, 'A worktree is a task checkout beside the repository; the main checkout is never removed.');
  }
  const entry = trees.find((tree) => sameFsPath(tree.path, path));
  if (entry === undefined) {
    return fail('remove', 'not-a-worktree', path + ' is not a registered worktree of ' + mainRoot, 'Run action "list" to see the worktrees this repository has.');
  }

  // Ownership, before anything is unlocked or removed. Either half is proof this
  // bundle created it: the marker beside the worktree, or this session's own
  // record of having created it.
  const markerOwned = worktrees.isOwnedWorktreePath(path);
  const sessionOwned = sessionWorktrees(sessionId, config, mainRoot).some((record) => sameFsPath(record.path, path));
  const owned = markerOwned || sessionOwned;
  const force = args?.force === true;
  const dryRun = args?.apply !== true;

  const dirty = existsSync(path) ? await git.changedPaths(path, { signal, timeoutMs: GIT_TIMEOUT_MS }) : [];
  const common = { dryRun, applied: false, worktree: path, branch: entry.branch, owned, dirty, dirtyCount: dirty.length };

  if (!owned && !force) {
    return fail(
      'remove',
      'not-owned',
      'refusing to remove ' + path + ': this bundle did not create it (no ownership marker beside it, and this session has no record of it)',
      'Run action "list" to see which worktrees are yours. Pass force: true to remove it anyway.',
      common,
    );
  }
  if (dirty.length > 0 && !force) {
    return fail(
      'remove',
      'dirty',
      'the worktree at ' + path + ' has ' + dirty.length + ' uncommitted change(s), so nothing was removed',
      'Commit, stash or discard them first - this tool never forces removal on its own. Pass force: true to remove it and lose them.',
      { ...common, paths: dirty },
    );
  }
  if (dryRun) {
    return ok('remove', { ...common, message: 'dry run: nothing was removed. Pass apply: true to remove this worktree.' });
  }

  // The ownership decision above is handed on explicitly: the core refuses a
  // worktree with no marker beside it unless the caller says its own record
  // already proved ownership, which is exactly what happened here.
  const removed = await worktrees.removeWorktree(mainRoot, path, {
    allowForeign: owned || force,
    force,
    signal,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (removed.ok !== true) {
    const extra = Array.isArray(removed.dirty) && removed.dirty.length > 0
      ? { ...common, dirty: removed.dirty, dirtyCount: removed.dirty.length, paths: removed.dirty }
      : common;
    return fail('remove', removed.code ?? 'remove-failed', removed.error ?? 'Could not remove ' + path, removed.hint, extra);
  }

  const forgotten = state.removeWorktree(sessionId, mainRoot, { path, stateRoot: config.stateRoot });
  return ok('remove', {
    dryRun: false,
    applied: true,
    removed: true,
    worktree: path,
    branch: entry.branch,
    owned,
    forgotten,
    ...(forgotten === true
      ? {}
      : {
        notes: [
          'the worktree was removed, but its session record could not be dropped; the directory is gone, so the stale record is harmless.',
        ],
      }),
  });
}

/**
 * Which worktree a 'remove' is about.
 *
 * The rules, in order:
 *   1. a slug names the task: this session's record for it, else a worktree
 *      registered at the path this bundle would create for it, else the worktree
 *      'repo' points at when its branch is the one that slug names;
 *   2. otherwise a 'repo' pointing into a linked worktree names that worktree;
 *   3. otherwise, exactly one worktree this session owns for the repository is
 *      unambiguous, and more than one is not.
 *
 * With none of those, a 'repo' that is the main checkout is refused outright:
 * it is the repository, not a task worktree, and the answer says so instead of
 * reporting that nothing was found.
 */
function chooseTarget({ config, sessionId, reference, mainRoot, trees, slug, named, isMainPath }) {
  const records = sessionWorktrees(sessionId, config, mainRoot);

  if (slug !== undefined) {
    const recorded = records.find((entry) => entry.slug === slug);
    if (recorded !== undefined) return { path: recorded.path };

    const expected = worktrees.worktreePathFor(worktreeRootFor(config, reference), basename(mainRoot), slug);
    const at = trees.find((tree) => sameFsPath(tree.path, expected));
    if (at !== undefined) return { path: at.path };

    if (named !== undefined) {
      const wanted = worktrees.branchNameFor(config.branchPrefix, slug);
      if (named.branch === wanted) return { path: named.path };
      return {
        error: fail(
          'remove',
          'slug-mismatch',
          'the worktree at ' + named.path + ' is on branch ' + (named.branch ?? '(detached HEAD)') + ', not ' + wanted,
          'Omit slug to remove the worktree repo points at, or pass the slug of the task you mean.',
        ),
      };
    }
    return {
      error: fail(
        'remove',
        'nothing-to-remove',
        'no worktree of ' + mainRoot + ' is registered for slug "' + slug + '"',
        'Run action "list" to see the worktrees this repository has.',
      ),
    };
  }

  if (named !== undefined) return { path: named.path };
  if (records.length === 1) return { path: records[0].path };
  if (records.length > 1) {
    return {
      error: fail(
        'remove',
        'slug-required',
        mainRoot + ' has ' + records.length + ' worktrees this session owns, so it is not clear which to remove',
        'Pass slug naming the task, or repo pointing at the worktree itself.',
      ),
    };
  }
  if (isMainPath === true) {
    return {
      error: fail(
        'remove',
        'main-checkout',
        'refusing to remove the main working tree ' + mainRoot + ': it is the repository, not a task worktree',
        'Pass slug naming a task worktree, or repo pointing at the worktree action "start" returned.',
      ),
    };
  }
  return {
    error: fail(
      'remove',
      'nothing-to-remove',
      'no worktree of ' + mainRoot + ' was identified',
      'Pass repo pointing at the path action "start" returned, or slug naming the task.',
    ),
  };
}

/** Whether two paths name the same directory, realpath-aware. */
function sameFsPath(left, right) {
  if (typeof left !== 'string' || left === '' || typeof right !== 'string' || right === '') return false;
  const first = realpathOr(resolvePath(left));
  const second = realpathOr(resolvePath(right));
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

/** One worktree row, as a single readable line. */
function treeLine(tree) {
  const notes = [];
  if (tree.branch !== undefined) notes.push('branch ' + tree.branch);
  if (tree.detached === true) notes.push('detached');
  if (tree.main === true) notes.push('main checkout');
  if (tree.owned === true) notes.push('created here');
  if (tree.locked === true) notes.push('locked');
  if (tree.prunable === true) notes.push('prunable');
  return String(tree.path) + (notes.length > 0 ? ' (' + notes.join(', ') + ')' : '');
}

/** A value as one line of text. */
function oneLine(value) {
  if (value === null || typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(oneLine).join(', ');
  return JSON.stringify(value);
}

/** The result envelope as text. */
function renderResult(value) {
  if (value === null || typeof value !== 'object') return String(value);
  const action = typeof value.action === 'string' && value.action !== '' ? value.action : 'worktree';
  const lines = [action + ': ' + (value.ok === true ? 'ok' : 'failed')];
  if (value.dryRun === true) lines.push('  dry run - nothing was changed');
  if (value.ok !== true && value.error !== null && typeof value.error === 'object') {
    for (const key of ['code', 'message', 'hint']) {
      const entry = value.error[key];
      if (typeof entry === 'string' && entry !== '') lines.push('  ' + key + ': ' + entry);
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'action' || key === 'ok' || key === 'error' || key === 'worktrees' || key === 'dryRun') continue;
    if (entry === undefined) continue;
    if (Array.isArray(entry)) {
      if (entry.length === 0) continue;
      lines.push('  ' + key + ': ' + entry.map(oneLine).join(', '));
      continue;
    }
    if (entry !== null && typeof entry === 'object') {
      lines.push('  ' + key + ': ' + oneLine(entry));
      continue;
    }
    lines.push('  ' + key + ': ' + String(entry));
  }
  if (Array.isArray(value.worktrees) && value.worktrees.length > 0) {
    lines.push('  worktrees:');
    for (const tree of value.worktrees) lines.push('    - ' + treeLine(tree));
  }
  return lines.join('\n');
}

/** Build the tool definition, bound to this row's raw config. */
export function createWorktreeTool(ctx, rowConfig) {
  return {
    name: 'worktree',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '');
      const context = {
        config: resolveConfig(rowConfig),
        reference: sessionDirectory(ctx, exec),
        sessionId: String(exec?.agent?.id ?? exec?.agent?.session ?? 'unknown'),
        signal: exec?.signal,
      };
      try {
        if (action === 'start') return await start(args, context);
        if (action === 'list') return await list(args, context);
        if (action === 'remove') return await remove(args, context);
        return fail(
          action === '' ? 'worktree' : action,
          'unknown-action',
          'Unknown action: ' + (action === '' ? '(none given)' : '"' + action + '"'),
          'Use one of: ' + ACTION_NAMES.join(', ') + '.',
        );
      } catch (error) {
        return fail(action === '' ? 'worktree' : action, 'unexpected', 'The worktree action failed: ' + String(error?.message ?? error), 'Retry; if it persists, report the failure.');
      }
    },
    presentCall(args) {
      const action = String(args?.action ?? 'worktree');
      const which = typeof args?.repo === 'string' && args.repo !== '' ? args.repo : undefined;
      return {
        card: 'generic',
        title: 'worktree ' + action + (which !== undefined ? ': ' + which : ''),
        kind: action === 'list' ? 'read' : 'execute',
        rawInput: args,
      };
    },
    // Exclusive on purpose: two agents must never mutate one repository or one
    // worktree at the same time, and this is the only place that can enforce it.
    isConcurrencySafe() {
      return false;
    },
    timeoutMs: 180000,
  };
}
