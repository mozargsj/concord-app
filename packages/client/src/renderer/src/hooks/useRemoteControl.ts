import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  RC_TIMING,
  normalizePerms,
  type ControlFrame,
  type DiagItem,
  type DiagKind,
  type DiagOutcome,
  type FileFrame,
  type MoveFrame,
  type RcDiag,
  type RcEndReason,
  type RcPermissions,
  type RcSessionInfo,
  type RejectReason,
  type SolicitationKind
} from '../../../common/remoteControl';
import type { ControlHandlers, RoomPeer } from './useRoomConnection';
import { useFileTransfer } from './useFileTransfer';
import { negotiateCaps } from '../../../common/deviceCaps';
import { formatDiagReport, type ReportRow } from '../../../common/diagReport';
import { describeKey } from '../../../common/keyScan';

// Renderer side of remote control (spec sections 13-17). It owns the two data channels' traffic
// and the UI state; every DECISION (status, one session at a time, cooldown, permissions, session
// id / sequence numbers, Input Reset) lives in the main process (main/remoteControl.ts). Frames
// from a peer are only relayed there, never acted on here.

interface Incoming {
  /** Main-process pending id (local). */
  id: string;
  /** Sender's solicitation id — what `res`/`cancel` frames carry on the wire. */
  wireId: string;
  peerId: string;
  name: string;
  kind: SolicitationKind;
  perms: RcPermissions;
}

interface Outgoing {
  /** Same id on both ends: minted by this side's main process and carried in the `req` frame. */
  id: string;
  peerId: string;
  name: string;
  kind: SolicitationKind;
  perms: RcPermissions;
}

/** One input event as the CONTROLLER sent it, joined with the controlled PC's confirmation. */
export interface DiagRow {
  kind: DiagKind;
  seq: number;
  value: number;
  down: boolean;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  sentAt: number;
  /** 'pending' until the controlled PC reports back. */
  outcome: DiagOutcome | 'pending';
  detail?: string;
}

export interface RcDialog {
  kind: SolicitationKind;
  peerId: string;
}

interface Args {
  peers: RoomPeer[];
  selfPeerId: string | null;
  controlHandlersRef: MutableRefObject<ControlHandlers>;
  sendControlFrame: (peerId: string, frame: ControlFrame) => boolean;
  sendMoveFrame: (peerId: string, frame: MoveFrame) => void;
  sendFileFrame: (peerId: string, frame: FileFrame) => boolean;
  sendFileChunk: (peerId: string, chunk: ArrayBuffer) => Promise<boolean>;
  /** True while THIS user shares a whole screen (not a window) — the only case control exists. */
  sharingFullScreen: boolean;
}

const NOTICE_MS = 5000;

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

const REJECT_TEXT: Record<RejectReason, (name: string, retryInMs?: number) => string> = {
  status: (name) => `${name} não está disponível para controle agora.`,
  'em-sessao': (name) => `${name} já está em uma sessão de controle.`,
  bloqueado: (name) => `${name} não está aceitando novos pedidos seus.`,
  cooldown: (name, ms) => `${name} recusou recentemente. Tente de novo em ${formatWait(ms ?? 0)}.`,
  'sem-tela-inteira': () => 'O controle só funciona com transmissão de tela inteira (não de um aplicativo).',
  indisponivel: (name) => `O controle remoto não está disponível para ${name}.`
};

function endText(reason: RcEndReason, peerName: string, notifyPeer: boolean): string {
  switch (reason) {
    case 'heartbeat':
      return 'Controle encerrado: sem sinal do outro computador.';
    case 'share-stopped':
      return 'Controle encerrado: a transmissão de tela foi interrompida.';
    case 'peer-left':
      return `Controle encerrado: ${peerName} saiu.`;
    case 'error':
      return 'Controle encerrado por um erro.';
    default:
      return notifyPeer ? 'Controle encerrado.' : `Controle encerrado por ${peerName}.`;
  }
}

