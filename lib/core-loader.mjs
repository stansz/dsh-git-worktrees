/**
 * Resolve the shared core, wherever it happens to live.
 *
 * A `link:` install does not hoist a bundle's dependencies, so a bare
 * `import 'dsh-git-core/git.mjs'` cannot resolve: Node walks up from this file's
 * real path in the workspace, never through the profile's node_modules. The same
 * problem this bundle already solves for schemastery, solved the same way — probe
 * the places it can be, and fail with a sentence that says what to install rather
 * than a bare ERR_MODULE_NOT_FOUND at activation.
 *
 * @param {string} name - the core module, e.g. `git.mjs`.
 * @returns {Promise<object>} the loaded module namespace.
 */
export async function loadCore(name) {
  const candidates = [
    new URL('../../dsh-git-core/lib/' + name, import.meta.url),
    process.env.DSH_PROFILE_DIR
      ? new URL('file://' + process.env.DSH_PROFILE_DIR + '/node_modules/dsh-git-core/lib/' + name)
      : undefined,
    new URL('file://' + process.cwd() + '/dsh-git-core/lib/' + name),
    new URL('file://' + process.cwd() + '/node_modules/dsh-git-core/lib/' + name),
  ].filter((entry) => entry !== undefined);
  const failures = [];
  for (const url of candidates) {
    try {
      return await import(url.href);
    } catch (error) {
      failures.push(url.href + ': ' + String(error?.message ?? error));
    }
  }
  throw new Error('dsh-git-core is not installed: could not load ' + name + ' from any of ' + String(candidates.length)
    + ' locations. Install the dsh-git-core bundle beside this one. Tried: ' + failures.join(' | '));
}
