import { describe, expect, it } from 'vitest';
import { windowsLoginTarget } from '../src/main/login-item';

describe('Windows startup target survives manual Squirrel upgrades', () => {
  const root = 'C:\\Users\\A User\\AppData\\Local\\archie_jumi';
  const launcher = `${root}\\archie-jumi.exe`;
  const exists = (file: string) => file === launcher;

  it('uses the stable root launcher for a Squirrel installation, preserving spaces and startup arguments', () => {
    expect(windowsLoginTarget(`${root}\\app-1.0.0\\archie-jumi.exe`, exists))
      .toEqual({ path: launcher, args: ['--start-hidden-panel'] });
  });

  it('keeps the same startup command after the version directory changes', () => {
    const first = windowsLoginTarget(`${root}\\app-1.0.0\\archie-jumi.exe`, exists);
    const upgraded = windowsLoginTarget(`${root}\\app-1.1.0\\archie-jumi.exe`, exists);
    expect(upgraded).toEqual(first);
  });

  it('supports prerelease version directories', () => {
    expect(windowsLoginTarget(`${root}\\app-1.2.0-beta.1\\archie-jumi.exe`, exists).path).toBe(launcher);
  });

  it('falls back to the packaged executable when the stable launcher is absent', () => {
    const executable = `${root}\\app-1.0.0\\archie-jumi.exe`;
    expect(windowsLoginTarget(executable, () => false).path).toBe(executable);
  });

  it('does not select an unrelated parent executable for a portable package', () => {
    const executable = 'D:\\Apps\\Archie and Jumi\\archie-jumi.exe';
    expect(windowsLoginTarget(executable, () => true)).toEqual({ path: executable, args: ['--start-hidden-panel'] });
  });
});
