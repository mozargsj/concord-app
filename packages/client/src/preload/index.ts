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
    pickImage: () => ipcRenderer.invoke('media:pick-image'),
    pickAudio: () => ipcRenderer.invoke('media:pick-audio')
  },
  imageCache: {
    save: (key: string, data: ArrayBuffer, mimeType: string) =>
      ipcRenderer.invoke('image-cache:save', key, data, mimeType),
    load: (key: string) => ipcRenderer.invoke('image-cache:load', key)
  },
  soundCache: {
    list: () => ipcRenderer.invoke('sound-cache:list'),
    loadBytes: (id: string) => ipcRenderer.invoke('sound-cache:load-bytes', id),
    save: (meta: unknown, data: ArrayBuffer) => ipcRenderer.invoke('sound-cache:save', meta, data),
    updateMeta: (id: string, patch: unknown) => ipcRenderer.invoke('sound-cache:update-meta', id, patch),
    delete: (id: string) => ipcRenderer.invoke('sound-cache:delete', id)
  },
  soundTempCache: {
    list: () => ipcRenderer.invoke('sound-temp-cache:list'),
    save: (meta: unknown, data: ArrayBuffer) => ipcRenderer.invoke('sound-temp-cache:save', meta, data),
    delete: (id: string) => ipcRenderer.invoke('sound-temp-cache:delete', id)
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
    onUpdateStatus: (
      callback: (info: {
        status: 'checking' | 'updating' | 'done';
        phase?: 'checking' | 'available' | 'downloading' | 'installing';
        percent?: number;
        version?: string;
      }) => void
    ) => {
      const listener = (_event: unknown, info: Parameters<typeof callback>[0]) => callback(info);
      ipcRenderer.on('app:update-status', listener);
      return () => ipcRenderer.removeListener('app:update-status', listener);
    }
  }
});
