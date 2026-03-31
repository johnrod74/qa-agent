/**
 * Shared exec utilities — centralises promisified execFile and a typed
 * helper for running `gh` CLI commands with JSON output.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

/** Promisified `child_process.execFile`. */
export const execFile = promisify(execFileCb);

/**
 * Run a `gh` CLI command that returns JSON and parse the result.
 *
 * @param args  - Arguments to pass to `gh` (e.g. `['issue', 'list']`).
 * @param repo  - The `owner/repo` string appended as `--repo`.
 * @returns Parsed JSON of type `T`.
 */
export async function execGh<T>(args: string[], repo: string): Promise<T> {
  const { stdout } = await execFile('gh', [...args, '--repo', repo]);
  return JSON.parse(stdout) as T;
}
