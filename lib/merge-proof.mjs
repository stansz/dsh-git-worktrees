/**
 * Re-export of the shared core, so this bundle has one implementation of it.
 *
 * The code lives in `dsh-git-core`; this file exists so every caller keeps
 * importing `./merge-proof.mjs` and there is exactly one copy of the logic. See
 * `core-loader.mjs` for how it is found.
 */
import { loadCore } from './core-loader.mjs';

const core = await loadCore('merge-proof.mjs');

export const { isCommitId, normalizePull, normalizePulls, proveMergedPull, describeProof } = core;
export default core;
