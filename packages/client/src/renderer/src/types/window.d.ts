import type { ControllerCaps } from '../../../common/deviceCaps';
import type { DiagItem, DiagSystemInfo, RcDiag } from '../../../common/remoteControl';
import type {
  ControlFrame,
  FileFrame,
  MoveFrame,
  PresenceStatus,
  RcBlockedUser,
  RcEndReason,
  RcIncomingVerdict,
  RcPermissions,
  RcSessionInfo,
  RejectReason,
  SolicitationKind
} from '../../../common/remoteControl';

export interface ScreenSource {
  id: string;
  name: string;
  /** Display captured by a whole-screen source (desktopCapturer display_id); null for windows. */
  displayId: string | null;
  thumbnailDataUrl: string;
}

/** An app with an active audio session (native ListAudioSessions); Concord's own tree is never listed. */
export interface AudioSession {
  pid: number;
  name: string;
  /** Executable filename ("Spotify.exe") — stable across runs, unlike the pid. */
  exe: string;
  /** Parent, grandparent, ... (nearest first). */
  ancestors: number[];
}

export interface RcPeerRef {
  peerId: string;
  userId: string;
  name: string;
}

export interface RcState {
  session: RcSessionInfo | null;
  /** The native input addon loaded — without it this PC can't be controlled at all. */
  available: boolean;
  status: PresenceStatus;
  sharingFullScreen: boolean;
  /** Concord runs as administrator — only then can SendInput reach elevated windows. */
  elevated: boolean;
}

export type RcOutgoingVerdict = { ok: true; id: string; sid: string | null } | { ok: false; reason: RejectReason };

export interface PickedImage {
  fileName: string;
  mimeType: string;
  data: ArrayBuffer;
}

export interface GoogleLoginResult {
  email: string;
  displayName: string;
  avatarImageUrl?: string;
  idToken: string;
}

export type UpdateStatus = 'checking' | 'updating' | 'done';

// Sub-state of 'updating', shown as a dynamic message/progress bar instead of a static "sendo
// atualizado" text — 'percent' is only meaningful during 'downloading'.
export type UpdatePhase = 'checking' | 'available' | 'downloading' | 'installing';

export interface UpdateStatusInfo {
  status: UpdateStatus;
  phase?: UpdatePhase;
  percent?: number;
  version?: string;
}

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

export interface StoredDiceRoll {
  raw: string;
  count: number;
  sides: number;
  rolls: number[];
  operation: string;
  operand: number | null;
  modifier: number | null;
  total: number;
}

/** Shape saved to/loaded from the encrypted per-room chat file (decisions.md — bot de dados/chat
 * de texto) — structurally the same as webrtcMesh.ts's ChatMessage, redeclared here since preload
 * can't import renderer-only modules (same reasoning as CachedSound/SoundMeta above). */
export interface StoredChatMessage {
  id: string;
  userId: string;
  displayName: string;
  text: string;
  sentAt: number;
  roll: StoredDiceRoll | null;
}

