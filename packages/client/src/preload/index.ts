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
  imageCache: {
    save: (key: string, data: ArrayBuffer, mimeType: string) =>
      ipcRenderer.invoke('image-cache:save', key, data, mimeType),
    load: (key: string) => ipcRenderer.invoke('image-cache:load', key)
  },
  auth: {
    loginWithGoogle: () => ipcRenderer.invoke('auth:login-with-google')
  },
  session: {
    save: (token: string) => ipcRenderer.invoke('session:save', token),
    load: () => ipcRenderer.invoke('session:load'),
    clear: () => ipcRenderer.invoke('session:clear')
  },
  app: {
    onBeforeQuit: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('app:before-quit', listener);
      return () => ipcRenderer.removeListener('app:before-quit', listener);
    },
    onConfirmCloseRequest: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('app:confirm-close-request', listener);
      return () => ipcRenderer.removeListener('app:confirm-close-request', listener);
    },
    respondToCloseConfirmation: (confirmed: boolean) => {
      ipcRenderer.send('app:confirm-close-response', confirmed);
    },
    onUpdateStatus: (callback: (status: 'checking' | 'updating' | 'done') => void) => {
      const listener = (_event: unknown, status: 'checking' | 'updating' | 'done') => callback(status);
      ipcRenderer.on('app:update-status', listener);
      return () => ipcRenderer.removeListener('app:update-status', listener);
    }
  }
});
