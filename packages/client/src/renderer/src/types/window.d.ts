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

export interface PickedAudio {
  fileName: string;
  data: ArrayBuffer;
}

export interface SoundMeta {
  id: string;
  name: string;
  emoji: string;
  /** 0-1, fixed at save time — see decisions.md, this is one of the two soundboard volumes. */
  volume: number;
  durationMs: number;
  hash: string;
  mimeType: string;
}

export interface CachedSound extends SoundMeta {
  data: ArrayBuffer;
}

/** A sound downloaded from another peer but not yet confirmed into "meus áudios" — self-expires
 * after 7 days if never adopted (decisions.md, seção 3, soundboard). */
export interface TempSoundMeta {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  emoji: string;
  durationMs: number;
  hash: string;
  mimeType: string;
  downloadedAt: number;
}

export interface CachedTempSound extends TempSoundMeta {
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
        pickAudio: () => Promise<PickedAudio | null>;
      };
      imageCache: {
        save: (key: string, data: ArrayBuffer, mimeType: string) => Promise<boolean>;
        load: (key: string) => Promise<CachedImage | null>;
      };
      soundCache: {
        list: () => Promise<CachedSound[]>;
        loadBytes: (id: string) => Promise<{ mimeType: string; data: ArrayBuffer } | null>;
        save: (meta: SoundMeta, data: ArrayBuffer) => Promise<boolean>;
        updateMeta: (id: string, patch: Partial<Pick<SoundMeta, 'name' | 'emoji' | 'volume'>>) => Promise<boolean>;
        delete: (id: string) => Promise<boolean>;
      };
      soundTempCache: {
        list: () => Promise<CachedTempSound[]>;
        save: (meta: TempSoundMeta, data: ArrayBuffer) => Promise<boolean>;
        delete: (id: string) => Promise<boolean>;
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
