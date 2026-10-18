import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAdapter, Bootstrap, CursorFeedMessage, Lifecycle, PetCommand } from '../shared/types';
const listen = <T>(channel: string, callback: (value: T) => void) => {
  const handler = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const bridge: DesktopAdapter = {
  cursorFeed: true,
  getBootstrap: () => ipcRenderer.invoke('bootstrap'),
  savePreferences: (patch) => ipcRenderer.invoke('preferences', patch),
  sendCommand: (command) => ipcRenderer.send('command', command),
  setInputMode: (payload) => ipcRenderer.send('input-mode', payload),
  ready: (generation) => ipcRenderer.send('scene-ready', generation),
  heartbeat: (payload) => ipcRenderer.send('heartbeat', payload),
  setInterest: (payload) => ipcRenderer.send('interest', payload),
  reportScene: (payload) => ipcRenderer.send('scene-state', payload),
  savePositions: (positions) => ipcRenderer.send('positions', positions),
  showPetMenu: (petId) => ipcRenderer.send('pet-menu', petId),
  action: (action) => ipcRenderer.send('app-action', action),
  copyDiagnostics: () => ipcRenderer.invoke('diagnostics'),
  onBootstrap: (callback) => listen<Bootstrap>('bootstrap-update', callback),
  onCommand: (callback) => listen<PetCommand>('pet-command', callback),
  onLifecycle: (callback) => listen<Lifecycle>('lifecycle', callback),
  onCursor: (callback) => listen<CursorFeedMessage>('cursor', callback)
};
contextBridge.exposeInMainWorld('desktop', bridge);
