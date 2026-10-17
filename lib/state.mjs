/**
 * Re-export of the shared core, so this bundle has one implementation of it.
 *
 * The code lives in `dsh-git-core`; this file exists so every caller keeps
 * importing `./state.mjs` and there is exactly one copy of the logic. See
 * `core-loader.mjs` for how it is found.
 */
import { loadCore } from './core-loader.mjs';

const core = await loadCore('state.mjs');

export const { safeSessionId, statePath, readSession, writeSession, addWorktree, removeWorktree, forgetVanished, recordPushFailure, shouldRetryPush, clearPushFailure } = core;
export default core;
