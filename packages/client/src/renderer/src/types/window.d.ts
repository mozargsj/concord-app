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
      };
    };
  }
}
