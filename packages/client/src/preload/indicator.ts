import { contextBridge, ipcRenderer } from 'electron';

// Preload for the small always-on-top "remote control active" window (main/controlIndicator.ts).
// It can do exactly one thing: ask the main process to stop the control session.
contextBridge.exposeInMainWorld('concordIndicator', {
  stop: () => ipcRenderer.send('rc-indicator:stop')
});
