import type { Preferences, SavedState } from './types';
export function defaultPreferences(): Preferences {
  return { sound: false, volume: 0.3, reducedMotion: false, quiet: false, launchAtLogin: false, shortcut: 'Control+Alt+Shift+P', selectedDisplay: null, curious: true,
    pets: {
      archie: { name: 'Archie', visible: true, size: 128, personality: { playfulness: 0.4, sociability: 0.65, energy: 0.35 }, position: { x: 0.35, y: 0.72 } },
      jumi: { name: 'Jumi', visible: true, size: 128, personality: { playfulness: 0.8, sociability: 0.65, energy: 0.7 }, position: { x: 0.65, y: 0.72 } }
    }
  };
}
export function defaultState(): SavedState { return { schemaVersion: 1, preferences: defaultPreferences() }; }
