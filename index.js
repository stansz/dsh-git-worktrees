/**
 * dsh-git-worktrees — the worktree subsystem, as a bundle of its own.
 *
 * This is the part of dsh-git that decides WHERE work lands, split out so the
 * worktree machinery can be installed, versioned and unloaded on its own. It
 * contributes two things:
 *
 *   ctx.tools.register()          the 'worktree' tool: start (create the task
 *                                 worktree and return its path), list, remove
 *   ctx.on('tools/pre-execute')   worktree enforcement: a file edit that would
 *                                 land on a protected branch, in a repository
 *                                 this session has no worktree for, is refused
 *                                 and pointed at action "start"
 *
 * Both are registered through ctx.effect, so unloading the row removes the tool
 * and the guard together. A half-unloaded plugin would keep refusing edits with
 * no way to create the worktree it demands, which is worse than either state.
 *
 * Nothing here imports dsh-git: this bundle has its own settings resolver
 * (lib/config.mjs) and talks to the shared operations layer through
 * dsh-git-core, re-exported by the lib/git.mjs, lib/state.mjs and
 * lib/merge-proof.mjs shims.
 */

import { createWorktreeTool } from './lib/tool.mjs';
import { resolveConfig } from './lib/config.mjs';
import { registerWorktreeGuard } from './lib/worktree-guard.mjs';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'git-worktrees';

/** The services this plugin contributes to. */
export const inject = ['tools'];

/**
 * Register everything this bundle contributes.
 *
 * @param {object} ctx - the Cordis context of this row.
 * @param {object} config - the raw row config, resolved per call so a value
 *   changed in the profile's patch layer is picked up without a reload.
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register(createWorktreeTool(ctx, config)), 'worktree tool registration');

  // The guard resolves its config per tool call rather than capturing it at
  // mount, for the same reason the tool does: the row config is volatile.
  ctx.effect(
    () =>
      registerWorktreeGuard(ctx, config, {
        cwdOf: (agent) => sessionCwd(ctx, agent),
        resolveConfig,
      }),
    'worktree guard registration',
  );
}

/**
 * The working directory of one agent's session, else the process directory.
 *
 * 'sessions' is not injected — this bundle registers a tool and a guard, and a
 * session service that is absent must not stop it mounting — so the lookup is
 * defensive and the fallback is the process directory.
 */
function sessionCwd(ctx, agent) {
  try {
    const session = ctx.get?.('sessions')?.get?.(agent?.id);
    const cwd = session?.header?.cwd ?? session?.cwd ?? session?.meta?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    /* fall through to the process directory */
  }
  return process.cwd();
}