export function useRemoteControl({
  peers,
  selfPeerId,
  controlHandlersRef,
  sendControlFrame,
  sendMoveFrame,
  sendFileFrame,
  sendFileChunk,
  sharingFullScreen
}: Args) {
  const [available, setAvailable] = useState(false);
  const [session, setSession] = useState<RcSessionInfo | null>(null);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [dialog, setDialog] = useState<RcDialog | null>(null);
  const [notice, setNotice] = useState<{ text: string; nonce: number } | null>(null);
  // Whether each peer currently shares a whole screen (they announce it on the control channel).
  const [peerFullScreen, setPeerFullScreen] = useState<Record<string, boolean>>({});
  // userId -> end of the refusal cooldown that peer told us about (UI hint only — the recipient's
  // main process is the real gate).
  const [cooldownUntil, setCooldownUntil] = useState<Record<string, number>>({});
  // Counters showing where a typed key stops (captured/sent/received/applied) — polled while a session lives.
  const [diag, setDiag] = useState<RcDiag | null>(null);
  // Opt-in input diagnostics (off by default, memory only, never logged): what the controller sent
  // vs what the controlled PC received and did with it. See RemoteControlDiagPanel.
  const [diagOn, setDiagOn] = useState(false);
  const [diagSent, setDiagSent] = useState<DiagRow[]>([]);
  const [diagRecv, setDiagRecv] = useState<DiagItem[]>([]);
  const [ackFlag, setAckFlag] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ peerId: string; nonce: number } | null>(null);

  // Everything the long-lived IPC/channel callbacks need, always current.
  const live = useRef({ peers, session, incoming, outgoing, sharingFullScreen, sendControlFrame, sendMoveFrame });
  live.current = { peers, session, incoming, outgoing, sharingFullScreen, sendControlFrame, sendMoveFrame };

  const seq = useRef({ key: 0, btn: 0, wheel: 0, mv: 0 });
  const pressedKeys = useRef(new Set<number>());
  const pressedButtons = useRef(new Set<number>());
  // Last time ANY frame arrived from the session peer — the controller's own liveness check (the
  // controlled PC acknowledges every heartbeat), since the controller has no other way to notice
  // the other side vanished while its keyboard is being swallowed.
  const lastPeerFrameAt = useRef(0);
  const diagOnRef = useRef(false);
  const diagSentRef = useRef<DiagRow[]>([]);
  const diagRecvRef = useRef<DiagItem[]>([]);
  const sessionStartedAt = useRef<number | null>(null);
  const ackWanted = useRef(false);
  const lastMoveLogged = useRef(0);

  const showNotice = useCallback((text: string) => setNotice({ text, nonce: Date.now() }), []);
  const files = useFileTransfer({ session, sendFileFrame, sendFileChunk, showNotice });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    void window.concord.remoteControl.getState().then((state) => setAvailable(state.available));
  }, []);

  function beginSession(info: RcSessionInfo): void {
    seq.current = { key: 0, btn: 0, wheel: 0, mv: 0 };
    pressedKeys.current.clear();
    pressedButtons.current.clear();
    lastPeerFrameAt.current = Date.now();
    setSession(info);
    sessionStartedAt.current = Date.now();
    diagOnRef.current = false;
    ackWanted.current = false;
    setDiagOn(false);
    setAckFlag(false);
    setDiagSent([]);
    setDiagRecv([]);
    if (info.role === 'controlled') {
      void window.concord.remoteControl.getState().then((state) => {
        if (!state.elevated) {
          showNotice('O Concord não está como administrador: janelas elevadas (Gerenciador de Tarefas, apps como administrador) não recebem o controle.');
        }
      });
    }
    if (info.role === 'controller') {
      setFocusRequest({ peerId: info.peerId, nonce: Date.now() });
      // Hand the controlled PC the functional capabilities of my real keyboard/mouse so it can validate
      // them against its virtual devices (anonymous: counts and flags, never VID/PID or names).
      void window.concord.remoteControl.getLocalCaps().then((caps) => {
        if (!caps) return;
        live.current.sendControlFrame(info.peerId, { t: 'caps', sid: info.sid, caps });
        const { warnings } = negotiateCaps(caps); // same pure check the controlled PC runs
        if (warnings.length > 0) showNotice(warnings.join(' '));
      });
    }
    showNotice(
      info.role === 'controller'
        ? `Você está controlando o PC de ${info.peerName}. Ctrl+Shift+Pause para sair.`
        : `${info.peerName} está controlando o seu PC.`
    );
  }

  // ---- frames from peers ---------------------------------------------------------------------

  const handleFrame = useCallback(
    async (peerId: string, frame: ControlFrame) => {
      const { peers: currentPeers, outgoing: out, incoming: inc } = live.current;
      const api = window.concord.remoteControl;
      const peer = currentPeers.find((p) => p.peerId === peerId);
      if (!peer) return;
      const send = (f: ControlFrame) => live.current.sendControlFrame(peerId, f);
      const activeSession = live.current.session;
      if (activeSession && activeSession.peerId === peerId) lastPeerFrameAt.current = Date.now();

      // Diagnostics frames never reach the main process.
      if (frame.t === 'diag') {
        if (activeSession?.role === 'controlled' && frame.sid === activeSession.sid) {
          ackWanted.current = !!frame.on;
          setAckFlag(!!frame.on);
          void api.diagEnable(!!frame.on || diagOnRef.current);
        }
        return;
      }
      if (frame.t === 'dack') {
        if (activeSession?.role === 'controller' && frame.sid === activeSession.sid && Array.isArray(frame.items)) {
          setDiagSent((prev) =>
            prev.map((row) => {
              if (row.outcome !== 'pending') return row;
              // Pointer moves are sampled independently on each side (1 per 100 ms), so an ack for move
              // N also answers every earlier move the controller logged; everything else matches exactly.
              const ack =
                row.kind === 'mv'
                  ? frame.items.filter((item) => item.kind === 'mv' && item.seq >= row.seq).sort((a, b) => a.seq - b.seq)[0]
                  : frame.items.find((item) => item.kind === row.kind && item.seq === row.seq);
              return ack ? { ...row, outcome: ack.outcome, detail: ack.detail } : row;
            })
          );
        }
        return;
      }

      if (frame.t === 'hb' && activeSession) {
        // Controlled: acknowledge so the controller can tell this PC is still there, then let the
        // main process reconcile held keys. Controller: the ack itself is all there is to it.
        if (activeSession.role === 'controlled' && frame.sid === activeSession.sid) {
          send({ t: 'hb', sid: frame.sid, keys: [], buttons: [] });
          api.sendInput(peerId, frame);
        }
        return;
      }

      switch (frame.t) {
        case 'share':
          setPeerFullScreen((prev) => ({ ...prev, [peerId]: !!frame.fullScreen }));
          break;

        case 'req': {
          const perms = normalizePerms(frame.perms);
          if ((frame.kind !== 'request' && frame.kind !== 'offer') || typeof frame.id !== 'string' || !perms) return;
          // userId comes from the server-verified roster, never from the frame.
          const verdict = await api.incoming(frame.kind, { peerId, userId: peer.userId, name: peer.displayName }, perms, frame.sid);
          if (!verdict.ok) {
            send({ t: 'res', id: frame.id, result: 'rejected', reason: verdict.reason, retryInMs: verdict.retryInMs });
            return;
          }
          setIncoming({ id: verdict.id, wireId: frame.id, peerId, name: peer.displayName, kind: frame.kind, perms });
          break;
        }

        case 'res': {
          if (!out || out.id !== frame.id || out.peerId !== peerId) return;
          setOutgoing(null);
          if (frame.result === 'accepted') {
            const result = await api.outgoingResult(out.id, 'accepted', frame.sid);
            if (result.ok && result.session) beginSession(result.session);
            else showNotice('Não foi possível iniciar o controle.');
          } else if (frame.result === 'refused') {
            await api.outgoingResult(out.id, 'refused');
            showNotice(`${out.name} recusou.`);
          } else {
            await api.outgoingResult(out.id, 'rejected');
            if (frame.reason === 'cooldown' && frame.retryInMs) {
              setCooldownUntil((prev) => ({ ...prev, [peer.userId]: Date.now() + frame.retryInMs! }));
            }
            showNotice((REJECT_TEXT[frame.reason] ?? REJECT_TEXT.indisponivel)(out.name, frame.retryInMs));
          }
          break;
        }

        case 'cancel':
          if (inc && inc.wireId === frame.id && inc.peerId === peerId) {
            setIncoming(null);
            void api.cancelPending(inc.id);
          }
          break;

        case 'end':
          void api.peerEnded(frame.sid);
          break;

        case 'clip':
          if (typeof frame.text === 'string') api.clipboardRemote(peerId, frame.sid, frame.text);
          break;

        default:
          // hb / key / btn / wheel — straight to the main process, which validates session,
          // sequence numbers and permissions before injecting anything.
          api.sendInput(peerId, frame);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state through `live`
    []
  );

  useEffect(() => {
    controlHandlersRef.current = {
      onFrame: (peerId, frame) => void handleFrame(peerId, frame),
      onMove: (peerId, frame) => window.concord.remoteControl.sendMove(peerId, frame),
      onOpen: (peerId) => {
        live.current.sendControlFrame(peerId, { t: 'share', fullScreen: live.current.sharingFullScreen });
      },
      onClose: (peerId) => {
        if (live.current.session?.peerId === peerId) void window.concord.remoteControl.end('peer-left');
      },
      onFileFrame: (peerId, frame) => void files.handleFrame(peerId, frame),
      onFileChunk: (peerId, chunk) => files.handleChunk(peerId, chunk)
    };
  });

  // Tell every peer when my whole-screen sharing starts/stops.
  useEffect(() => {
    for (const peer of peers) sendControlFrame(peer.peerId, { t: 'share', fullScreen: sharingFullScreen });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a real change of the flag should re-announce
  }, [sharingFullScreen]);

  // ---- events from the main process ----------------------------------------------------------

  useEffect(() => {
    const api = window.concord.remoteControl;
    const offEnded = api.on('ended', ({ sid, reason, notifyPeer }) => {
      const s = live.current.session;
      if (!s || s.sid !== sid) return;
      if (notifyPeer) live.current.sendControlFrame(s.peerId, { t: 'end', sid, reason });
      pressedKeys.current.clear();
      pressedButtons.current.clear();
      setSession(null);
      diagOnRef.current = false;
      ackWanted.current = false;
      setDiagOn(false);
      setAckFlag(false);
      setDiagSent([]);
      setDiagRecv([]);
      void api.setCapture(false);
      showNotice(endText(reason, s.peerName, notifyPeer));
    });
    const offExpired = api.on('pending-expired', ({ id }) => {
      const { outgoing: out, incoming: inc } = live.current;
      if (out?.id === id) {
        live.current.sendControlFrame(out.peerId, { t: 'cancel', id });
        setOutgoing(null);
        showNotice(`${out.name} não respondeu.`);
      }
      if (inc?.id === id) setIncoming(null); // expiring is never a refusal
    });
    const offCancelled = api.on('pending-cancelled', ({ id }) => {
      const { outgoing: out, incoming: inc } = live.current;
      if (out?.id === id) {
        live.current.sendControlFrame(out.peerId, { t: 'cancel', id });
        setOutgoing(null);
      }
      if (inc?.id === id) setIncoming(null);
    });
    const offCaps = api.on('caps-result', ({ warnings }) => {
      if (warnings.length > 0) showNotice(`Controlador: ${warnings.join(' ')}`);
    });
    const offKey = api.on('hook-key', ({ keyId, down }) => controllerKey(keyId, down));
    const offClip = api.on('clipboard-local', ({ sid, text }) => {
      const s = live.current.session;
      if (s && s.sid === sid) live.current.sendControlFrame(s.peerId, { t: 'clip', sid, text });
    });
    return () => {
      offEnded();
      offExpired();
      offCancelled();
      offKey();
      offCaps();
      offClip();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribes once, reads live state through `live`
  }, []);

  // Peers that vanish take their session / pending solicitations with them.
  useEffect(() => {
    const { session: s, outgoing: out, incoming: inc } = live.current;
    const present = (peerId: string) => peers.some((p) => p.peerId === peerId);
    if (s && !present(s.peerId)) void window.concord.remoteControl.end('peer-left');
    if (out && !present(out.peerId)) {
      void window.concord.remoteControl.cancelPending(out.id);
      setOutgoing(null);
    }
    if (inc && !present(inc.peerId)) {
      void window.concord.remoteControl.cancelPending(inc.id);
      setIncoming(null);
    }
    setPeerFullScreen((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([peerId]) => present(peerId)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [peers]);

  useEffect(() => {
    if (selfPeerId === null && live.current.session) void window.concord.remoteControl.end('peer-left');
  }, [selfPeerId]);

  diagSentRef.current = diagSent;
  diagRecvRef.current = diagRecv;
  const hasSession = !!session;
  useEffect(() => {
    if (!hasSession) {
      setDiag(null);
      return;
    }
    let cancelled = false;
    const poll = () =>
      void window.concord.remoteControl.getDiag().then((value) => {
        if (!cancelled) setDiag(value);
      });
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasSession]);

  // Controlled side, diagnostics on (locally, or because the controller asked): read what main
  // recorded (what arrived + what Windows did with it), show it, and answer the controller.
  const controlledSid = session?.role === 'controlled' ? session.sid : null;
  const controlledPeer = session?.role === 'controlled' ? session.peerId : null;
  useEffect(() => {
    if (!controlledSid || !controlledPeer || !(diagOn || ackFlag)) return;
    let last = 0;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void window.concord.remoteControl
        .diagItems(last)
        .then((items) => {
          if (items.length === 0) return;
          last = items[items.length - 1].id;
          setDiagRecv((prev) => [...prev, ...items].slice(-500));
          if (ackWanted.current) live.current.sendControlFrame(controlledPeer, { t: 'dack', sid: controlledSid, items: items.slice(-40) });
        })
        .finally(() => {
          busy = false;
        });
    }, 300);
    return () => clearInterval(timer);
  }, [controlledSid, controlledPeer, diagOn, ackFlag]);

  // ---- controller: heartbeat + input ---------------------------------------------------------

  const sid = session?.sid;
  const controllerPeerId = session?.role === 'controller' ? session.peerId : null;
  useEffect(() => {
    if (!sid || !controllerPeerId) return;
    const beat = () =>
      live.current.sendControlFrame(controllerPeerId, {
        t: 'hb',
        sid,
        keys: [...pressedKeys.current],
        buttons: [...pressedButtons.current]
      });
    beat();
    const timer = setInterval(() => {
      // The controlled PC acknowledges every heartbeat: silence means it (or the link) is gone,
      // and the keyboard must be given back instead of staying swallowed.
      if (Date.now() - lastPeerFrameAt.current > RC_TIMING.heartbeatTimeoutMs + RC_TIMING.heartbeatIntervalMs) {
        void window.concord.remoteControl.end('heartbeat');
        return;
      }
      beat();
    }, RC_TIMING.heartbeatIntervalMs);
    return () => clearInterval(timer);
  }, [sid, controllerPeerId]);

  function activeController(): RcSessionInfo | null {
    const s = live.current.session;
    return s && s.role === 'controller' ? s : null;
  }

  /** Records what the controller just sent (diagnostics only; moves are sampled). */
  function logSent(row: Omit<DiagRow, 'sentAt' | 'outcome'>): void {
    if (!diagOnRef.current) return;
    if (row.kind === 'mv') {
      const now = Date.now();
      if (now - lastMoveLogged.current < 100) return;
      lastMoveLogged.current = now;
    }
    setDiagSent((prev) => [...prev.slice(-499), { ...row, sentAt: Date.now(), outcome: 'pending' }]);
  }

  function controllerKey(keyId: number, down: boolean): void {
    const s = activeController();
    if (!s || !s.perms.keyboard) return;
    if (down) pressedKeys.current.add(keyId);
    else pressedKeys.current.delete(keyId);
    const n = ++seq.current.key;
    logSent({ kind: 'key', seq: n, value: keyId, down });
    live.current.sendControlFrame(s.peerId, { t: 'key', sid: s.sid, seq: n, k: keyId, down });
  }

  const controller = {
    sendKey: controllerKey,
    sendButton(button: number, down: boolean): void {
      const s = activeController();
      if (!s || !s.perms.mouse) return;
      if (down) pressedButtons.current.add(button);
      else pressedButtons.current.delete(button);
      const n = ++seq.current.btn;
      logSent({ kind: 'btn', seq: n, value: button, down });
      live.current.sendControlFrame(s.peerId, { t: 'btn', sid: s.sid, seq: n, b: button, down });
    },
    sendWheel(dx: number, dy: number): void {
      const s = activeController();
      if (!s || !s.perms.mouse) return;
      const n = ++seq.current.wheel;
      logSent({ kind: 'wheel', seq: n, value: 0, down: false, dx, dy });
      live.current.sendControlFrame(s.peerId, { t: 'wheel', sid: s.sid, seq: n, dx, dy });
    },
    /** Sends "up" for everything currently held (focus left the view, window blur...). */
    releaseAll(): void {
      for (const key of [...pressedKeys.current]) controllerKey(key, false);
      for (const button of [...pressedButtons.current]) controller.sendButton(button, false);
    },
    sendMove(x: number, y: number): void {
      const s = activeController();
      if (!s || !s.perms.mouse) return;
      const n = ++seq.current.mv;
      logSent({ kind: 'mv', seq: n, value: 0, down: false, x, y });
      live.current.sendMoveFrame(s.peerId, { t: 'mv', sid: s.sid, seq: n, x, y });
    }
  };

  // ---- user actions --------------------------------------------------------------------------

  async function startSolicitation(kind: SolicitationKind, peerId: string, perms: RcPermissions): Promise<void> {
    const peer = live.current.peers.find((p) => p.peerId === peerId);
    if (!peer) return;
    const verdict = await window.concord.remoteControl.beginOutgoing(kind, { peerId, userId: peer.userId, name: peer.displayName }, perms);
    if (!verdict.ok) {
      showNotice(REJECT_TEXT[verdict.reason](peer.displayName));
      return;
    }
    setOutgoing({ id: verdict.id, peerId, name: peer.displayName, kind, perms });
    const sent = live.current.sendControlFrame(peerId, { t: 'req', id: verdict.id, kind, perms, ...(verdict.sid ? { sid: verdict.sid } : {}) });
    if (!sent) {
      void window.concord.remoteControl.cancelPending(verdict.id);
      setOutgoing(null);
      showNotice('Não foi possível enviar o pedido: conexão com o participante indisponível.');
    }
  }

  return {
    available,
    session,
    incoming,
    outgoing,
    dialog,
    notice,
    peerFullScreen,
    cooldownUntil,
    focusRequest,
    diag,
    diagOn,
    diagSent,
    diagRecv,
    /** Builds the plain-text diagnostics report and lets the user save it (local file, nothing sent). */
    async saveDiagReport(): Promise<void> {
      const s = live.current.session;
      if (!s) return;
      const api = window.concord.remoteControl;
      const [system, latest] = await Promise.all([api.diagSystem(), api.getDiag()]);
      const rows: ReportRow[] =
        s.role === 'controller'
          ? diagSentRef.current.map((row) => ({ ...row, at: row.sentAt }))
          : diagRecvRef.current.map((item) => ({ ...item }));
      const text = formatDiagReport(
        { generatedAt: Date.now(), role: s.role, perms: s.perms, keyHook: s.keyHook, sessionStartedAt: sessionStartedAt.current, diag: latest, system, rows },
        describeKey
      );
      const result = await api.diagSave(text, s.role);
      showNotice(result.ok ? `Relatório salvo em ${result.path}` : 'Relatório não salvo.');
    },
    /** Turns the opt-in input diagnostics on/off for this side of the session. */
    toggleDiag(on: boolean): void {
      diagOnRef.current = on;
      setDiagOn(on);
      const s = live.current.session;
      if (!s) return;
      if (s.role === 'controller') {
        live.current.sendControlFrame(s.peerId, { t: 'diag', sid: s.sid, on });
        if (!on) setDiagSent([]);
      } else {
        void window.concord.remoteControl.diagEnable(on || ackWanted.current);
        if (!on) setDiagRecv([]);
      }
    },
    files,
    controller,
    openDialog: (kind: SolicitationKind, peerId: string) => setDialog({ kind, peerId }),
    closeDialog: () => setDialog(null),
    submitDialog(perms: RcPermissions): void {
      const d = dialog;
      setDialog(null);
      if (d) void startSolicitation(d.kind, d.peerId, perms);
    },
    async respondIncoming(accept: boolean): Promise<void> {
      const inc = live.current.incoming;
      if (!inc) return;
      setIncoming(null);
      const result = await window.concord.remoteControl.respond(inc.id, accept);
      const send = (frame: ControlFrame) => live.current.sendControlFrame(inc.peerId, frame);
      if (!accept) {
        send({ t: 'res', id: inc.wireId, result: 'refused' });
        return;
      }
      if (result.ok && result.session) {
        send({ t: 'res', id: inc.wireId, result: 'accepted', sid: result.session.sid });
        beginSession(result.session);
      } else {
        send({ t: 'res', id: inc.wireId, result: 'rejected', reason: 'indisponivel' });
        showNotice('Não foi possível iniciar o controle.');
      }
    },
    cancelOutgoing(): void {
      const out = live.current.outgoing;
      if (!out) return;
      setOutgoing(null);
      void window.concord.remoteControl.cancelPending(out.id);
      live.current.sendControlFrame(out.peerId, { t: 'cancel', id: out.id });
    },
    stopControl: () => void window.concord.remoteControl.end('user-exit'),
    setCapture: (active: boolean) => void window.concord.remoteControl.setCapture(active)
  };
}

export type RemoteControlApi = ReturnType<typeof useRemoteControl>;
