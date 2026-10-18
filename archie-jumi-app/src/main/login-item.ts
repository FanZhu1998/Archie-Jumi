import { existsSync } from 'node:fs';
import { win32 as path } from 'node:path';

export interface LoginTarget { path: string; args: string[] }

/** Squirrel's stable root launcher selects the latest installed app version. */
export function windowsLoginTarget(executablePath: string, exists: (file: string) => boolean = existsSync): LoginTarget {
  const folder = path.dirname(executablePath);
  const stableLauncher = path.resolve(folder, '..', path.basename(executablePath));
  const squirrelInstall = /^app-\d/i.test(path.basename(folder));
  return {
    path: squirrelInstall && exists(stableLauncher) ? stableLauncher : executablePath,
    args: ['--start-hidden-panel'],
  };
}
