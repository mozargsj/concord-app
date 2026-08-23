import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('concord', {
  platform: process.platform,
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizedChange: (callback: (isMaximized: boolean) => void) => {
      const listener = (_event: unknown, isMaximized: boolean) => callback(isMaximized);
      ipcRenderer.on('window:maximized-change', listener);
      return () => ipcRenderer.removeListener('window:maximized-change', listener);
    }
  },
  media: {
    getScreenSources: () => ipcRenderer.invoke('screen:get-sources'),
    pickImage: () => ipcRenderer.invoke('media:pick-image')
  },
  auth: {
    loginWithGoogle: () => ipcRenderer.invoke('auth:login-with-google')
  },
  session: {
    save: (token: string) => ipcRenderer.invoke('session:save', token),
    load: () => ipcRenderer.invoke('session:load'),
    clear: () => ipcRenderer.invoke('session:clear')
  }
});
