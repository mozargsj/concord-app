// Remote-control protocol shared by the renderer (data channels) and the main process (session
// authority, input injection). Types + timing constants only — no imports, no behavior.
// Spec: Concord_Virtual_HID_Controle_Remoto.md. Roles: the CONTROLLER sends input, the CONTROLLED
// is the PC being driven and the only side that authorizes / revokes.

export type PresenceStatus = 'online' | 'busy' | 'unavailable' | 'offline';

export const RC_TIMING = {
  /** Pending request/offer lifetime before it expires on its own (expiring is not a refusal). */
  solicitationTimeoutMs: 15_000,
  /** Controller -> controlled liveness signal during an active session. */
  heartbeatIntervalMs: 1_000,
  /** No frame at all for this long on the controlled side = Input Reset + end of control. */
  heartbeatTimeoutMs: 3_000,
  /** Clipboard text cap (text only in the MVP, spec 34.1). */
  clipboardMaxChars: 100_000,
  clipboardPollMs: 500
} as const;

export interface RcPermissions {
  mouse: boolean;
  keyboard: boolean;
  clipboard: boolean;
  /** Send/receive files during the session — each file still needs the receiver's own OK. */
  files: boolean;
}

/** Fills a permissions object coming from the wire: a peer on an older build has no `files`. */
export function normalizePerms(value: unknown): RcPermissions | null {
  const p = value as Partial<RcPermissions> | null;
  if (!p || typeof p.mouse !== 'boolean' || typeof p.keyboard !== 'boolean' || typeof p.clipboard !== 'boolean') return null;
  return { mouse: p.mouse, keyboard: p.keyboard, clipboard: p.clipboard, files: p.files === true };
}

export const RC_FILES = {
  /** Per-file cap (spec 35, constant on purpose — a relay-routed link makes big files costly). */
  maxBytes: 2 * 1024 ** 3,
  /** Bytes of file data per data-channel message. */
  chunkBytes: 64 * 1024,
  /** Sender-side progress/UI refresh interval while chunks stream. */
  progressEveryBytes: 512 * 1024
} as const;

/** Frames on the dedicated 'files' data channel (JSON as text; file data as binary messages
 * prefixed with the 4-byte little-endian transfer id). Only valid inside a control session whose
 * permissions include `files`; the receiver confirms every file and chooses where it lands. */
export type FileFrame =
  | { t: 'offer'; sid: string; xid: number; name: string; size: number }
  | { t: 'accept'; sid: string; xid: number }
  | { t: 'reject'; sid: string; xid: number }
  | { t: 'done'; sid: string; xid: number; bytes: number }
  | { t: 'cancel'; sid: string; xid: number };

/** request = the controller asks to drive the other PC; offer = the PC owner invites a controller. */
export type SolicitationKind = 'request' | 'offer';

export type RejectReason = 'status' | 'em-sessao' | 'bloqueado' | 'cooldown' | 'sem-tela-inteira' | 'indisponivel';

/** Keyboard key id on the wire: hardware scan code, +0x100 when it is an extended (E0) key. */
export type KeyId = number;

/** Frames on the reliable+ordered 'control' data channel. */
export type ControlFrame =
  | { t: 'share'; fullScreen: boolean }
  | { t: 'req'; id: string; kind: SolicitationKind; perms: RcPermissions; sid?: string }
  | { t: 'res'; id: string; result: 'accepted'; sid: string; perms?: RcPermissions }
  | { t: 'res'; id: string; result: 'refused' }
  | { t: 'res'; id: string; result: 'rejected'; reason: RejectReason; retryInMs?: number }
  | { t: 'cancel'; id: string }
  | { t: 'end'; sid: string; reason: string }
  | { t: 'hb'; sid: string; keys: KeyId[]; buttons: number[] }
  | { t: 'key'; sid: string; seq: number; k: KeyId; down: boolean }
  | { t: 'btn'; sid: string; seq: number; b: number; down: boolean }
  | { t: 'wheel'; sid: string; seq: number; dx: number; dy: number }
  | { t: 'clip'; sid: string; text: string }
  /** Controller -> controlled, once at session start: functional capabilities of the controller's
   * real keyboard/mouse (deviceCaps.ts). Anonymous by construction. */
  | { t: 'caps'; sid: string; caps: unknown }
  /** Input diagnostics (opt-in, in-memory only): the controller asks the controlled PC to report what
   * arrived, and the controlled PC answers with batches of per-event outcomes. */
  | { t: 'diag'; sid: string; on: boolean }
  | { t: 'dack'; sid: string; items: DiagItem[] };

/** Frames on the unordered, no-retransmit 'input-move' channel — stale positions are useless. */
export interface MoveFrame {
  t: 'mv';
  sid: string;
  seq: number;
  /** 0..1 over the shared display's video frame. */
  x: number;
  y: number;
}

/** What the main process tells the renderer about the current session (either role). */
export interface RcSessionInfo {
  sid: string;
  role: 'controller' | 'controlled';
  peerId: string;
  peerUserId: string;
  peerName: string;
  perms: RcPermissions;
  /** The native low-level keyboard hook is running (system keys + the Ctrl+Shift+Pause exit
   * work). False = degraded: the controller falls back to DOM key events and the controlled PC
   * has no global emergency shortcut, only the indicator button. */
  keyHook: boolean;
}

export type DiagKind = 'key' | 'btn' | 'wheel' | 'mv';
/** What the controlled PC did with one input event: applied, refused by Windows, no permission,
 * replay/stale sequence, or blocked by the Ctrl+Alt+Del guard. */
export type DiagOutcome = 'ok' | 'fail' | 'perm' | 'seq' | 'guard';

/** One input event as seen on the controlled PC, for the diagnostics panel. */
export interface DiagItem {
  id: number;
  kind: DiagKind;
  /** Sequence number from the wire — the join key between "sent" (controller) and "arrived". */
  seq: number;
  /** key id (scan code, +0x100 extended) for keys, wire button id for buttons, 0 otherwise. */
  value: number;
  down: boolean;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  outcome: DiagOutcome;
}

/** Counters (never key contents) that show where a typed key stops: captured -> sent -> received ->
 * applied. Polled by the UI while a session is active. */
export interface RcDiag {
  role: 'controller' | 'controlled';
  /** Controller: the native keyboard hook runs / is currently swallowing keys for this session. */
  keyHook: boolean;
  swallowing: boolean;
  captureActive: boolean;
  windowFocused: boolean;
  /** Controller: key events the hook captured and handed to the renderer. */
  hookEvents: number;
  /** Controlled: key frames received, rejected (permission / replay) and applied or refused by Windows. */
  keyFramesIn: number;
  keyDropped: number;
  injected: number;
  injectFailed: number;
  elevated: boolean;
  /** Controller: why keyboard capture is on/off right now, and its last transitions (no key contents) —
   * the first thing to read when typing works "sometimes". */
  captureWhy: string;
  captureLog: Array<{ at: number; swallowing: boolean; why: string }>;
  /** Times the native hook was re-armed on a capture start (Windows can drop a slow low-level hook silently). */
  hookRearms: number;
}

export type RcEndReason = 'revoked' | 'share-stopped' | 'heartbeat' | 'peer-left' | 'user-exit' | 'error';

export interface RcBlockedUser {
  userId: string;
  displayName: string;
  permanent: boolean;
  retryInMs: number;
  refusals: number;
}

/** Verdict of the recipient's main process for an incoming request/offer. */
export type RcIncomingVerdict = { ok: true; id: string } | { ok: false; reason: RejectReason; retryInMs?: number };
