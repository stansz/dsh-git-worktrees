/**
 * Configuration for dsh-git-worktrees.
 *
 * This bundle owns the worktree settings, so it resolves them itself and imports
 * nothing from dsh-git. There is deliberately no schema library here:
 * '@deepseek-ai/schemastery' is not a dependency of this package, and under a
 * 'link:' install a bundle's dependencies are not hoisted anyway, so a static
 * import would take the plugin down at activation. 'resolveConfig' therefore
 * takes the raw row config as the profile's patch layer supplies it, fills every
 * default, and validates the one enum — a malformed value falls back to its
 * default rather than leaving the bundle half-configured.
 *
 * Every default is chosen so the bundle does something useful with no
 * configuration at all: 'autoWorktree' is 'protected' and 'protectedBranches' is
 * ['main', 'master'], so a file edit that would land on main in the checkout is
 * refused and pointed at the 'worktree' tool. A rule that has to be switched on
 * is a rule that silently does nothing, which is the failure this bundle exists
 * to end.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** The values 'autoWorktree' accepts. */
export const AUTO_WORKTREE_MODES = ['off', 'protected', 'always'];

/**
 * Every setting, at the value that makes the bundle's guarantee true.
 *
 * 'worktreeRoot' is null — meaning '<cwd>/.worktrees' — rather than derived
 * here: a worktree is where edits have to happen, a Harness file sandbox writes
 * only inside the session workspace, and the workspace is known at the call
 * site, not at import. 'stateRoot' is null as well, which leaves the core's own
 * default in place ('$DSH_HOME/state', else '~/.dsh/state').
 */
export const DEFAULT_CONFIG = {
  worktreeRoot: null,
  autoWorktree: 'protected',
  worktrees: true,
  protectedBranches: ['main', 'master'],
  branchPrefix: 'dsh/',
  stateRoot: null,
};

const ENUMS = {
  autoWorktree: AUTO_WORKTREE_MODES,
};

/**
 * A raw row config as a resolved config.
 *
 * Unknown keys are dropped and a malformed value falls back to its default, so
 * a hand-edited patch cannot leave the bundle half-configured.
 *
 * @param {object} [raw] - the row config, exactly as the patch layer supplied it.
 * @returns {{worktreeRoot: string|null, autoWorktree: string, worktrees: boolean,
 *   protectedBranches: string[], branchPrefix: string, stateRoot: string|null}}
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const config = {
    ...DEFAULT_CONFIG,
    protectedBranches: [...DEFAULT_CONFIG.protectedBranches],
  };

  // The named enum is read first so a typo counts as absent rather than as a
  // choice: 'worktrees: false' beside 'autoWorktree: protcted' still turns
  // enforcement off, instead of leaving the default on and the two keys in
  // disagreement.
  const namedAutoWorktree = oneOf('autoWorktree', input.autoWorktree);

  // The shorthand, applied before the named keys below so a key beside it still
  // wins: 'worktrees: true' with 'autoWorktree: always' means what it says, and
  // 'worktrees: false' with an explicit 'protectedBranches' list keeps that list.
  if (typeof input.worktrees === 'boolean') {
    if (namedAutoWorktree === undefined) config.autoWorktree = input.worktrees ? 'protected' : 'off';
    if (input.protectedBranches === undefined) {
      config.protectedBranches = input.worktrees ? [...DEFAULT_CONFIG.protectedBranches] : [];
    }
  }
  if (namedAutoWorktree !== undefined) config.autoWorktree = namedAutoWorktree;

  // Derived last, so it always agrees with the mode it stands for: enforcement is
  // on unless 'autoWorktree' is 'off'.
  config.worktrees = config.autoWorktree !== 'off';

  const protectedBranches = protectedBranchesFrom(input.protectedBranches);
  if (protectedBranches !== undefined) config.protectedBranches = protectedBranches;

  const branchPrefix = text(input.branchPrefix);
  if (branchPrefix !== undefined) config.branchPrefix = branchPrefix;

  // A relative 'worktreeRoot' is left relative on purpose: 'worktreeRootFor'
  // resolves it against the session's own cwd. Resolving it here, against the
  // Harness home, is what once put every worktree outside the one directory the
  // file sandbox permits writes in.
  const worktreeRoot = text(input.worktreeRoot);
  config.worktreeRoot = worktreeRoot === undefined ? null : expandHome(worktreeRoot);

  const stateRoot = text(input.stateRoot);
  config.stateRoot = stateRoot === undefined ? null : expandHome(stateRoot);

  return config;
}

/**
 * Whether a branch is one an edit must not land on.
 *
 * A missing or blank branch name answers true: every caller of this function is
 * deciding whether to refuse something, and 'unknown' must not read as 'safe'.
 * A non-empty list is required for a true answer, so a config with
 * 'protectedBranches: []' protects nothing — which is a coherent request, not a
 * mistake.
 *
 * @param {object} config - a resolved config.
 * @param {string} name - the checked-out branch name.
 * @returns {boolean}
 */
export function isProtectedBranch(config, name) {
  const branch = text(name);
  if (branch === undefined) return true;
  const list = Array.isArray(config?.protectedBranches) ? config.protectedBranches : DEFAULT_CONFIG.protectedBranches;
  return list.includes(branch);
}

/**
 * Where worktrees live for one session.
 *
 * An unset 'worktreeRoot' resolves to '<cwd>/.worktrees': inside the session
 * workspace, where a file sandbox permits writes, and outside every repository,
 * so there is nothing to add to .gitignore and no second copy of the tree for
 * editors and search tools to index twice.
 *
 * @param {object} config - a resolved config; 'worktreeRoot' may be null.
 * @param {string} [cwd] - the session's working directory.
 * @returns {string} an absolute path. Nothing is created here.
 */
export function worktreeRootFor(config, cwd) {
  const base = text(cwd) ?? process.cwd();
  const configured = text(config?.worktreeRoot);
  if (configured === undefined) return join(base, '.worktrees');
  const expanded = expandHome(configured);
  return isAbsolute(expanded) ? expanded : join(base, expanded);
}

/** Expand a leading '~', and resolve nothing else: a relative path stays relative. */
function expandHome(value) {
  const raw = String(value);
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

/** A trimmed non-empty string, or undefined. */
function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** One of the allowed enum values, or undefined. */
function oneOf(key, value) {
  return ENUMS[key].includes(value) ? value : undefined;
}

/**
 * The protected-branch list, where an explicitly empty array means what it says.
 *
 * An array that is empty stays empty; one whose entries are all blank is treated
 * as a mistake and falls back to the default.
 */
function protectedBranchesFrom(value) {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const kept = value.map((entry) => text(entry)).filter((entry) => entry !== undefined);
  return kept.length > 0 ? kept : undefined;
}
