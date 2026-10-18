import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAdapter, Bootstrap, Lifecycle, PetCommand } from '../shared/types';
const listen = <T>(channel: string, callback: (value: T) => void) => {
  const handler = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const bridge: DesktopAdapter = {
  getBootstrap: () => ipcRenderer.invoke('bootstrap'),
  savePreferences: (patch) => ipcRenderer.invoke('preferences', patch),
  sendCommand: (command) => ipcRenderer.send('command', command),
  setInputMode: (payload) => ipcRenderer.send('input-mode', payload),
  ready: (generation) => ipcRenderer.send('scene-ready', generation),
  heartbeat: (generation) => ipcRenderer.send('heartbeat', generation),
  savePositions: (positions) => ipcRenderer.send('positions', positions),
  showPetMenu: (petId) => ipcRenderer.send('pet-menu', petId),
  action: (action) => ipcRenderer.send('app-action', action),
  onBootstrap: (callback) => listen<Bootstrap>('bootstrap-update', callback),
  onCommand: (callback) => listen<PetCommand>('pet-command', callback),
  onLifecycle: (callback) => listen<Lifecycle>('lifecycle', callback)
};
contextBridge.exposeInMainWorld('desktop', bridge);
