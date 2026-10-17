/**
 * Re-export of the shared core, so this bundle has one implementation of it.
 *
 * The code lives in `dsh-git-core`; this file exists so every caller keeps
 * importing `./git.mjs` and there is exactly one copy of the logic. See
 * `core-loader.mjs` for how it is found.
 */
import { loadCore } from './core-loader.mjs';

const core = await loadCore('git.mjs');

export const { gitAvailable, resolveGit, run, credentialHint, explainCredentialFailure, toplevel, commonDir, isRepo, parseWorktrees, listWorktrees, parseStatus, repoState, computeSync, ancestry, remotes, defaultBranchOf, currentBranch, hasHead, aheadOf, changedPaths, stagePaths, commit, push, fetch, fastForward, mergeBase, remoteUrlFor, revParse, upstreamRef, rebase, rebaseAbort, merge, mergeAbort, conflictedPaths, configList, configGet, configSet, configUnset, remoteList, remoteAdd, remoteSetUrl, remoteRemove, tagList, tagCreate, tagDelete, pushRef } = core;
export default core;