declare global {
  interface Window {
    concord: {
      platform: string;
      windowControls: {
        minimize: () => void;
        maximizeToggle: () => void;
        close: () => void;
        dragStart: (screenX: number, screenY: number) => void;
        dragMove: (screenX: number, screenY: number) => void;
        dragEnd: () => void;
        onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
      };
      media: {
        getScreenSources: () => Promise<ScreenSource[]>;
        pickImage: () => Promise<PickedImage | null>;
        pickAudio: () => Promise<PickedAudio | null>;
      };
      processLoopback: {
        start: (sessionId: string, mode: 'exclude' | 'include', targetPid: number) => Promise<boolean>;
        stop: (sessionId: string) => void;
        isAvailable: () => Promise<boolean>;
        listAudioSessions: () => Promise<AudioSession[]>;
        onChunk: (sessionId: string, callback: (chunk: Uint8Array) => void) => () => void;
        onStopped: (sessionId: string, callback: () => void) => () => void;
      };
      smartAppControl: {
        isActive: () => Promise<boolean>;
      };
      remoteControl: {
        getState: () => Promise<RcState>;
        setStatus: (status: PresenceStatus) => Promise<void>;
        setShare: (displayId: string | null) => Promise<void>;
        beginOutgoing: (kind: SolicitationKind, peer: RcPeerRef, perms: RcPermissions) => Promise<RcOutgoingVerdict>;
        incoming: (kind: SolicitationKind, peer: RcPeerRef, perms: RcPermissions, sid?: string) => Promise<RcIncomingVerdict>;
        respond: (id: string, accept: boolean) => Promise<{ ok: boolean; session?: RcSessionInfo }>;
        outgoingResult: (
          id: string,
          result: 'accepted' | 'refused' | 'rejected' | 'cancelled',
          sid?: string
        ) => Promise<{ ok: boolean; session?: RcSessionInfo }>;
        cancelPending: (id: string) => Promise<void>;
        end: (reason: RcEndReason) => Promise<void>;
        peerEnded: (sid: string) => Promise<void>;
        setCapture: (active: boolean) => Promise<void>;
        getLocalCaps: () => Promise<ControllerCaps | null>;
        getDiag: () => Promise<RcDiag | null>;
        diagEnable: (on: boolean) => Promise<void>;
        diagSystem: () => Promise<DiagSystemInfo>;
        diagSave: (text: string, role: string) => Promise<{ ok: boolean; path?: string }>;
        diagItems: (afterId: number) => Promise<DiagItem[]>;
        sendInput: (peerId: string, frame: ControlFrame) => void;
        sendMove: (peerId: string, frame: MoveFrame) => void;
        clipboardRemote: (peerId: string, sid: string, text: string) => void;
        files: {
          pick: () => Promise<{ xid: number; name: string; size: number } | { error: string } | null>;
          incoming: (
            peerId: string,
            frame: FileFrame
          ) => Promise<{ ok: true; name: string; size: number; risky: boolean } | { ok: false; reason: string }>;
          accept: (xid: number, accept: boolean) => Promise<{ ok: boolean }>;
          read: (xid: number) => Promise<Uint8Array | null>;
          write: (peerId: string, xid: number, data: Uint8Array) => void;
          finish: (peerId: string, xid: number) => Promise<{ ok: boolean; name?: string; folder?: string }>;
          abort: (xid: number) => Promise<void>;
        };
        listBlocked: () => Promise<RcBlockedUser[]>;
        unblock: (userId: string) => Promise<boolean>;
        on: {
          (event: 'ended', callback: (payload: { sid: string; role: 'controller' | 'controlled'; reason: RcEndReason; notifyPeer: boolean }) => void): () => void;
          (event: 'pending-expired' | 'pending-cancelled', callback: (payload: { id: string }) => void): () => void;
          (event: 'hook-key', callback: (payload: { keyId: number; down: boolean }) => void): () => void;
          (event: 'clipboard-local', callback: (payload: { sid: string; text: string }) => void): () => void;
          (event: 'files-expired', callback: (payload: { xid: number }) => void): () => void;
          (event: 'caps-result', callback: (payload: { warnings: string[] }) => void): () => void;
        };
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
      chatHistory: {
        save: (roomId: string, messages: StoredChatMessage[]) => Promise<void>;
        load: (roomId: string) => Promise<StoredChatMessage[]>;
        clear: (roomId: string) => Promise<void>;
      };
      app: {
        onBeforeQuit: (callback: () => void) => () => void;
        onConfirmCloseRequest: (callback: () => void) => () => void;
        respondToCloseConfirmation: (confirmed: boolean) => void;
        onUpdateStatus: (callback: (info: UpdateStatusInfo) => void) => () => void;
        startUpdate: () => Promise<void>;
      };
    };
  }
}
