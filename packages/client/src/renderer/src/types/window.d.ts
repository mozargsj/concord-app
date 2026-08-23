export {};

export interface ScreenSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
}

export interface PickedImage {
  fileName: string;
  mimeType: string;
  data: ArrayBuffer;
}

export interface GoogleLoginResult {
  email: string;
  displayName: string;
  avatarImageUrl?: string;
}

export type UpdateStatus = 'checking' | 'updating' | 'done';

export interface CachedImage {
  mimeType: string;
  data: ArrayBuffer;
}

declare global {
  interface Window {
    concord: {
      platform: string;
      windowControls: {
        minimize: () => void;
        maximizeToggle: () => void;
        close: () => void;
        onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
      };
      media: {
        getScreenSources: () => Promise<ScreenSource[]>;
        pickImage: () => Promise<PickedImage | null>;
      };
      imageCache: {
        save: (key: string, data: ArrayBuffer, mimeType: string) => Promise<boolean>;
        load: (key: string) => Promise<CachedImage | null>;
      };
      auth: {
        loginWithGoogle: () => Promise<GoogleLoginResult>;
      };
      session: {
        save: (token: string) => Promise<void>;
        load: () => Promise<string | null>;
        clear: () => Promise<void>;
      };
      app: {
        onBeforeQuit: (callback: () => void) => () => void;
        onConfirmCloseRequest: (callback: () => void) => () => void;
        respondToCloseConfirmation: (confirmed: boolean) => void;
        onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
      };
    };
  }
}
