import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Return the environment used by desktop-targeted frontend commands.
 *
 * Keep this helper pure so the web/desktop build boundary can be verified
 * without spawning Vite or mutating the agent's process environment.
 *
 * @param {NodeJS.ProcessEnv} environment
 * @returns {NodeJS.ProcessEnv}
 */
export function desktopEnvironment(environment) {
  return {
    ...environment,
    CHATTO_FRONTEND_TARGET: 'desktop',
    VITE_CHATTO_DESKTOP: '1'
  };
}

/**
 * Return the single-page fallback expected by the selected shell.
 *
 * Tauri boots `index.html` directly from its asset protocol. The web image is
 * served by nginx, which intentionally keeps using `200.html` as its fallback.
 *
 * @param {string | undefined} target
 * @returns {'index.html' | '200.html'}
 */
export function frontendFallback(target) {
  return target === 'desktop' ? 'index.html' : '200.html';
}

/**
 * Run a pnpm command with the desktop build target selected.
 *
 * @param {string[]} args
 * @returns {number}
 */
export function runDesktopCommand(args) {
  if (args.length === 0) {
    throw new Error('A pnpm command is required.');
  }

  const result = spawnSync('pnpm', args, {
    env: desktopEnvironment(process.env),
    shell: process.platform === 'win32',
    stdio: 'inherit'
  });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = runDesktopCommand(process.argv.slice(2));
}
